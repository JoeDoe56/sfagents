/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
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

#pragma once

#include <cstdint>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

// An app in its own gamescope, at the client's size and rate (plan Idées
// Punktfunk, chapter G; Bruno's decisions of 01/10/2026): the Steam card runs
// Big Picture there, apart from the desktop — whose screens never move, and
// which keeps its own keyboard and mouse.
//
// ── What gamescope is asked ─────────────────────────────────────────────────
//
// `--backend headless`: no screen, no DRM master, no session needed — a GPU's
// render node and Xwayland. Its picture is a PipeWire node named "gamescope",
// on the session's own PipeWire; its input, an EIS socket (libei), since it
// reads no evdev or uinput device without a screen (bench §8s.13). Both are
// named to the app it starts, in LIBEI_SOCKET and DISPLAY: a two-line wrapper
// hands them back to us in a file.
//
// ── Why a user unit ─────────────────────────────────────────────────────────
//
// The session outlives the stream: a stream that ends leaves it running ten
// minutes for the next one to find (Bruno, 01/10/2026), and the worker that
// started it goes with its stream. So gamescope runs as a transient unit of
// the user's systemd (`systemd-run --user`): its own cgroup, stopped by name,
// and a timer re-armed by every stream on it stops it ten minutes after the
// last. Without DISPLAY and WAYLAND_DISPLAY: gamescope would take a desktop's
// for its own and quit when it cannot nest there (Punktfunk).
//
// ── Steam ───────────────────────────────────────────────────────────────────
//
// One Steam a user, whatever the screen: a second one hands its command line
// to the first and quits — and gamescope with it, its only app gone. So a
// Steam open on the desktop is asked to quit first (refused while a game runs
// there), and opened on the desktop again when the session stops. It is asked
// through its own single-instance pipe, by the runtime's forwarder: the snap's
// launcher took `-shutdown` and did nothing with it (UM790Pro, 01/10/2026).
// Only the Steam actually in use is ever started — the one running, else the
// one last signed in to: the UM790Pro's unused .deb install asked to install
// 32-bit packages in a terminal before anything else.
//
// This header is the arithmetic — version, command lines, the record — which
// every platform's test run covers; GamescopeSession.cpp is the processes and
// files, on Linux.

namespace mw::native::capture {

// ── gamescope itself ─────────────────────────────────────────────────────────

struct GamescopeVersion
{
    int major = 0;
    int minor = 0;
    int patch = 0;

    bool atLeast(const GamescopeVersion& o) const
    {
        if (major != o.major) return major > o.major;
        if (minor != o.minor) return minor > o.minor;
        return patch >= o.patch;
    }
    std::string text() const
    {
        return std::to_string(major) + "." + std::to_string(minor) + "." + std::to_string(patch);
    }
};

/// The oldest gamescope the card is offered with: before 3.16.22 it
/// deadlocks against PipeWire 1.6 (Punktfunk's floor), and 3.16.1 stops on
/// a wlroots assertion without a screen (bench §8s.13).
constexpr GamescopeVersion kGamescopeMinimum{3, 16, 22};

/// The version out of `gamescope --version`: the first X.Y[.Z] after the word
/// "version" — "gamescope version 3.16.31+ (gcc 13.3.0)", log prefix, colour
/// codes and a distribution's suffix around it. False when there is none.
inline bool parseGamescopeVersion(const std::string& banner, GamescopeVersion& out)
{
    out = GamescopeVersion{};
    const size_t word = banner.find("version");
    if (word == std::string::npos) return false;
    size_t i = word + 7;
    while (i < banner.size() && !(banner[i] >= '0' && banner[i] <= '9'))
        if (banner[i++] == '\n') return false;
    int parts[3] = {0, 0, 0};
    int count = 0;
    while (count < 3 && i < banner.size() && banner[i] >= '0' && banner[i] <= '9') {
        long value = 0;
        while (i < banner.size() && banner[i] >= '0' && banner[i] <= '9' && value < 100000)
            value = value * 10 + (banner[i++] - '0');
        parts[count++] = static_cast<int>(value);
        if (i + 1 < banner.size() && banner[i] == '.' && banner[i + 1] >= '0' &&
            banner[i + 1] <= '9')
            ++i;
        else
            break;
    }
    if (count < 2) return false;
    out.major = parts[0];
    out.minor = parts[1];
    out.patch = parts[2];
    return true;
}

/// The node id in a line of gamescope's log: "pipewire: stream available on
/// node ID: 76". False on any other line.
inline bool parseGamescopeNodeLine(const std::string& line, uint32_t& node)
{
    const std::string marker = "node ID:";
    const size_t at = line.find(marker);
    if (at == std::string::npos) return false;
    size_t i = at + marker.size();
    while (i < line.size() && line[i] == ' ')
        ++i;
    uint64_t value = 0;
    size_t digits = 0;
    while (i < line.size() && line[i] >= '0' && line[i] <= '9' && digits < 10) {
        value = value * 10 + static_cast<uint64_t>(line[i++] - '0');
        ++digits;
    }
    if (digits == 0 || value == 0 || value > 0xffffffffu) return false;
    node = static_cast<uint32_t>(value);
    return true;
}

/// Where gamescope's app is reached: the EIS socket (a name in the runtime
/// directory, as LIBEI_SOCKET gives it, or a path) and the X display.
struct GamescopeEndpoints
{
    std::string eisSocket; ///< "gamescope-0-ei"
    std::string xDisplay;  ///< ":2"

