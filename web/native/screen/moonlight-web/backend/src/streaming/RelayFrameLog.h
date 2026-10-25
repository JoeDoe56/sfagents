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

#include "FrameSentSink.h"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>

// Each video frame's way through the relay, for the bench (`relaylog=1`; plan
// « Wi-Fi : la vidéo qui attend dans SCTP », W1).
//
// On Wi-Fi a click comes back as a flag 60 to 100 ms later, against 34 on
// Ethernet, while a frame's median age grows by a few milliseconds only. The
// question is where the flag's frame waited: before the relay, in the gate that
// drops every delta until a keyframe once the buffer stayed full, in the
// sender's queue, in libdatachannel's (`bufferedAmount`), or in usrsctp's own,
// which nothing here can see — what is left between the last fragment handed
// over and its arrival on the client.
//
// One record per frame the engine hands over, whatever became of it: its
// capture on the host's steady clock (the stamp the client's per-frame log
// carries, which is how a pass joins the two), when the relay got it, what it
// decided and with what in the buffer, when the sender put its first and last
// fragment into the DataChannel and what was buffered right after, and
// usrsctp's retransmission counters at that moment. Written as a CSV at the
// end of the session. Nothing of this runs unless the key asks for it.
class RelayFrameLog : public FrameSentSink
{
public:
    enum class Outcome : uint8_t
    {
        Pending,      ///< never decided: no open channel yet, or the session stopping
        Sent,         ///< queued for the sender under a wire id
        BacklogDrop,  ///< a delta dropped: the buffer stayed backed up too long
        NamedDrop,    ///< the same, and the encoder was told which frame
        Gated,        ///< a delta dropped while the relay awaited a keyframe
        KeyframeDrop, ///< a keyframe dropped: the buffer was still backed up
        Evicted,      ///< queued, then thrown out of the sender's full queue
        BenchLoss,    ///< every message thrown away by the bench's `loss=`
    };

    struct Sctp
    {
        uint32_t retrans = 0;
        uint32_t fast = 0;
        uint32_t t3 = 0;
    };

    struct Record
    {
        int64_t frameNumber = -1; ///< the engine's own number, -1 if it has none
        int64_t wireId = -1;      ///< the id it went out under, -1 if it never did
        bool key = false;
        uint32_t bytes = 0;
        int64_t captureUs = -1; ///< its present, the host's steady clock
        int64_t inUs = 0;       ///< handed to the relay
        int64_t firstUs = 0;    ///< sender: first fragment going in (0: never)
        int64_t lastUs = 0;     ///< sender: last fragment in
        Outcome outcome = Outcome::Pending;
        uint32_t buffered = 0;      ///< bufferedAmount at the decision
        int64_t bufferedAfter = -1; ///< bufferedAmount after the last fragment
        int32_t backlogMs = 0;      ///< how long the buffer had been backed up
        Sctp sctp;                  ///< usrsctp's counters when it came in
        int32_t srttMs = -1;        ///< SCTP's smoothed round trip, last sampled
    };

    explicit RelayFrameLog(size_t capacity = 1 << 16)
        : m_Records(capacity ? capacity : 1)
    {}

