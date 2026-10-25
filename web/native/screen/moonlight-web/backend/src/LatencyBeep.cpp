/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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

#include "LatencyBeep.h"

#include <QByteArray>
#include <QDebug>
#include <QString>
#include <QtGlobal>

#include <chrono>
#include <cstdint>

namespace {

long long steadyUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

} // namespace

namespace LatencyBeep {

Mode modeFromEnvironment()
{
    const QByteArray v = qgetenv("MW_LATENCY_FLAG_SOUND").trimmed().toLower();
    if (v == "click") return Mode::Click;
    if (v == "tick") return Mode::Tick;
    return Mode::Off;
}

} // namespace LatencyBeep

#if defined(Q_OS_WIN)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <cmath>
#include <mutex>
#include <thread>

namespace {

constexpr double kToneHz = 1000.0;
constexpr double kToneMs = 20.0;
constexpr float kAmplitude = 0.5f;

std::mutex g_Mutex;
std::thread g_Thread;
std::atomic<bool> g_Run{false};
std::atomic<bool> g_Ready{false};
// Frames of tone still to write; set by beep(), spent by the output thread.
std::atomic<int> g_Pending{0};
std::atomic<long long> g_AskedUs{0};
std::atomic<int> g_FramesPerBeep{0};
// MW_LATENCY_BEEP=noise: white noise instead of the tone. A pure tone is the
// most periodic signal there is, the one NetEq's time stretching shortens best
// when it catches up on a grown buffer; noise gives it nothing to cut.
bool g_Noise = false;

void outputThread()
{
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    IAudioRenderClient* render = nullptr;
    WAVEFORMATEX* fmt = nullptr;
    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT hr =
        CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                         __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
    // eConsole: the endpoint the native host's loopback captures.
    if (SUCCEEDED(hr)) hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (SUCCEEDED(hr))
        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(&client));
    if (SUCCEEDED(hr)) hr = client->GetMixFormat(&fmt);
    bool isFloat = false;
    if (SUCCEEDED(hr)) {
        isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
            isFloat = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt)->SubFormat.Data1 ==
                      WAVE_FORMAT_IEEE_FLOAT;
        if (!isFloat || fmt->wBitsPerSample != 32) hr = E_NOTIMPL;
    }
    // The engine's own period, event-driven: a beep waits at most one period
    // (about 10 ms) for its turn, and the log says how much was queued ahead.
    if (SUCCEEDED(hr))
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0,
                                fmt, nullptr);
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(event);
    if (SUCCEEDED(hr))
        hr = client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&render));
    UINT32 bufferFrames = 0;
    if (SUCCEEDED(hr)) hr = client->GetBufferSize(&bufferFrames);
    if (SUCCEEDED(hr)) hr = client->Start();
    if (FAILED(hr)) {
        qWarning() << "[LatencyBeep] the default output could not be opened (0x"
                   << QByteArray::number(static_cast<qulonglong>(static_cast<unsigned long>(hr)),
                                         16)
                   << ") — no beep";
        g_Run = false;
    } else {
        const int channels = fmt->nChannels;
        const double rate = fmt->nSamplesPerSec;
        g_FramesPerBeep = static_cast<int>(rate * kToneMs / 1000.0);
        g_Noise = qgetenv("MW_LATENCY_BEEP").trimmed().toLower() == "noise";
        qInfo() << "[LatencyBeep] armed:" << kToneMs << "ms of"
                << (g_Noise ? QStringLiteral("white noise") : QString::number(kToneHz) + " Hz")
                << "on the default"
                << "output," << static_cast<int>(rate) << "Hz," << channels << "channels, buffer"
                << bufferFrames << "frames";
        g_Ready = true;
        double phase = 0;
        uint32_t noise = 0x12345678u;
        const double step = 2.0 * 3.14159265358979323846 * kToneHz / rate;
        while (g_Run) {
            WaitForSingleObject(event, 100);
            UINT32 padding = 0;
            if (FAILED(client->GetCurrentPadding(&padding))) break;
            const UINT32 avail = bufferFrames - padding;
            if (avail == 0) continue;
            BYTE* data = nullptr;
            if (FAILED(render->GetBuffer(avail, &data))) break;
            auto* out = reinterpret_cast<float*>(data);
            int pending = g_Pending.load();
            const bool starts = pending == g_FramesPerBeep.load() && pending > 0;
            for (UINT32 i = 0; i < avail; ++i) {
                float v = 0.0f;
                if (pending > 0) {
                    if (g_Noise) {
                        noise = noise * 1664525u + 1013904223u;
                        v = kAmplitude * (static_cast<float>(noise >> 8) / 8388608.0f - 1.0f);
                    } else {
                        v = kAmplitude * static_cast<float>(std::sin(phase));
                    }
                    phase += step;
                    --pending;
                } else {
                    phase = 0;
                }
                for (int c = 0; c < channels; ++c)
                    out[i * channels + c] = v;
            }
            g_Pending = pending;
            render->ReleaseBuffer(avail, 0);
            if (starts) {
                // The first tone sample plays after what was already queued.
                const long long nowUs = steadyUs();
                qInfo() << "[LatencyBeep] beep asked at steady" << g_AskedUs.load()
                        << "us, in the output buffer at steady" << nowUs << "us behind" << padding
                        << "queued frames (" << (padding * 1000.0 / rate) << "ms)";
            }
        }
        client->Stop();
    }
    if (render) render->Release();
    if (client) client->Release();
    if (device) device->Release();
    if (enumerator) enumerator->Release();
    if (fmt) CoTaskMemFree(fmt);
    CloseHandle(event);
    g_Ready = false;
    CoUninitialize();
}

} // namespace

namespace LatencyBeep {

bool start()
{
    std::lock_guard<std::mutex> lock(g_Mutex);
    if (g_Run) return g_Ready;
    if (g_Thread.joinable()) g_Thread.join();
    g_Run = true;
    g_Thread = std::thread(outputThread);
    // The flag's thread waits for the stream: a click right after start would
    // otherwise find no output to beep on.
    for (int i = 0; i < 100 && g_Run && !g_Ready; ++i)
        Sleep(10);
    return g_Ready;
}

void stop()
{
    std::lock_guard<std::mutex> lock(g_Mutex);
    g_Run = false;
    if (g_Thread.joinable()) g_Thread.join();
}

void beep()
{
    if (!g_Ready) return;
    g_AskedUs = steadyUs();
    g_Pending = g_FramesPerBeep.load();
}

} // namespace LatencyBeep

#else

namespace LatencyBeep {

bool start()
{
    qInfo() << "[LatencyBeep] the beep is implemented on Windows only";
    return false;
}

void stop() {}

void beep() {}

} // namespace LatencyBeep

#endif