    bool valid() const { return !eisSocket.empty() && !xDisplay.empty(); }
};

/// What the wrapper wrote: "LIBEI_SOCKET=…" and "DISPLAY=…" lines.
inline bool parseGamescopeEndpoints(const std::string& text, GamescopeEndpoints& out)
{
    out = GamescopeEndpoints{};
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        if (line.rfind("LIBEI_SOCKET=", 0) == 0) out.eisSocket = line.substr(13);
        if (line.rfind("DISPLAY=", 0) == 0) out.xDisplay = line.substr(8);
    }
    return out.valid();
}

// ── Steam ────────────────────────────────────────────────────────────────────

enum class SteamPackaging
{
    Native,  ///< Valve's package (steam-launcher, steam-installer): /usr/bin/steam
    Snap,    ///< Canonical's snap: /snap/bin/steam, its home ~/snap/steam/common
    Flatpak, ///< com.valvesoftware.Steam, its home ~/.var/app/com.valvesoftware.Steam
};

inline const char* toString(SteamPackaging p)
{
    switch (p) {
    case SteamPackaging::Native: return "package";
    case SteamPackaging::Snap: return "snap";
    case SteamPackaging::Flatpak: return "Flatpak";
    }
    return "?";
}

/// One Steam the user has.
struct SteamInstall
{
    SteamPackaging packaging = SteamPackaging::Native;
    /// The HOME it runs with — where its ~/.steam, pid file and pipe are.
    std::string home;
    /// How it is started.
    std::vector<std::string> launcher;
    /// When someone last signed in to it (config/loginusers.vdf), seconds
    /// since the epoch; 0 never.
    int64_t lastUsed = 0;
};

/// The Steam a card starts: the one running (its client's HOME), else the one
/// signed in to last, else the only one there is. -1 when none fits — two
/// installs nobody ever signed in to: guessing would start the wrong one.
inline int chooseSteam(const std::vector<SteamInstall>& installs, const std::string& runningHome)
{
    if (!runningHome.empty())
        for (size_t i = 0; i < installs.size(); ++i)
            if (installs[i].home == runningHome) return static_cast<int>(i);
    int best = -1;
    for (size_t i = 0; i < installs.size(); ++i)
        if (installs[i].lastUsed > 0 &&
            (best < 0 || installs[i].lastUsed > installs[static_cast<size_t>(best)].lastUsed))
            best = static_cast<int>(i);
    if (best >= 0) return best;
    return installs.size() == 1 ? 0 : -1;
}

/// Steam in Big Picture.
inline std::vector<std::string> steamBigPictureCommand(const SteamInstall& steam)
{
    std::vector<std::string> command = steam.launcher;
    command.push_back("-gamepadui");
    return command;
}

