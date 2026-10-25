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

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

// Each audio packet's way through the host, for the bench (`audiolog=1`; plan
// « le son et la priorité des paquets », A0).
//
// The host's share of a sound's latency has never been measured: the pacer's
// queue (up to 20 ms of captured sound behind the frame going out on Windows,
// 40 on macOS and Linux), then the relay, where every 5 ms packet crosses the
// relay thread's event loop as a queued signal while video goes direct. This
// log puts a time on each step.
//
// Two ends, one packet at a time:
// - the native engine says what it emitted — the pacer's tick (the packet's
//   `capturedUs`), when the signal left, how much sound still waited in the
//   pacer, the frame's peak (where a test tone starts) and whether the pacer
//   sent silence;
// - the relay says when the packet reached its thread and when the RTP track
//   took it.
// The queued signal keeps its order, so the relay's n-th packet is the
// engine's n-th: the two halves are paired first in, first out. A packet the
// engine never named (a GameStream session) keeps -1 on the engine's side.
//
// One worker process carries one session, so the log is process-wide. Nothing
// of this runs unless the key asks for it.
class AudioPathLog
{
public:
    enum class Outcome : uint8_t
    {
        Pending,  ///< emitted, never reached the relay (the session stopping)
        Sent,     ///< the RTP track took it
        NotReady, ///< dropped: the audio track was not open
        Error,    ///< the track threw
    };

    struct Record
    {
        int64_t capturedUs = -1; ///< the pacer's tick, the host's steady clock
        int64_t emitUs = -1;     ///< the engine emitted the signal
        int32_t queued = -1;     ///< frames left in the pacer's queue
        float peak = -1.0f;      ///< the frame's peak, 0..1
        bool silence = false;    ///< the pacer sent silence (an underrun)
        uint32_t bytes = 0;
        int64_t inUs = 0;   ///< reached the relay's thread
        int64_t sentUs = 0; ///< the RTP track took it (0: never)
        Outcome outcome = Outcome::Pending;
        uint32_t rtpTs = 0;
    };

    /// The process's own, which the engine and the relay share.
    static AudioPathLog& instance()
    {
        static AudioPathLog log;
        return log;
    }

    explicit AudioPathLog(size_t capacity = size_t(1) << 17)
        : m_Capacity(capacity ? capacity : 1)
    {}

