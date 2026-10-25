/*
 * SF Agents' screen mirroring helper: one stream of this computer's screen.
 *
 * Derived from MoonlightWeb's stream worker (backend/src/streaming/worker/
 * StreamWorkerMain.cpp, https://github.com/linckosz/moonlight-web).
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 * Changes for SF Agents: only the native host (this computer) is streamed;
 * the GameStream, Wolf and MultiSeat backends, the guests' shared feed, the
 * co-op lobby, the wheels kept between streams and the launcher service are
 * gone; main() and the probe and virtual display helper modes are here.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include <QCoreApplication>

#include "streaming/Session.h"
#include "streaming/InputMessageCodec.h"
#include "server/AppSettings.h"
#include "mw/native/NativeHost.h"
#include "backend/streambackend/NativeHostBackend.h"
#include "backend/streambackend/NativeProbeService.h"
#include "backend/VirtualDisplayApply.h"
#include "streaming/DataChannelRelay.h"
#include "streaming/NativeMediaEngine.h"
#include "streaming/MediaTrackRelay.h"
#include "streaming/StreamRelay.h"
#include "streaming/SignalingServer.h"
#include "streaming/IMediaEngine.h"
#include "backend/NvComputer.h"
#include "backend/NvHTTP.h"
#include "common/Logger.h"
#include "common/Types.h"
#include "common/RunFlags.h"

#include <QCommandLineParser>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QNetworkAccessManager>
#include <QPointer>
#include <QTimer>
#include <QDebug>

#include <chrono>
#include <cstdio>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

#if defined(__linux__)
#include <cerrno>
#include <unistd.h>
#endif

namespace {

/// Write one protocol event line on stdout (the only stdout writer in worker
/// mode — all logging goes to the log file / stderr).
void emitEvent(const QJsonObject& event)
{
    const QByteArray line = QJsonDocument(event).toJson(QJsonDocument::Compact) + "\n";
    std::fwrite(line.constData(), 1, static_cast<size_t>(line.size()), stdout);
    std::fflush(stdout);
}

/// One line from the server on stdin, without its newline; false at the end.
///
/// Not std::getline on std::cin under Linux: the glibc of Ubuntu 24.04 (2.39)
/// takes every stdio stream's lock in exit() to flush it — 22.04's (2.35) did
/// not — and std::cin reads through stdin's FILE, whose lock it holds for as
/// long as a read blocks, which the command pump's does until the server writes
/// again. Each worker's last return then hung in exit() until the server killed
/// it: exit code 9 at the end of every stream. read(2) on the descriptor holds
/// no lock. Called from one thread at a time: the config line, then the pump.
bool readServerLine(std::string& line)
{
#if defined(__linux__)
    static std::string pending;
    for (;;) {
        const size_t end = pending.find('\n');
        if (end != std::string::npos) {
            line.assign(pending, 0, end);
            pending.erase(0, end + 1);
            return true;
        }
        char buffer[4096];
        const ssize_t got = ::read(STDIN_FILENO, buffer, sizeof buffer);
        if (got > 0) {
            pending.append(buffer, static_cast<size_t>(got));
            continue;
        }
        if (got < 0 && errno == EINTR) continue;
        // The end, or a broken pipe: what came before it is still a line.
        if (pending.empty()) return false;
        line.swap(pending);
        pending.clear();
        return true;
    }
#else
    return static_cast<bool>(std::getline(std::cin, line));
#endif
}

/// Holds the live relay graph pointers so stdin commands and the end-of-session
/// path can tear the graph down the same way main.cpp's /quit route does.
struct WorkerState
{
    QPointer<StreamSession> session;
    QPointer<DataChannelRelay> relay;
    QPointer<MediaTrackRelay> mediaRelay;
    QPointer<StreamRelay> streamRelay;
    bool endedEmitted = false;
    bool exiting = false;
};

WorkerState* g_State = nullptr;

/// Swap the input policy under a running stream.
///
/// It goes to the RELAY, never to the session. StreamSession is ephemeral by
/// design — it hands the graph over and deletes itself the moment the
/// connection is up ("StreamSession is ephemeral — relay lives on") — so the
/// QPointer this file keeps to it is null for the entire life of every stream.
/// Dispatching through it meant the owner's demotion reached nothing at all:
/// a guest moved from full control to gamer kept their keyboard and mouse, and
/// the board said otherwise. The relay is what outlives the launch, what every
/// inbound message is checked against, and what owns the shim.
void applyPolicyToLiveGraph(const InputMsg::Policy& policy)
{
    if (!g_State) return;

    // The policy is read on the relay thread on every inbound message, so it is
    // written there too: a plain setter from the stdin pump would be a data race
    // on the hot path. StreamRelay is not a RelayBase (the legacy WSS path
    // predates it) but carries the same two accessors, so one templated lambda
    // covers all three.
    auto push = [policy](auto* relay) {
        if (!relay) return;
        QMetaObject::invokeMethod(
            relay,
            [relay, policy]() {
                relay->setInputPolicy(policy);
                IMediaEngine* engine = relay->mediaEngine();
                if (!engine) return;
                engine->setWakeNudgeAllowed(policy.keyboardMouse);
                // Release everything, then let the client's next heartbeat put
                // back whatever it still holds *and* is still allowed to hold.
                // Anything else leaves a key down on the host that nobody can
                // lift: the guest can no longer send the key-up, and the owner
                // never pressed it.
                engine->releaseHeldInputs(true);
            },
            Qt::QueuedConnection);
    };
    push(g_State->relay.data());
    push(g_State->mediaRelay.data());
    push(g_State->streamRelay.data());
}

/// Mouse Keys the native engine turned on, and what to put back — or let go —
/// sent to the server as it happens: a worker that is killed holding them
/// cannot put them back, the parent can. Straight from the engine, which lives
/// as long as the stream: the StreamSession goes once the stream is up, and
/// with it anything relayed through it (bench of 16/10: the end of every
/// stream went unsaid). Direct, from the capture thread or whichever stops the
/// engine: one line per write, under the stream's own lock.
void relayMouseKeys(IMediaEngine* engine)
{
    auto* native = qobject_cast<NativeMediaEngine*>(engine);
    if (!native) return;
    QObject::connect(
        native, &NativeMediaEngine::mouseKeysChanged, qApp,
        [](bool on, const QJsonObject& saved) {
            QJsonObject event{{QStringLiteral("event"), QStringLiteral("mouseKeys")},
                              {QStringLiteral("on"), on}};
            if (on) event.insert(QStringLiteral("saved"), saved);
            emitEvent(event);
        },
        Qt::DirectConnection);
}

/// Mirror of the /quit teardown in main.cpp: stop the shim FIRST (so moonlight
/// stops calling back into a relay about to be destroyed), then stop + delete
/// the relay. Exits the process once done (short grace for the relay thread).
void teardownAndExit(int notify /*0=none, 1=takenOver, 2=revoked, 3=sessionEnded*/)
{
    if (!g_State || g_State->exiting) return;
    g_State->exiting = true;

    QJsonObject hold;

    if (g_State->relay) {
        DataChannelRelay* r = g_State->relay;
        g_State->relay = nullptr;
        if (notify == 1 && r->isConnected()) r->notifyClientTakenOver();
        if (notify == 2) r->notifyClientRevoked();
        if (notify == 3) r->notifyClientSessionEnded();
        QObject::disconnect(r, &DataChannelRelay::sessionEnded, nullptr, nullptr);
        if (r->mediaEngine()) {
            r->mediaEngine()->stopConnection();
            hold = r->mediaEngine()->captureHoldReport();
        }
        r->stop();
        r->deleteLater();
    }
    if (g_State->mediaRelay) {
        MediaTrackRelay* r = g_State->mediaRelay;
        g_State->mediaRelay = nullptr;
        if (notify == 1 && r->isConnected()) r->notifyClientTakenOver();
        if (notify == 2) r->notifyClientRevoked();
        if (notify == 3) r->notifyClientSessionEnded();
        QObject::disconnect(r, &MediaTrackRelay::sessionEnded, nullptr, nullptr);
        if (r->mediaEngine()) {
            r->mediaEngine()->stopConnection();
            hold = r->mediaEngine()->captureHoldReport();
        }
        r->stop();
        r->deleteLater();
    }
    if (g_State->streamRelay) {
        StreamRelay* r = g_State->streamRelay;
        g_State->streamRelay = nullptr;
        if (notify == 1 && r->isClientConnected()) r->notifyClientTakenOver();
        if (notify == 2) r->notifyClientRevoked();
        if (notify == 3) r->notifyClientSessionEnded();
        QObject::disconnect(r, &StreamRelay::sessionEnded, nullptr, nullptr);
        if (r->mediaEngine()) {
            r->mediaEngine()->stopConnection();
            hold = r->mediaEngine()->captureHoldReport();
        }
        r->stop();
        r->deleteLater();
    }


    // The capture's word on the display it held (CaptureHold.h), for the
    // server's `vddmatch`: the parent alone keeps a settings file. Before
    // "ended", which the server tears the slot down on.
    if (!hold.isEmpty()) {
        hold.insert(QStringLiteral("event"), QStringLiteral("captureHold"));
        emitEvent(hold);
    }

    if (!g_State->endedEmitted) {
        g_State->endedEmitted = true;
        emitEvent({{QStringLiteral("event"), QStringLiteral("ended")}});
    }

    // The relay graph tears down asynchronously on its own thread; give it a
    // moment before the process exits (LiStopConnection can take a while).
    // Whatever an engine parked on its way down meanwhile goes too.
    QTimer::singleShot(3000, qApp, []() { QCoreApplication::quit(); });
}

} // namespace