/// Where the runtime's forwarder may be — the program that writes a command
/// line into a running Steam's pipe, which `steam -shutdown` reaches only
/// once its launcher has found the client. Through ~/.steam/root first (a
/// package's or the snap's data, wherever it is), then the data directory
/// itself (Flatpak's root link names a path inside its sandbox).
inline std::vector<std::string> steamRemoteCandidates(const SteamInstall& steam)
{
    const std::string tail = "/ubuntu12_32/steam-runtime/amd64/usr/bin/steam-runtime-steam-remote";
    return {steam.home + "/.steam/root" + tail, steam.home + "/.local/share/Steam" + tail};
}

/// Whether @p argv0 is a Steam client — the program that holds the single
/// instance, not its launcher or its helpers.
inline bool isSteamClient(const std::string& argv0)
{
    const std::string tail = "/ubuntu12_32/steam";
    return argv0.size() >= tail.size() &&
           argv0.compare(argv0.size() - tail.size(), tail.size(), tail) == 0;
}

/// Whether a command line is a game Steam launched (its reaper's).
inline bool isSteamGame(const std::string& cmdline)
{
    return cmdline.find("SteamLaunch AppId=") != std::string::npos;
}

// ── The unit ─────────────────────────────────────────────────────────────────

/// One gamescope session, as the unit is made.
struct GamescopeLaunch
{
    std::string unit;   ///< "moonlightweb-gamescope-steam" — ".service" is systemd's
    std::string binary; ///< gamescope, absolute
    std::string path;   ///< PATH inside: gamescope's own directory first (gamescopereaper)
    int width = 0;
    int height = 0;
    int refreshHz = 0;
    bool steam = false; ///< --steam: Steam's own integration (focus, its overlay)
    std::vector<std::string> app;
    std::string infoPath;                 ///< where the wrapper writes what gamescope tells its app
    std::string logPath;                  ///< gamescope's output — the node id comes from it
    std::vector<std::string> environment; ///< "XKB_DEFAULT_LAYOUT=fr"…
    /// Steam asked to quit before the rest is stopped — empty for another app:
    /// its HOME, and the forwarder found for it (steamRemoteCandidates).
    std::string stopSteamHome;
    std::string stopSteamRemote;
    /// Steam opened on the desktop again once the unit has stopped.
    std::vector<std::string> steamBack;
};

/// One word of an Exec= line given as a property: systemd reads quotes there,
/// and expands $ and % (its specifiers), so a word is quoted and both doubled.
inline std::string systemdWord(const std::string& word)
{
    std::string out = "\"";
    for (char c : word) {
        if (c == '"' || c == '\\') out += '\\';
        if (c == '$' || c == '%') out += c;
        out += c;
    }
    return out + "\"";
}

inline std::string systemdCommandLine(const std::vector<std::string>& words)
{
    std::string line;
    for (const std::string& w : words)
        line += (line.empty() ? "" : " ") + systemdWord(w);
    return line;
}

/// @p text as one word of a POSIX shell: single-quoted, its own quotes closed
/// around an escaped one.
inline std::string shellWord(const std::string& text)
{
    std::string out = "'";
    for (char c : text)
        out += c == '\'' ? std::string("'\\''") : std::string(1, c);
    return out + "'";
}

/// The script that stops a session's Steam gracefully: asked through its
/// pipe, then given up to @p waitS seconds — gamescope follows its app out,
/// and whatever is left gets systemd's SIGTERM after.
inline std::string steamStopScript(const std::string& home, const std::string& remote, int waitS)
{
    return "HOME=" + shellWord(home) + " " + shellWord(remote) +
           " -shutdown >/dev/null 2>&1; n=0; while [ $n -lt " + std::to_string(waitS * 2) +
           " ] && pgrep -u \"$(id -u)\" -f '/ubuntu12_32/steam( |$)' >/dev/null; do sleep 0.5; "
           "n=$((n+1)); done; exit 0";
}

