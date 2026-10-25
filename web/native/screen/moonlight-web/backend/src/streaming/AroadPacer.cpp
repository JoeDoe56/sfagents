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

#include "AroadPacer.h"

#include <rtc/rtc.hpp>

#include <algorithm>
#include <chrono>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

int64_t steadyNowUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

} // namespace

AroadPacer::AroadPacer(double multiple, int64_t floorBytesPerSecond, size_t burstBytes,
                       int64_t windowBytes)
    : m_Multiple(multiple)
    , m_Floor((std::max<int64_t>)(floorBytesPerSecond, 1))
    , m_Burst((std::max<size_t>)(burstBytes, 1))
    , m_SendWindow((std::max<int64_t>)(windowBytes, 0))
{
    const int64_t rate = rateFor(m_Multiple, m_Floor, 0);
    m_Pacer.configure(rate, m_Burst);
    m_Rate.store(rate, std::memory_order_relaxed);
    m_Thread = std::thread([this]() { run(); });
}

AroadPacer::~AroadPacer()
{
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        m_Stop = true;
    }
    m_Cv.notify_all();
    if (m_Thread.joinable()) m_Thread.join();
}

void AroadPacer::send(std::shared_ptr<rtc::Track> track, std::vector<std::byte> chunk,
                      uint32_t timestamp, bool resend)
{
    Job job{std::move(track), std::move(chunk), timestamp, steadyNowUs(), resend};
    // The chunk's header (DataChannelRelay::sendAudioRoad): 'M', flags,
    // frame seq, index.
    if (job.chunk.size() >= 6) {
        const auto b = [&job](size_t i) { return static_cast<unsigned>(job.chunk[i]); };
        job.keyframe = (b(1) & 1) != 0;
        job.seq = static_cast<uint16_t>(b(2) << 8 | b(3));
        job.index = static_cast<uint16_t>(b(4) << 8 | b(5));
    }
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        if (m_Stop) return;
        if (resend)
            m_Queue.push_front(std::move(job));
        else
            m_Queue.push_back(std::move(job));
    }
    m_Cv.notify_one();
}

void AroadPacer::ack(uint16_t seq, uint16_t index)
{
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        m_SendWindow.acked(static_cast<uint32_t>(seq) << 16 | index, steadyNowUs());
    }
    m_Cv.notify_one();
}

int64_t AroadPacer::inFlight()
{
    std::lock_guard<std::mutex> lk(m_Mutex);
    return m_SendWindow.inFlight();
}

int AroadPacer::windowResets()
{
    std::lock_guard<std::mutex> lk(m_Mutex);
    return m_SendWindow.resets();
}

void AroadPacer::waitUs(int64_t us)
{
    if (us <= 0) return;
#ifdef _WIN32
    // Not sleep_for: in a process that never asked for a finer timer, Windows
    // sleeps a whole 15.6 ms period for a sleep of 0.7 ms (FrameSender.cpp).
    if (m_Timer) {
        LARGE_INTEGER due;
        due.QuadPart = -us * 10; // relative, in 100 ns units
        if (SetWaitableTimerEx(static_cast<HANDLE>(m_Timer), &due, 0, nullptr, nullptr, nullptr,
                               0)) {
            WaitForSingleObject(static_cast<HANDLE>(m_Timer), static_cast<DWORD>(us / 1000 + 50));
            return;
        }
    }
#endif
    std::this_thread::sleep_for(std::chrono::microseconds(us));
}

void AroadPacer::run()
{
#ifdef _WIN32
    m_Timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                     TIMER_ALL_ACCESS);
#endif
    for (;;) {
        Job job;
        {
            std::unique_lock<std::mutex> lk(m_Mutex);
            m_Cv.wait(lk, [this]() { return m_Stop || !m_Queue.empty(); });
            // The window: wait for the page's acks. A delta frame waiting
            // longer than kDropAfterUs with a newer one behind it goes.
            while (!m_Stop && !m_Queue.empty() &&
                   !m_SendWindow.mayPass(m_Queue.front().chunk.size(), steadyNowUs())) {
                if (steadyNowUs() - m_Queue.front().queuedUs >= kDropAfterUs) {
                    const int dropped = dropOlderFrames(m_Queue);
                    if (dropped) m_Dropped.fetch_add(dropped, std::memory_order_relaxed);
                    if (m_Queue.empty()) break;
                }
                m_Cv.wait_for(lk, std::chrono::milliseconds(2));
            }
            if (m_Stop) break;
            if (m_Queue.empty()) continue;
            job = std::move(m_Queue.front());
            m_Queue.pop_front();
        }
        const size_t bytes = job.chunk.size();
        int64_t now = steadyNowUs();
        // Once a second: the rate follows what the road carried.
        if (m_WindowStartUs == 0) m_WindowStartUs = now;
        if (now - m_WindowStartUs >= 1'000'000) {
            const int64_t carried = m_WindowBytes * 1'000'000 / (now - m_WindowStartUs);
            const int64_t rate = rateFor(m_Multiple, m_Floor, carried);
            if (rate != m_Pacer.bytesPerSecond()) m_Pacer.configure(rate, m_Burst);
            m_Rate.store(rate, std::memory_order_relaxed);
            m_WindowStartUs = now;
            m_WindowBytes = 0;
        }
        for (int64_t w = m_Pacer.waitUs(bytes, now); w > 0; w = m_Pacer.waitUs(bytes, now)) {
            waitUs(w);
            now = steadyNowUs();
            std::lock_guard<std::mutex> lk(m_Mutex);
            if (m_Stop) break;
        }
        const int64_t queued = now - job.queuedUs;
        if (queued > m_MaxQueueUs.load(std::memory_order_relaxed))
            m_MaxQueueUs.store(queued, std::memory_order_relaxed);
        m_Pacer.sent(bytes, now);
        {
            std::lock_guard<std::mutex> lk(m_Mutex);
            m_SendWindow.sent(static_cast<uint32_t>(job.seq) << 16 | job.index, bytes);
        }
        m_WindowBytes += static_cast<int64_t>(bytes);
        try {
            if (job.track && job.track->isOpen())
                job.track->sendFrame(job.chunk.data(), job.chunk.size(),
                                     rtc::FrameInfo(job.timestamp));
        } catch (...) {
            // A track closing under the session: what is left goes nowhere.
        }
    }
#ifdef _WIN32
    if (m_Timer) CloseHandle(static_cast<HANDLE>(m_Timer));
    m_Timer = nullptr;
#endif
}
