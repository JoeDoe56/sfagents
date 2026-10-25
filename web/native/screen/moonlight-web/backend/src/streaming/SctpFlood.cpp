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

#include "SctpFlood.h"

#include <rtc/rtc.hpp>
#include <QDebug>
#include <chrono>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

int64_t steadyNowUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

/// A one-millisecond tick. Windows sleeps a whole 15.6 ms timer period for a
/// sleep_for(1 ms) in a process that never asked for a finer one, which would
/// pace the flood in 15 ms bursts: a high-resolution waitable timer instead.
class Tick
{
public:
    Tick()
    {
#ifdef _WIN32
        m_Timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                         TIMER_ALL_ACCESS);
#endif
    }
    ~Tick()
    {
#ifdef _WIN32
        if (m_Timer) CloseHandle(m_Timer);
#endif
    }
    void wait()
    {
#ifdef _WIN32
        if (m_Timer) {
            LARGE_INTEGER due;
            due.QuadPart = -10'000; // 1 ms, relative, in 100 ns units
            if (SetWaitableTimerEx(m_Timer, &due, 0, nullptr, nullptr, nullptr, 0)) {
                WaitForSingleObject(m_Timer, 50);
                return;
            }
        }
#endif
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

private:
#ifdef _WIN32
    HANDLE m_Timer = nullptr;
#endif
};

} // namespace

SctpFlood::SctpFlood(std::shared_ptr<rtc::DataChannel> dc, int kbps, int bytes)
    : m_Dc(std::move(dc))
    , m_Kbps(kbps)
    , m_Bytes(bytes >= kHeaderBytes ? bytes : kDefaultBytes)
{}

SctpFlood::~SctpFlood()
{
    stop();
}

void SctpFlood::start()
{
    if (m_Started.exchange(true)) return;
    m_Thread = std::thread([this]() { run(); });
}

void SctpFlood::stop()
{
    m_Stop.store(true);
    if (m_Thread.joinable()) m_Thread.join();
}

void SctpFlood::writeHeader(uint8_t* out, uint32_t seq, uint64_t sendUs)
{
    out[0] = 'M';
    out[1] = 'W';
    out[2] = 'F';
    out[3] = 'L';
    for (int i = 0; i < 4; ++i)
        out[4 + i] = static_cast<uint8_t>(seq >> (24 - 8 * i));
    for (int i = 0; i < 8; ++i)
        out[8 + i] = static_cast<uint8_t>(sendUs >> (56 - 8 * i));
}

void SctpFlood::run()
{
    qInfo().noquote() << "[SctpFlood] sending" << m_Bytes << "byte messages"
                      << (m_Kbps < 0 ? QStringLiteral("as fast as SCTP takes them")
                                     : QStringLiteral("at %1 kbps").arg(m_Kbps));
    rtc::binary message(static_cast<size_t>(m_Bytes), std::byte{0});
    uint32_t seq = 0;
    // Paced: a budget of bytes, refilled each tick at the rate asked for.
    double budget = 0;
    const double bytesPerUs = m_Kbps > 0 ? m_Kbps * 1000.0 / 8.0 / 1e6 : 0;
    int64_t lastUs = steadyNowUs();
    int64_t windowStartUs = lastUs;
    uint64_t sentMsgs = 0, heldMsgs = 0;
    size_t peakBuffered = 0;
    Tick tick;
    while (!m_Stop.load()) {
        const int64_t nowUs = steadyNowUs();
        if (m_Kbps > 0) {
            budget += (nowUs - lastUs) * bytesPerUs;
            // Never more than a tenth of a second owed: a stall is not made up for.
            const double cap = bytesPerUs * 100'000;
            if (budget > cap) budget = cap;
        }
        lastUs = nowUs;
        // As fast as SCTP takes: as many as the backlog allows, bounded per tick
        // so the loop still checks the stop flag and the clock.
        int burst = 0;
        while (!m_Stop.load() && burst < 2000) {
            if (m_Kbps > 0 && budget < m_Bytes) break;
            if (!m_Dc || !m_Dc->isOpen()) {
                m_Stop.store(true);
                break;
            }
            const size_t buffered = m_Dc->bufferedAmount();
            if (buffered > peakBuffered) peakBuffered = buffered;
            if (buffered > kHoldBytes) {
                // Paced: this message is lost to the measure (held back), the
                // budget spent as if it had gone. Unpaced: wait for room.
                if (m_Kbps > 0) {
                    heldMsgs++;
                    budget -= m_Bytes;
                    continue;
                }
                break;
            }
            writeHeader(reinterpret_cast<uint8_t*>(message.data()), seq++,
                        static_cast<uint64_t>(steadyNowUs()));
            try {
                m_Dc->send(message);
            } catch (const std::exception& e) {
                qWarning() << "[SctpFlood] send error:" << e.what();
                m_Stop.store(true);
                break;
            }
            sentMsgs++;
            budget -= m_Bytes;
            burst++;
        }
        if (nowUs - windowStartUs >= 1'000'000) {
            const double seconds = (nowUs - windowStartUs) / 1e6;
            qInfo().noquote() << QStringLiteral("[SctpFlood] %1 msg/s, %2 kbps sent, %3 held back, "
                                                "backlog peak %4 KiB, seq %5")
                                     .arg(sentMsgs / seconds, 0, 'f', 0)
                                     .arg(sentMsgs * m_Bytes * 8.0 / 1000.0 / seconds, 0, 'f', 0)
                                     .arg(heldMsgs)
                                     .arg(peakBuffered / 1024)
                                     .arg(seq);
            windowStartUs = nowUs;
            sentMsgs = heldMsgs = 0;
            peakBuffered = 0;
        }
        tick.wait();
    }
    qInfo() << "[SctpFlood] stopped at seq" << seq;
}
