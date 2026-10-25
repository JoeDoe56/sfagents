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

#pragma once

#include "SendPacer.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace rtc {
class Track;
}

// The audio road's sender (POC Ultra U1.4 ter; plan « Wi-Fi », W4): the
// chunks of the frames sent on an Opus track, handed to libdatachannel at a
// paced rate by a thread of its own, instead of a frame's every chunk back to
// back from the capture thread.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// The road has neither SCTP's window nor Chrome's congestion control: a HEVC
// keyframe left as ~200 packets in one run. On a Mac in Wi-Fi (05/10/2026,
// 22:40), the kernel dropped 3,833 datagrams a pass for a full socket buffer,
// against 352 for SCTP, and the click went through 23 times out of 60. The
// pacing spreads a frame over a little of its interval; the other half of the
// answer is the rate governor, which hears of the road's resends with SCTP's
// retransmissions (DataChannelRelay, linkstats) and cuts the bitrate on them.
// W2 A is a warning: on SCTP, pacing alone did not lower the Mac's drops.
//
// ── What it gave (06/10/2026, W4 « after », a Mac in Wi-Fi, HEVC) ─────────
//
// Worse, as W2 A had warned: at 3x over the 50 Mbit/s floor, 693 to 5,011
// kernel drops a pass and 31-43 clicks out of 60; a frame in one run with the
// resends feeding the governor, 802-4,266 and 44-53 (before: 2,067-3,833 and
// 17-37). Chrome's socket fills when Chrome reads late. So it is off by
// default, a bench key (aroadpace=); only a rate well under what Chrome reads
// could help, and the governor's cut on the resends is what does.
//
// ── The rate ────────────────────────────────────────────────────────────────
//
// `multiple` times what the road carried over the last second, never under
// `floorBytesPerSecond`, in bursts of `burstBytes` at most. A resend asked by
// the page goes before what waits: it is the oldest data the page wants.
//
// ── The window (plan « Wi-Fi », W4; bench key aroadwin=) ───────────────────
//
// What SCTP has and the road lacked: an ack clock. The page names the last
// chunk it received (`aroadack`, a few times a frame); the chunks sent up to
// that one have left the network, delivered or lost. At most `windowBytes`
// stay in flight past it: when Chrome reads late, its acks stop and so does
// the host, instead of Chrome's socket overflowing in the kernel (W1 bis: no
// drop under ~48 KB in flight on the Mac). A page that never acks is never
// held, and an ack that stops for kStaleUs opens the window again. A delta
// frame held so long that a newer one waits behind it, none of its chunks
// sent yet, is dropped (the latest frame wins); the page sees the hole and
// asks for a keyframe, as for any frame it gives up on.
class AroadWindow
{
public:
    /// No ack for this long with the window full: it opens again.
    static constexpr int64_t kStaleUs = 150'000;
    /// The sends kept to place an ack.
    static constexpr size_t kKept = 4096;

    explicit AroadWindow(int64_t windowBytes)
        : m_Window(windowBytes)
    {}

    bool active() const { return m_Window > 0; }
    /// Bytes sent past the last chunk the page named.
    int64_t inFlight() const { return m_Sent - m_Acked; }
    int resets() const { return m_Resets; }

    /// One chunk sent: @p key = frame seq << 16 | index.
    void sent(uint32_t key, size_t bytes)
    {
        m_Sent += static_cast<int64_t>(bytes);
        m_Sends.push_back({key, m_Sent});
        if (m_Sends.size() > kKept) m_Sends.pop_front();
    }

    /// The page received the chunk @p key: what was sent up to its last send
    /// has left. A key no longer kept moves nothing.
    void acked(uint32_t key, int64_t nowUs)
    {
        for (auto it = m_Sends.rbegin(); it != m_Sends.rend(); ++it) {
            if (it->key != key) continue;
            if (it->offset > m_Acked) m_Acked = it->offset;
            break;
        }
        m_LastAckUs = nowUs;
        m_Heard = true;
    }

    /// Whether @p bytes more may leave now. The window full and no ack for
    /// kStaleUs: everything sent counts as gone, and they may.
    bool mayPass(size_t bytes, int64_t nowUs)
    {
        if (!active() || !m_Heard || inFlight() == 0) return true;
        if (inFlight() + static_cast<int64_t>(bytes) <= m_Window) return true;
        if (nowUs - m_LastAckUs >= kStaleUs) {
            m_Acked = m_Sent;
            m_LastAckUs = nowUs;
            ++m_Resets;
            return true;
        }
        return false;
    }

private:
    struct Send
    {
        uint32_t key;
        int64_t offset; // bytes sent once it left
    };
    const int64_t m_Window;
    int64_t m_Sent = 0;
    int64_t m_Acked = 0;
    int64_t m_LastAckUs = 0;
    bool m_Heard = false;
    int m_Resets = 0;
    std::deque<Send> m_Sends;
};

// The road's resend budget (plan « Wi-Fi », W4): resends at most `share` of
// the bytes first sent over the last kPeriodUs, never under `floorBytes`.
// The page's asks come when its socket overflows, and resending all it asks
// into that same full socket fed a storm on a Mac in Wi-Fi (06/10/2026:
// 23,000 chunks resent a pass, 14,053 kernel drops against 948-2,447). What
// the budget refuses is lost; the page gives up and asks for a keyframe.
class AroadResendBudget
{
public:
    static constexpr int64_t kPeriodUs = 100'000;

    AroadResendBudget(double share, int64_t floorBytes)
        : m_Share(share)
        , m_Floor(floorBytes)
    {}