    /// Starts keeping records (anew); the engine's side checks enabled().
    void start()
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        m_Records.assign(m_Capacity, Record{});
        m_Count = 0;
        m_Pending.clear();
        m_Unpaired = 0;
        m_On.store(true, std::memory_order_release);
    }

    void stop() { m_On.store(false, std::memory_order_release); }

    bool enabled() const { return m_On.load(std::memory_order_acquire); }

    /// The engine emitted a packet. Kept until the relay names it.
    void emitted(int64_t capturedUs, int64_t emitUs, int queued, float peak, bool silence,
                 size_t bytes)
    {
        if (!enabled()) return;
        std::lock_guard<std::mutex> lk(m_Mutex);
        Record r;
        r.capturedUs = capturedUs;
        r.emitUs = emitUs;
        r.queued = queued;
        r.peak = peak;
        r.silence = silence;
        r.bytes = static_cast<uint32_t>(bytes);
        // A relay that never takes them (another transport) must not grow
        // this without end: past a second of packets, the oldest goes.
        if (m_Pending.size() >= kMaxPending) {
            m_Pending.pop_front();
            ++m_Unpaired;
        }
        m_Pending.push_back(r);
    }

    /// The relay handled the next packet: when it reached its thread, when
    /// the track took it, and what became of it.
    void relayed(size_t bytes, int64_t inUs, int64_t sentUs, Outcome outcome, uint32_t rtpTs)
    {
        if (!enabled()) return;
        std::lock_guard<std::mutex> lk(m_Mutex);
        Record r;
        if (!m_Pending.empty()) {
            r = m_Pending.front();
            m_Pending.pop_front();
        }
        r.bytes = static_cast<uint32_t>(bytes);
        r.inUs = inUs;
        r.sentUs = sentUs;
        r.outcome = outcome;
        r.rtpTs = rtpTs;
        m_Records[m_Count % m_Records.size()] = r;
        ++m_Count;
    }

    size_t count() const
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        return m_Count;
    }

    /// The records still held, oldest first.
    std::vector<Record> records() const
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        std::vector<Record> out;
        if (m_Records.empty()) return out;
        const size_t n = m_Count < m_Records.size() ? m_Count : m_Records.size();
        out.reserve(n);
        for (size_t i = m_Count - n; i < m_Count; ++i)
            out.push_back(m_Records[i % m_Records.size()]);
        return out;
    }

    static const char* name(Outcome o)
    {
        switch (o) {
        case Outcome::Pending: return "pending";
        case Outcome::Sent: return "sent";
        case Outcome::NotReady: return "notready";
        case Outcome::Error: return "error";
        }
        return "?";
    }

    /// The value at fraction @p q (0..1) of @p v, sorted in place; -1 if empty.
    static double quantile(std::vector<double>& v, double q)
    {
        if (v.empty()) return -1.0;
        std::sort(v.begin(), v.end());
        const size_t i = static_cast<size_t>(q * static_cast<double>(v.size() - 1) + 0.5);
        return v[std::min(i, v.size() - 1)];
    }

    /// One line for the log: what became of the packets, and where they waited.
    std::string summary() const
    {
        const std::vector<Record> rs = records();
        size_t sent = 0, notReady = 0, error = 0, silence = 0, named = 0;
        std::vector<double> hop, host, gap;
        double queuedSum = 0;
        int queuedMax = -1;
        int64_t lastSent = 0;
        for (const Record& r : rs) {
            if (r.outcome == Outcome::Sent) ++sent;
            if (r.outcome == Outcome::NotReady) ++notReady;
            if (r.outcome == Outcome::Error) ++error;
            if (r.silence) ++silence;
            if (r.emitUs >= 0) {
                ++named;
                hop.push_back((r.inUs - r.emitUs) / 1000.0);
                if (r.sentUs > 0 && r.capturedUs >= 0)
                    host.push_back((r.sentUs - r.capturedUs) / 1000.0);
            }
            if (r.queued >= 0) {
                queuedSum += r.queued;
                queuedMax = std::max(queuedMax, static_cast<int>(r.queued));
            }
            if (r.sentUs > 0) {
                if (lastSent > 0) gap.push_back((r.sentUs - lastSent) / 1000.0);
                lastSent = r.sentUs;
            }
        }
        const double queuedMean = named > 0 ? queuedSum / static_cast<double>(named) : -1.0;
        size_t unpaired = 0;
        {
            std::lock_guard<std::mutex> lk(m_Mutex);
            unpaired = m_Unpaired + m_Pending.size();
        }
        char line[512];
        std::snprintf(
            line, sizeof line,
            "%zu packets: %zu sent, %zu track not open, %zu errors, %zu silence; engine -> relay "
            "thread p50 %.2f / p99 %.2f / max %.2f ms; pacer tick -> sent p50 %.2f / p99 %.2f ms; "
            "pacer queue mean %.2f / max %d frames; gap between sends p99 %.2f / max %.2f ms; %zu "
            "never paired",
            rs.size(), sent, notReady, error, silence, quantile(hop, 0.5), quantile(hop, 0.99),
            quantile(hop, 1.0), quantile(host, 0.5), quantile(host, 0.99), queuedMean, queuedMax,
            quantile(gap, 0.99), quantile(gap, 1.0), unpaired);
        return line;
    }

    static const char* csvHeader()
    {
        return "capturedUs,emitUs,queued,peak,silence,bytes,inUs,sentUs,outcome,rtpTs";
    }

    /// The records as CSV, header first.
    bool writeCsv(const std::string& path) const
    {
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return false;
        std::fprintf(f, "%s\n", csvHeader());
        for (const Record& r : records()) {
            std::fprintf(f, "%lld,%lld,%d,%.4f,%d,%u,%lld,%lld,%s,%u\n",
                         static_cast<long long>(r.capturedUs), static_cast<long long>(r.emitUs),
                         r.queued, static_cast<double>(r.peak), r.silence ? 1 : 0, r.bytes,
                         static_cast<long long>(r.inUs), static_cast<long long>(r.sentUs),
                         name(r.outcome), r.rtpTs);
        }
        return std::fclose(f) == 0;
    }

private:
    /// A second of packets at 5 ms.
    static constexpr size_t kMaxPending = 200;

    mutable std::mutex m_Mutex;
    std::atomic<bool> m_On{false};
    const size_t m_Capacity;
    std::vector<Record> m_Records;
    size_t m_Count = 0;
    std::deque<Record> m_Pending;
    size_t m_Unpaired = 0;
};