    /// The engine's own sink, still told of every frame sent.
    void setInner(FrameSentSink* inner)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        m_Inner = inner;
    }

    /// A frame handed to the relay. decide() and sent() name it again by its
    /// number: the relay makes them under its video mutex, one frame at a time,
    /// and a call about another frame (the keyframe kept for the channel's
    /// opening) leaves this record alone.
    void begin(int64_t frameNumber, bool key, size_t bytes, int64_t captureUs, int64_t inUs,
               Sctp sctp, int32_t srttMs)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        Record& r = m_Records[m_Count % m_Records.size()];
        r = Record{};
        r.frameNumber = frameNumber;
        r.key = key;
        r.bytes = static_cast<uint32_t>(bytes);
        r.captureUs = captureUs;
        r.inUs = inUs;
        r.sctp = sctp;
        r.srttMs = srttMs;
        m_Current = m_Count++;
        m_HaveCurrent = true;
        // A frame's worth, for the occupancy below: deltas only (a keyframe
        // is the exception the gate already allows for), a running mean.
        if (!key && bytes > 0)
            m_FrameBytes = m_FrameBytes <= 0 ? static_cast<double>(bytes)
                                             : m_FrameBytes + (bytes - m_FrameBytes) / 32.0;
    }

    /// What the relay decided for frame @p frameNumber, and the buffer it saw.
    void decide(int64_t frameNumber, Outcome outcome, size_t buffered, int64_t backlogMs,
                int64_t nowUs)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        noteOccupancy(buffered, nowUs);
        Record* current = currentLocked(frameNumber);
        if (!current) return;
        Record& r = *current;
        r.outcome = outcome;
        r.buffered = static_cast<uint32_t>(buffered);
        r.backlogMs = static_cast<int32_t>(backlogMs);
    }

    /// Frame @p frameNumber went to the sender under @p wireId.
    void sent(int64_t frameNumber, uint32_t wireId)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        if (Record* r = currentLocked(frameNumber)) {
            r->outcome = Outcome::Sent;
            r->wireId = wireId;
        }
    }

    /// The sender threw a queued frame out (its engine number).
    void evicted(uint32_t frameNumber)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        if (Record* r = findLocked(frameNumber)) r->outcome = Outcome::Evicted;
    }

    /// What libdatachannel holds right after a frame's last fragment, read on
    /// the sender thread: 0 means usrsctp took the whole frame.
    void setBufferedProbe(size_t (*probe)(void*), void* ctx)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        m_Probe = probe;
        m_ProbeCtx = ctx;
    }

    void frameSent(uint32_t frameNumber, int64_t firstByteUs, int64_t lastByteUs) override
    {
        FrameSentSink* inner = nullptr;
        {
            std::lock_guard<std::mutex> lk(m_Mutex);
            inner = m_Inner;
            if (Record* r = findLocked(frameNumber)) {
                r->firstUs = firstByteUs;
                r->lastUs = lastByteUs;
                if (m_Probe) r->bufferedAfter = static_cast<int64_t>(m_Probe(m_ProbeCtx));
            }
        }
        if (inner) inner->frameSent(frameNumber, firstByteUs, lastByteUs);
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
        const size_t n = m_Count < m_Records.size() ? m_Count : m_Records.size();
        out.reserve(n);
        for (size_t i = m_Count - n; i < m_Count; ++i)
            out.push_back(m_Records[i % m_Records.size()]);
        return out;
    }

    /// The share of the time `bufferedAmount` stood above 1, 2 and 4 frames'
    /// worth (a frame being the running mean of the deltas), in percent.
    void occupancy(double& above1, double& above2, double& above4) const
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        const double total = static_cast<double>(m_TotalUs);
        above1 = total > 0 ? 100.0 * m_Above1Us / total : 0;
        above2 = total > 0 ? 100.0 * m_Above2Us / total : 0;
        above4 = total > 0 ? 100.0 * m_Above4Us / total : 0;
    }

    double frameBytes() const
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        return m_FrameBytes;
    }

    static const char* name(Outcome o)
    {
        switch (o) {
        case Outcome::Pending: return "pending";
        case Outcome::Sent: return "sent";
        case Outcome::BacklogDrop: return "backlog";
        case Outcome::NamedDrop: return "named";
        case Outcome::Gated: return "gated";
        case Outcome::KeyframeDrop: return "keydrop";
        case Outcome::Evicted: return "evicted";
        case Outcome::BenchLoss: return "benchloss";
        }
        return "?";
    }

    /// One line for the log: what became of the frames, and the occupancy.
    std::string summary() const
    {
        const std::vector<Record> rs = records();
        size_t n[8] = {};
        for (const Record& r : rs)
            ++n[static_cast<size_t>(r.outcome)];
        double a1 = 0, a2 = 0, a4 = 0;
        occupancy(a1, a2, a4);
        char line[400];
        std::snprintf(line, sizeof line,
                      "%zu frames: %zu sent, %zu dropped by the backlog (%zu named), %zu gated "
                      "awaiting a keyframe, %zu keyframes dropped, %zu evicted, %zu lost by the "
                      "bench, %zu before any channel; bufferedAmount above 1 / 2 / 4 frames "
                      "%.1f / %.1f / %.1f %% of the time (a frame is %.1f KB)",
                      rs.size(), n[1], n[2] + n[3], n[3], n[4], n[5], n[6], n[7], n[0], a1, a2, a4,
                      frameBytes() / 1024.0);
        return line;
    }

    static const char* csvHeader()
    {
        return "frame,wire,key,bytes,captureUs,inUs,firstUs,lastUs,outcome,buffered,"
               "bufferedAfter,backlogMs,retrans,fast,t3,srttMs";
    }

    /// The records as CSV, header first.
    bool writeCsv(const std::string& path) const
    {
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return false;
        std::fprintf(f, "%s\n", csvHeader());
        for (const Record& r : records()) {
            std::fprintf(f, "%lld,%lld,%d,%u,%lld,%lld,%lld,%lld,%s,%u,%lld,%d,%u,%u,%u,%d\n",
                         static_cast<long long>(r.frameNumber), static_cast<long long>(r.wireId),
                         r.key ? 1 : 0, r.bytes, static_cast<long long>(r.captureUs),
                         static_cast<long long>(r.inUs), static_cast<long long>(r.firstUs),
                         static_cast<long long>(r.lastUs), name(r.outcome), r.buffered,
                         static_cast<long long>(r.bufferedAfter), r.backlogMs, r.sctp.retrans,
                         r.sctp.fast, r.sctp.t3, r.srttMs);
        }
        return std::fclose(f) == 0;
    }