    void sent(size_t bytes, int64_t nowUs)
    {
        roll(nowUs);
        m_Sent += static_cast<int64_t>(bytes);
    }

    /// Whether @p bytes may be resent now; counted when they may.
    bool mayResend(size_t bytes, int64_t nowUs)
    {
        roll(nowUs);
        const int64_t cap = (std::max)(
            m_Floor, static_cast<int64_t>(m_Share * static_cast<double>(m_Sent + m_PrevSent) / 2));
        if (m_Resent + static_cast<int64_t>(bytes) > cap) {
            ++m_Refused;
            return false;
        }
        m_Resent += static_cast<int64_t>(bytes);
        return true;
    }

    int64_t refused() const { return m_Refused; }

    /// The share, set before the road sends (bench key aroadbudget=).
    void setShare(double share) { m_Share = share; }

private:
    // Two periods: the cap follows the last full one and the one under way.
    void roll(int64_t nowUs)
    {
        if (m_StartUs == 0) m_StartUs = nowUs;
        while (nowUs - m_StartUs >= kPeriodUs) {
            m_PrevSent = m_Sent;
            m_Sent = 0;
            m_Resent = 0;
            m_StartUs += kPeriodUs;
            if (nowUs - m_StartUs >= kPeriodUs) {
                m_PrevSent = 0;
                m_StartUs = nowUs;
            }
        }
    }

    double m_Share;
    const int64_t m_Floor;
    int64_t m_StartUs = 0;
    int64_t m_Sent = 0, m_PrevSent = 0, m_Resent = 0;
    int64_t m_Refused = 0;
};

class AroadPacer
{
public:
    /// @p multiple 0 sends everything at once (no pacing). @p windowBytes 0:
    /// no window.
    AroadPacer(double multiple, int64_t floorBytesPerSecond, size_t burstBytes,
               int64_t windowBytes = 0);
    ~AroadPacer();

    AroadPacer(const AroadPacer&) = delete;
    AroadPacer& operator=(const AroadPacer&) = delete;

    /// Queue one chunk for @p track, with its RTP timestamp. @p resend: ahead
    /// of the queue.
    void send(std::shared_ptr<rtc::Track> track, std::vector<std::byte> chunk, uint32_t timestamp,
              bool resend);

    /// The rate the pacer runs at now, bytes per second (0: unpaced).
    int64_t rateBytesPerSecond() const { return m_Rate.load(std::memory_order_relaxed); }
    /// The longest a chunk waited in the queue over the pacer's life, in µs.
    int64_t maxQueueUs() const { return m_MaxQueueUs.load(std::memory_order_relaxed); }

    /// The page received the chunk @p index of frame @p seq (`aroadack`).
    void ack(uint16_t seq, uint16_t index);
    /// The window's figures: bytes in flight now, its resets for a silent
    /// page, the frames it dropped.
    int64_t inFlight();
    int windowResets();
    int droppedFrames() const { return m_Dropped.load(std::memory_order_relaxed); }

    struct Job
    {
        std::shared_ptr<rtc::Track> track;
        std::vector<std::byte> chunk;
        uint32_t timestamp = 0;
        int64_t queuedUs = 0;
        bool resend = false;
        uint16_t seq = 0, index = 0;
        bool keyframe = false;
    };

    /// The latest frame wins (pure: the tests'): from @p queue, every first
    /// send of a delta frame none of whose chunks has left (its chunk 0 still
    /// queued) and older than the newest frame queued. Returns the frames
    /// dropped.
    static int dropOlderFrames(std::deque<Job>& queue)
    {
        bool any = false;
        uint16_t newest = 0;
        for (const Job& j : queue)
            if (!j.resend) {
                newest = j.seq;
                any = true;
            }
        if (!any) return 0;
        std::vector<uint16_t> doomed;
        for (const Job& j : queue)
            if (!j.resend && !j.keyframe && j.index == 0 && j.seq != newest)
                doomed.push_back(j.seq);
        if (doomed.empty()) return 0;
        const auto isDoomed = [&doomed](const Job& j) {
            return !j.resend && std::find(doomed.begin(), doomed.end(), j.seq) != doomed.end();
        };
        queue.erase(std::remove_if(queue.begin(), queue.end(), isDoomed), queue.end());
        return static_cast<int>(doomed.size());
    }

    /// The rate for @p carriedBytesPerSecond (pure: the tests'). 0 when the
    /// multiple is 0.
    static int64_t rateFor(double multiple, int64_t floorBytesPerSecond,
                           int64_t carriedBytesPerSecond)
    {
        if (multiple <= 0) return 0;
        const int64_t paced =
            static_cast<int64_t>(multiple * static_cast<double>(carriedBytesPerSecond));
        return paced > floorBytesPerSecond ? paced : floorBytesPerSecond;
    }

private:
    /// The head of the queue held this long by the window: older frames go.
    static constexpr int64_t kDropAfterUs = 33'000;

    void run();
    void waitUs(int64_t us);

    const double m_Multiple;
    const int64_t m_Floor;
    const size_t m_Burst;
    std::mutex m_Mutex;
    std::condition_variable m_Cv;
    std::deque<Job> m_Queue;
    bool m_Stop = false;
    SendPacer m_Pacer;
    std::atomic<int64_t> m_Rate{0};
    std::atomic<int64_t> m_MaxQueueUs{0};
    int64_t m_WindowStartUs = 0;
    int64_t m_WindowBytes = 0;
    AroadWindow m_SendWindow; // under m_Mutex
    std::atomic<int> m_Dropped{0};
    void* m_Timer = nullptr; // a high-resolution waitable timer, on Windows
    std::thread m_Thread;
};