static int runStreamWorker(QCoreApplication& app)
{
    Q_UNUSED(app);
    qInfo() << "[StreamWorker] Worker process started, waiting for config on stdin";


    // ── First stdin line = session config ────────────────────────────────────
    std::string configLine;
    if (!readServerLine(configLine)) {
        qWarning() << "[StreamWorker] No config on stdin — exiting";
        return 1;
    }
    const QJsonObject cfg = QJsonDocument::fromJson(QByteArray::fromStdString(configLine)).object();
    if (cfg.isEmpty()) {
        qWarning() << "[StreamWorker] Invalid config JSON — exiting";
        emitEvent({{QStringLiteral("event"), QStringLiteral("response")},
                   {QStringLiteral("code"), 500},
                   {QStringLiteral("body"),
                    QJsonObject{{QStringLiteral("error"), QStringLiteral("bad worker config")}}}});
        return 1;
    }

    // The server's --config, before the first AppSettings below: this process
    // reads the same file the server does, whichever way it was started.
    const QString settingsFile = cfg[QStringLiteral("settingsFile")].toString();
    if (!settingsFile.isEmpty()) AppSettings::setFileOverride(settingsFile);
    // The server's verbose mode, before the session builds its first
    // PeerConnection: libdatachannel reads its log level as each one starts.
    if (cfg[QStringLiteral("verbose")].toBool()) {
        mw::run::setVerboseFromCli(true);
        mw::run::applyVerboseLogging();
    }

    // Keyboard diagnostics, armed HERE and not only in main(): a keystroke is
    // handled by the relays this process builds, and main() sets the flag well
    // after `return runStreamWorker(app)` — so in worker mode, which is the
    // default, the switch was on in the one process that never sees a key.
    // Same trap, same shape as the latency flag: anything an input or capture
    // path reads has to be read again on this side of the fork.
    // From the server's config too: a SYSTEM worker's own AppSettings reads
    // SYSTEM's profile, where nobody wrote it.
    if (AppSettings().keyboardDebug() || cfg[QStringLiteral("keyboardDebug")].toBool(false)) {
        InputMsg::setDebug(true);
        InputMsg::setQuietProbe(&mw::native::NativeHost::secureDesktopHasInput);
        mw::native::NativeHost::setKeyboardDiagnostics(true);
        qInfo() << "[KBD] keyboard diagnostics on in the worker (never on the secure desktop)";
    }

    // Automatic storage is required: the relay callbacks below capture `state`
    // by reference, and a lambda can only capture a variable with automatic
    // storage duration. It lives on this frame for the whole event loop —
    // g_State is only dereferenced from teardown callbacks that run inside
    // app.exec() below, well before the frame unwinds — so the pointer never
    // actually dangles.
    WorkerState state;
    // cppcheck-suppress danglingLifetime
    g_State = &state;

    // ── This computer, the one host there is ─────────────────────────────────
    // Paired and online by construction: there is no second party, the engine
    // captures the machine it runs on (ComputerManager::refreshNativeHost).
    auto* host = new NvComputer();
    host->uuid = NativeHostBackend::hostUuid();
    host->name = NativeHostBackend::hostDisplayName();
    host->backendType = NativeHostBackend::typeName();
    host->pairState = NvComputer::PS_PAIRED;
    host->state = NvComputer::CS_ONLINE;
    host->reachable = true;
    host->serverCodecModeSupport = NativeHostBackend::codecModeSupport();
    // The address is this machine's: the clipboard and the lock keys follow it.
    host->activeAddress = NvAddress(QStringLiteral("127.0.0.1"), MW_HTTP_PORT);

    auto* nam = new QNetworkAccessManager(&app);
    auto* http = new NvHTTP(nam, &app);
    std::shared_ptr<IStreamBackend> backend = std::make_shared<NativeHostBackend>();

    // ── The /start HTTP reply is marshalled back to the parent ───────────────
    ResponseCallback respond = [](HttpResponse resp) {
        QJsonObject event;
        event["event"] = QStringLiteral("response");
        event["code"] = resp.statusCode;
        const QJsonDocument bodyDoc = QJsonDocument::fromJson(resp.body);
        if (bodyDoc.isObject())
            event["body"] = bodyDoc.object();
        else
            event["body"] = QJsonObject{{QStringLiteral("error"), QString::fromUtf8(resp.body)}};
        emitEvent(event);
    };

    // ── Build the session exactly like main.cpp's createSession ─────────────
    auto* session = new StreamSession(
        host, cfg["appId"].toInt(), http, std::move(respond),
        static_cast<quint16>(cfg["signalingPort"].toInt(48001)), cfg["serverHost"].toString(),
        static_cast<VideoCodec>(cfg["codec"].toInt()), cfg["gamingMode"].toBool(true),
        cfg["internalTransport"].toString(), cfg["stunServer"].toString(), cfg["height"].toInt(),
        cfg["width"].toInt(), cfg["fps"].toInt(), cfg["bitrateKbps"].toInt(),
        cfg["yuv444"].toBool(), cfg["hdr"].toBool());
    session->setHttpsPort(static_cast<quint16>(cfg["serverHttpsPort"].toInt(443)));
    session->setStreamRelayPort(static_cast<quint16>(cfg["streamRelayPort"].toInt(48002)));
    session->setMediaPort(static_cast<quint16>(cfg["mediaPort"].toInt(48550)));
    // The router hole the parent claimed for this slot, if any. Absent (no
    // gateway, UPnP off, a guest) → STUN only, as before.
    session->setUpnpMapping(cfg["upnpPublicIp"].toString(),
                            static_cast<quint16>(cfg["upnpExternalPort"].toInt(0)));
    session->setTransportMode(cfg["transportMode"].toString());
    session->setEnableIceTcp(cfg["iceTcp"].toBool());
    session->setLowAudio(cfg["lowAudio"].toBool());
    session->setMuteHostAudio(cfg["muteHostAudio"].toBool(true));
    // Absent (an older parent) → off, which is exactly today's behaviour.
    session->setRideOutLoss(cfg["rideOutLoss"].toBool(false));
    // Absent (an older parent, a guest) → the engine's own repairs.
    session->setRefInvalidation(cfg["refInvalidation"].toBool(true));
    // Absent (an older parent, a guest) → no cropping, the frame on the grid.
    session->setCropsToFrame(cfg["cropsToFrame"].toBool(false));
    // A native display card: its display, as the server resolved it. This
    // process, SYSTEM's maybe, does not read the file the cards are numbered in.
    if (cfg.contains(QStringLiteral("displayKey")))
        session->setDisplayKey(cfg[QStringLiteral("displayKey")].toString());
    // One of the owner's apps: whether it is still there, for the same reason.
    if (cfg.contains(QStringLiteral("hostAppKnown")))
        session->setHostAppKnown(cfg[QStringLiteral("hostAppKnown")].toBool());
    // On our virtual display: the display it took the primary role from.
    if (cfg.contains(QStringLiteral("previousPrimary")))
        session->setPreviousPrimary(cfg[QStringLiteral("previousPrimary")].toString());
    // Absent (an older parent) → not an administrator: the safe reading,
    // since the only thing it grants is the host's administrator windows.
    session->setViewerAdmin(cfg["viewerAdmin"].toBool(false));
    // Absent (an older parent) → this process reads the file, as before.
    session->setKeyboardLayoutFidelity(cfg["keyboardLayoutFidelity"].toString());
    // Absent (an older parent, or a machine that never met a portal) → empty,
    // and the user is asked. Never a failure: a dialog is the fallback.
    session->setPortalRestoreToken(cfg["portalRestoreToken"].toString());
    // Absent (an older parent, or a guest) → the monitor stays where it is.
    session->setVirtualPrimary(cfg["virtualPrimary"].toBool(false));
    session->setGamescopeApp(cfg["gamescopeApp"].toString(), cfg["gamescopeCommand"].toString());
    session->setNativeVideoPipeline(cfg["nativeVideoPipeline"].toString());
    // Absent (an older parent, or no knob) → empty: the engine's own settings.
    session->setNativeTuning(cfg["nativeTuning"].toString());
    session->setRtpVideo(cfg["rtpVideo"].toString());
    // A guest on the guests' shared feed: absent → this session captures.
    session->setSharedFeed(cfg["feedPipe"].toString(), cfg["feedToken"].toString().toLatin1(),
                           cfg["feedSlot"].toInt(-1));
    session->setClientPresentation(cfg["clientRefreshMilliHz"].toInt(0),
                                   cfg["clientVsync"].toBool(false),
                                   cfg["clientTearingReal"].toBool(false));
    // Absent (an older parent, or a rate the viewer named) → no ceiling, and
    // the cadence keeps every freedom it had.
    session->setMaxFps(cfg["fpsCeiling"].toInt(0));
    // Absent (an older parent) → the frame keeps its size, today's behaviour.
    session->setFollowDisplayShape(cfg["followDisplayShape"].toBool(false));
    // Absent (an older parent) → the height is kept, today's behaviour.
    session->setFrameFit(cfg["fitRequestedBox"].toBool(false), cfg["allowUpscale"].toBool(false),
                         cfg["matchClientDisplay"].toBool(false), cfg["fallbackWidth"].toInt(0),
                         cfg["fallbackHeight"].toInt(0));
    session->setBackend(backend);
    session->setClientUniqueId(cfg["clientUniqueId"].toString());
    session->setPreferResume(cfg["preferResume"].toBool(false));
    // Absent (an older parent) → Public: the conservative reading, since every
    // non-Public verdict grants something.
    session->setClientKind(NetClassify::fromString(cfg["clientKind"].toString()));
    // MW-BIND-v1 material, arriving on stdin rather than the command line so the
    // host private key never shows up in the process list.
    session->setPairingIdentity(
        cfg["mwBindHostId"].toString(),
        QByteArray::fromBase64(cfg["mwBindHostKey"].toString().toUtf8()),
        QByteArray::fromBase64(cfg["mwBindBrowserKey"].toString().toUtf8()));
    session->setAutoMode(cfg["autoMode"].toBool(true));
    session->setWsPath(cfg["wsPath"].toString(QStringLiteral("/ws")));
    // A shared session (invited player) arrives with the permissions the owner
    // ticked. Absent = the owner's own session: unrestricted. This is only the
    // starting value: the owner can move it from the sharing board at any time,
    // and it arrives here as a "setPolicy" command on stdin.
    if (cfg.contains(QStringLiteral("inputPolicy"))) {
        const QJsonObject pol = cfg["inputPolicy"].toObject();
        InputMsg::Policy policy;
        policy.gamepad = pol["gamepad"].toBool(false);
        policy.keyboardMouse = pol["keyboardMouse"].toBool(false);
        policy.hid = pol["hid"].toBool(false);
        session->setInputPolicy(policy);
        qInfo() << "[StreamWorker] Input policy: gamepad=" << policy.gamepad
                << "keyboardMouse=" << policy.keyboardMouse << "hid=" << policy.hid;
        // A guest let into the host's administrator windows by the owner's
        // settings file, said once: read afterwards, the log shows why this
        // invited player could drive one.
        if (cfg["viewerAdmin"].toBool(false))
            qInfo() << "[StreamWorker] administrator windows open to this invited player"
                       " (share_guests_admin_windows)";
    }
    // What the media path revealed about the host's OS. Only the parent keeps a
    // host list, so this is the only way the observation outlives the stream —
    // and outliving it is the point: without it every session would spend its
    // first seconds quantizing scroll on a host already known not to need it.
    QObject::connect(session, &StreamSession::hostIpTtlObserved, session, [](int ttl) {
        emitEvent(
            {{QStringLiteral("event"), QStringLiteral("hostIpTtl")}, {QStringLiteral("ttl"), ttl}});
    });
    // The desktop portal's consent, on its way to the settings file — which
    // only the parent has. Sent as it arrives rather than at the end of the
    // session: a worker that is killed still leaves the user's click banked.
    QObject::connect(session, &StreamSession::portalGrantReceived, session,
                     [](const QString& token) {
                         emitEvent({{QStringLiteral("event"), QStringLiteral("portalGrant")},
                                    {QStringLiteral("token"), token}});
                     });

    session->setGamepadOffset(cfg["gamepadOffset"].toInt(0));
    if (!cfg["explicitWsUrl"].toString().isEmpty())
        session->setExplicitWsUrl(cfg["explicitWsUrl"].toString());
    if (cfg["codecOverridden"].toBool())
        session->setCodecOverridden(true, static_cast<VideoCodec>(cfg["originalCodec"].toInt()));
    {
        QStringList chain;
        for (const auto& v : cfg["transportChain"].toArray())
            chain.append(v.toString());
        session->setTransportChain(chain, cfg["transportIndex"].toInt());
    }

    // Kept so the stdin pump can reach the live graph: a policy change from the
    // owner's board lands on the session, which pushes it to whichever relay
    // exists and releases what the old policy had held down.
    state.session = session;

    // ── Relay tracking: unexpected end → "ended" event + teardown + exit ─────
    // (The parent owns the Sunshine /cancel, keyed by this session's uniqueid.)
    QObject::connect(session, &StreamSession::relayCreated, qApp, [&state](DataChannelRelay* r) {
        state.relay = r;
        QObject::connect(r, &DataChannelRelay::sessionEnded, qApp, []() { teardownAndExit(0); });
        relayMouseKeys(r->mediaEngine());
    });
    QObject::connect(
        session, &StreamSession::mediaTrackRelayCreated, qApp, [&state](MediaTrackRelay* r) {
            state.mediaRelay = r;
            QObject::connect(r, &MediaTrackRelay::sessionEnded, qApp, []() { teardownAndExit(0); });
            relayMouseKeys(r->mediaEngine());
        });
    QObject::connect(session, &StreamSession::streamRelayCreated, qApp, [&state](StreamRelay* r) {
        state.streamRelay = r;
        QObject::connect(r, &StreamRelay::sessionEnded, qApp, []() { teardownAndExit(0); });
        relayMouseKeys(r->mediaEngine());
    });
    // Session failed before any relay existed (Sunshine rejection, bind failure):
    // the response event already carried the error — just exit.
    QObject::connect(session, &StreamSession::sessionFailed, qApp, [](const QString& err) {
        qWarning() << "[StreamWorker] Session failed:" << err;
        teardownAndExit(0);
    });

    // ── stdin command pump (blocking reads on a plain thread — portable) ─────
    std::thread stdinThread([]() {
        std::string line;
        while (readServerLine(line)) {
            const QJsonObject msg =
                QJsonDocument::fromJson(QByteArray::fromStdString(line)).object();
            const QString cmd = msg["cmd"].toString();
            if (cmd == QLatin1String("quit")) {
                QMetaObject::invokeMethod(qApp, []() { teardownAndExit(0); }, Qt::QueuedConnection);
            } else if (cmd == QLatin1String("takenOver")) {
                QMetaObject::invokeMethod(qApp, []() { teardownAndExit(1); }, Qt::QueuedConnection);
            } else if (cmd == QLatin1String("revoked")) {
                QMetaObject::invokeMethod(qApp, []() { teardownAndExit(2); }, Qt::QueuedConnection);
            } else if (cmd == QLatin1String("sessionEnded")) {
                QMetaObject::invokeMethod(qApp, []() { teardownAndExit(3); }, Qt::QueuedConnection);
            } else if (cmd == QLatin1String("setPolicy")) {
                // The owner moved this player's inputs while they were playing.
                // Not a teardown: the stream carries on under the new rules.
                InputMsg::Policy policy;
                policy.gamepad = msg["gamepad"].toBool(false);
                policy.keyboardMouse = msg["keyboardMouse"].toBool(false);
                policy.hid = msg["hid"].toBool(false);
                qInfo() << "[StreamWorker] Input policy now: gamepad=" << policy.gamepad
                        << "keyboardMouse=" << policy.keyboardMouse << "hid=" << policy.hid;
                QMetaObject::invokeMethod(
                    qApp,
                    [policy]() {
                        // Both, and in this order. The session only still
                        // exists in the sliver before the connection comes up,
                        // where it is the thing that will build the relay and
                        // has to be told; after that it is gone and the relay
                        // is the only thing left to tell.
                        if (g_State && g_State->session) g_State->session->applyInputPolicy(policy);
                        applyPolicyToLiveGraph(policy);
                    },
                    Qt::QueuedConnection);
            }
        }
        // EOF: the parent is gone — never stream without a supervisor.
        QMetaObject::invokeMethod(qApp, []() { teardownAndExit(0); }, Qt::QueuedConnection);
    });
    stdinThread.detach();

    session->start();

    const int rc = app.exec();
    qInfo() << "[StreamWorker] Worker exiting rc=" << rc;
    return rc;
}