private:
    // Called with m_Mutex held: the record begin() opened, if it is that frame's.
    Record* currentLocked(int64_t frameNumber)
    {
        if (!m_HaveCurrent) return nullptr;
        Record& r = m_Records[m_Current % m_Records.size()];
        return r.frameNumber == frameNumber ? &r : nullptr;
    }

    // Called with m_Mutex held.
    Record* findLocked(uint32_t frameNumber)
    {
        // The frame is among the last few handed over: the sender's queue is
        // short. Bounded, so a number that never came costs little.
        const size_t span = m_Count < 512 ? m_Count : 512;
        for (size_t i = 0; i < span; ++i) {
            Record& r = m_Records[(m_Count - 1 - i) % m_Records.size()];
            if (r.frameNumber == static_cast<int64_t>(frameNumber)) return &r;
        }
        return nullptr;
    }

    // The time since the last sample is put on the level that sample saw.
    void noteOccupancy(size_t buffered, int64_t nowUs)
    {
        if (m_LastSampleUs > 0 && nowUs > m_LastSampleUs) {
            const int64_t dt = nowUs - m_LastSampleUs;
            m_TotalUs += dt;
            if (m_LastFrames > 1.0) m_Above1Us += dt;
            if (m_LastFrames > 2.0) m_Above2Us += dt;
            if (m_LastFrames > 4.0) m_Above4Us += dt;
        }
        m_LastSampleUs = nowUs;
        m_LastFrames = m_FrameBytes > 0 ? static_cast<double>(buffered) / m_FrameBytes : 0;
    }

    mutable std::mutex m_Mutex;
    std::vector<Record> m_Records;
    size_t m_Count = 0;
    size_t m_Current = 0;
    bool m_HaveCurrent = false;
    FrameSentSink* m_Inner = nullptr;
    size_t (*m_Probe)(void*) = nullptr;
    void* m_ProbeCtx = nullptr;
    double m_FrameBytes = 0;
    int64_t m_LastSampleUs = 0;
    double m_LastFrames = 0;
    int64_t m_TotalUs = 0;
    int64_t m_Above1Us = 0;
    int64_t m_Above2Us = 0;
    int64_t m_Above4Us = 0;
};