/// The wrapper gamescope starts its app through: it writes what gamescope
/// gave it, then becomes the app. $0 is the file, "$@" the app. No ${…} in
/// it: systemd-run expands those in a command line, and leaves $NAME alone.
constexpr const char* kGamescopeWrapper =
    "printf 'LIBEI_SOCKET=%s\\nDISPLAY=%s\\n' \"$LIBEI_SOCKET\" \"$DISPLAY\" > \"$0\"; exec \"$@\"";

/// systemd-run's command for @p launch.
inline std::vector<std::string> gamescopeUnitCommand(const GamescopeLaunch& launch)
{
    std::vector<std::string> c = {"systemd-run",
                                  "--user",
                                  "--unit=" + launch.unit,
                                  "--collect",
                                  "--quiet",
                                  "--property=UnsetEnvironment=DISPLAY WAYLAND_DISPLAY",
                                  "--property=StandardOutput=append:" + launch.logPath,
                                  "--property=StandardError=append:" + launch.logPath};
    if (!launch.path.empty()) c.push_back("--setenv=PATH=" + launch.path);
    for (const std::string& variable : launch.environment)
        c.push_back("--setenv=" + variable);
    if (!launch.stopSteamHome.empty() && !launch.stopSteamRemote.empty()) {
        c.push_back("--property=ExecStop=" +
                    systemdCommandLine(
                        {"/bin/sh", "-c",
                         steamStopScript(launch.stopSteamHome, launch.stopSteamRemote, 30)}));
        c.push_back("--property=TimeoutStopSec=45");
    }
    if (!launch.steamBack.empty()) {
        std::vector<std::string> back = {"systemd-run", "--user", "--collect", "--quiet",
                                         "--unit=" + launch.unit + "-steam-back"};
        back.insert(back.end(), launch.steamBack.begin(), launch.steamBack.end());
        c.push_back("--property=ExecStopPost=" + systemdCommandLine(back));
    }
    const std::vector<std::string> gamescope = {launch.binary,
                                                "--backend",
                                                "headless",
                                                "-W",
                                                std::to_string(launch.width),
                                                "-H",
                                                std::to_string(launch.height),
                                                "-w",
                                                std::to_string(launch.width),
                                                "-h",
                                                std::to_string(launch.height),
                                                "-r",
                                                std::to_string(launch.refreshHz),
                                                "--xwayland-count",
                                                "1"};
    c.push_back("--");
    c.insert(c.end(), gamescope.begin(), gamescope.end());
    if (launch.steam) c.push_back("--steam");
    c.push_back("--");
    c.push_back("/bin/sh");
    c.push_back("-c");
    c.push_back(kGamescopeWrapper);
    c.push_back(launch.infoPath);
    c.insert(c.end(), launch.app.begin(), launch.app.end());
    return c;
}

/// The timer that stops the unit @p seconds after it was last re-armed.
inline std::vector<std::string> gamescopeLingerCommand(const std::string& unit, int seconds)
{
    return {"systemd-run",
            "--user",
            "--collect",
            "--quiet",
            "--unit=" + unit + "-linger",
            "--on-active=" + std::to_string(seconds),
            "--timer-property=AccuracySec=5s",
            "--",
            "systemctl",
            "--user",
            "stop",
            unit + ".service"};
}

/// The session name of one of the user's apps: "app-" and its name in lower
/// case letters, digits and dashes, 32 at most — what a systemd unit's name
/// and a file's take. The same name, the same session: two cards of one name
/// would share it, as they would run the same thing.
inline std::string gamescopeCardName(const std::string& appName)
{
    std::string slug;
    for (char c : appName) {
        const auto u = static_cast<unsigned char>(c);
        if (u >= 'A' && u <= 'Z')
            slug += static_cast<char>(u - 'A' + 'a');
        else if ((u >= 'a' && u <= 'z') || (u >= '0' && u <= '9'))
            slug += c;
        else if (!slug.empty() && slug.back() != '-')
            slug += '-';
        if (slug.size() >= 32) break;
    }
    while (!slug.empty() && slug.back() == '-')
        slug.pop_back();
    return slug.empty() ? std::string("app") : "app-" + slug;
}