namespace {

void messageToLogger(QtMsgType type, const QMessageLogContext&, const QString& msg)
{
    switch (type) {
    case QtDebugMsg: Logger::debug(msg); break;
    case QtInfoMsg: Logger::info(msg); break;
    case QtWarningMsg: Logger::warning(msg); break;
    default: Logger::error(msg); break;
    }
}

} // namespace

/**
 * sfagents-screen                 one stream: the session config on stdin,
 *                                 the protocol in StreamWorkerMain.h
 * sfagents-screen --probe         what this computer can stream, as JSON
 * sfagents-screen --vdisplay-apply --stage=driver --vdisplay-dir <dir>
 *                                 install the virtual display's driver
 *                                 (elevated, at SF Agents' startup approval)
 *
 * stdout carries only the protocol or the answer; the log goes to stderr,
 * which SF Agents reads.
 */
int main(int argc, char* argv[])
{
#if defined(Q_OS_LINUX)
    // A GUI application for the clipboard, with no window: the desktop's own
    // platform when there is one, and offscreen when it cannot be reached.
    if (qEnvironmentVariableIsEmpty("QT_QPA_PLATFORM"))
        qputenv("QT_QPA_PLATFORM", !qEnvironmentVariableIsEmpty("WAYLAND_DISPLAY") ? "wayland;xcb;offscreen"
                                   : !qEnvironmentVariableIsEmpty("DISPLAY")       ? "xcb;offscreen"
                                                                                   : "offscreen");
#endif
    QGuiApplication app(argc, argv);
    std::setlocale(LC_NUMERIC, "C");
    QCoreApplication::setApplicationName(QStringLiteral("sfagents-screen"));
    QCoreApplication::setApplicationVersion(QStringLiteral(MW_VERSION));
    QCoreApplication::setOrganizationName(QStringLiteral("SF Agents"));
    Logger::instance()->setConsoleToStderr(true);
    qInstallMessageHandler(messageToLogger);

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("SF Agents screen mirroring helper"));
    QCommandLineOption probeOption(QStringLiteral("probe"),
                                   QStringLiteral("Print what this computer can stream, as JSON"));
    QCommandLineOption vdisplayApplyOption(QStringLiteral("vdisplay-apply"),
                                           QStringLiteral("Apply a virtual display request"));
    QCommandLineOption vdisplayStageOption(QStringLiteral("stage"),
                                           QStringLiteral("all|snapshot|driver|mode"),
                                           QStringLiteral("stage"), QStringLiteral("all"));
    QCommandLineOption vdisplayDirOption(QStringLiteral("vdisplay-dir"),
                                         QStringLiteral("The staging directory"),
                                         QStringLiteral("dir"));
    QCommandLineOption verboseOption(QStringLiteral("verbose"), QStringLiteral("Verbose logs"));
    parser.addOptions({probeOption, vdisplayApplyOption, vdisplayStageOption, vdisplayDirOption,
                       verboseOption});
    parser.process(app);
    mw::run::setVerboseFromCli(parser.isSet(verboseOption));

    if (parser.isSet(probeOption)) return NativeProbeService::runProbeCommand();
    if (parser.isSet(vdisplayApplyOption))
        return VirtualDisplayApply::run(parser.value(vdisplayStageOption),
                                        parser.value(vdisplayDirOption));
    return runStreamWorker(app);
}