// ── The record ───────────────────────────────────────────────────────────────

/// A running session, as its starter recorded it for the next stream.
struct GamescopeRecord
{
    std::string unit;
    int width = 0;
    int height = 0;
    int refreshHz = 0;
    uint32_t node = 0;
    GamescopeEndpoints endpoints;

    bool valid() const
    {
        return !unit.empty() && width > 0 && height > 0 && node != 0 && endpoints.valid();
    }
};

/// "mw1 <unit> <w> <h> <hz> <node> <eis socket> <x display>"
inline std::string formatGamescopeRecord(const GamescopeRecord& r)
{
    return "mw1 " + r.unit + " " + std::to_string(r.width) + " " + std::to_string(r.height) + " " +
           std::to_string(r.refreshHz) + " " + std::to_string(r.node) + " " +
           r.endpoints.eisSocket + " " + r.endpoints.xDisplay + "\n";
}

inline bool parseGamescopeRecord(const std::string& text, GamescopeRecord& out)
{
    out = GamescopeRecord{};
    std::istringstream in(text);
    std::string tag;
    long long w = 0, h = 0, hz = 0, node = 0;
    if (!(in >> tag >> out.unit >> w >> h >> hz >> node >> out.endpoints.eisSocket >>
          out.endpoints.xDisplay))
        return false;
    if (tag != "mw1" || w <= 0 || h <= 0 || w > 16384 || h > 16384 || hz < 0 || hz > 1000 ||
        node <= 0 || node > 0xffffffffLL) {
        out = GamescopeRecord{};
        return false;
    }
    out.width = static_cast<int>(w);
    out.height = static_cast<int>(h);
    out.refreshHz = static_cast<int>(hz);
    out.node = static_cast<uint32_t>(node);
    return out.valid();
}

// ── The processes and files (GamescopeSession.cpp, Linux) ────────────────────

/// The gamescope this machine would run, when one is there and recent enough.
struct GamescopeBinary
{
    std::string path; ///< absolute, symlinks resolved
    GamescopeVersion version;
};

/// The newest usable gamescope: MW_GAMESCOPE_BIN, then PATH, then
/// ~/.local/bin, /usr/games. False, with @p why, when there is none or it is
/// older than kGamescopeMinimum. Its --version is asked once per binary.
bool findGamescope(GamescopeBinary& out, std::string& why);

/// Every Steam the user has, signed in to or not.
std::vector<SteamInstall> findSteamInstalls();

/// The HOME of the Steam client running outside any gamescope, empty when
/// none runs; @p pid its pid.
std::string runningDesktopSteam(int& pid);

/// A session one stream starts or finds.
struct GamescopeSession
{
    GamescopeRecord record;
    /// Started by this stream, rather than found.
    bool started = false;
    /// gamescope's own process: its PipeWire stream only pauses when it goes,
    /// so the capture watches it to know.
    int pid = 0;
};

/// What a card runs: Steam (the install in use), or a command of the user's.
struct GamescopeApp
{
    std::string card; ///< "steam": names the unit and the record
    bool steam = false;
    std::vector<std::string> command; ///< for a command of the user's
};

/// The card's session, found if one runs, else started at @p width x
/// @p height and @p refreshHz — Steam moved off the desktop first when the
/// card is Steam's. False with @p why (said to the viewer) when it cannot be.
bool openGamescopeSession(const GamescopeApp& app, int width, int height, int refreshHz,
                          GamescopeSession& out, std::string& why);

/// Whether the session's unit still runs: false once its app has quit.
bool gamescopeSessionAlive(const GamescopeRecord& record);

/// The ten-minute timer, armed anew: called by each stream on the session,
/// at the start and then every minute — the last one to stop leaves it to
/// fire, a stream that died included.
void keepGamescopeSession(const GamescopeRecord& record, int lingerSeconds);

/// The runtime directory's path for an EIS socket gamescope named.
std::string gamescopeSocketPath(const std::string& eisSocket);

} // namespace mw::native::capture
