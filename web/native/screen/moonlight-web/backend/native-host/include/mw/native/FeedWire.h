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

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <string>
#include <utility>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
//  The guests' shared feed, on the wire between two processes of one machine.
//
//  A native host's invited guests watch ONE stream, encoded once, by a worker of
//  its own (the "feed"); each guest's worker only carries it to its browser. The
//  feed reaches them over a local pipe (a named pipe on Windows, a Unix socket
//  elsewhere), and this is what travels on it: a fixed header, then a payload —
//  the encoder's bitstream, or a control message in JSON.
//
//  The header keeps the frame's own stamps (EncodedFrame: present, capture,
//  conversion, encode), so a guest's per-frame latency and its overlay's stages
//  still start at the display's present: the host's steady clock is the same
//  in both processes. The hop through the pipe counts in "queue".
//
//  Pure, and free of the pipe itself, so both ends and their tests share it.
// ─────────────────────────────────────────────────────────────────────────────

namespace mw::native::feed {

/// "MWF1", read as a little-endian word.
constexpr uint32_t kMagic = 0x3146574Du;
constexpr uint16_t kVersion = 1;

/// Fixed, and a multiple of 8 so the stamps sit aligned in a copy.
constexpr size_t kHeaderSize = 64;

/// The largest payload either end accepts. A 4K keyframe is 1-2 MB; anything
/// past this is a stream that has gone wrong, not a frame.
constexpr uint32_t kMaxPayload = 32u * 1024u * 1024u;

enum class Kind : uint8_t
{
    /// An encoded picture: Annex B (H.264, HEVC) or OBUs (AV1).
    Frame = 1,
    /// A control message, UTF-8 JSON with a "type" field: hello, info, idr,
    /// link, cursor, displayFormat, codec, bye.
    Control = 2,
};

struct Header
{
    Kind kind = Kind::Frame;
    bool keyframe = false;
    uint32_t payloadSize = 0;
    /// The feed's own number for the frame (EncodedFrame::frameNumber).
    uint32_t frameNumber = 0;
    /// EncodedFrame's stamps, µs on the host's steady clock; zero on a
    /// control message.
    int64_t presentUs = 0;
    int64_t capturedUs = 0;
    int64_t submittedUs = 0;
    int64_t convertedUs = 0;
    int64_t encodedUs = 0;
    /// When the feed handed the message to the pipe.
    int64_t publishedUs = 0;
};

namespace detail {

inline void put16(uint8_t* p, uint16_t v)
{
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
}
inline void put32(uint8_t* p, uint32_t v)
{
    for (int i = 0; i < 4; ++i)
        p[i] = static_cast<uint8_t>(v >> (8 * i));
}
inline void put64(uint8_t* p, int64_t v)
{
    const uint64_t u = static_cast<uint64_t>(v);
    for (int i = 0; i < 8; ++i)
        p[i] = static_cast<uint8_t>(u >> (8 * i));
}
inline uint16_t get16(const uint8_t* p)
{
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}
inline uint32_t get32(const uint8_t* p)
{
    uint32_t v = 0;
    for (int i = 3; i >= 0; --i)
        v = (v << 8) | p[i];
    return v;
}
inline int64_t get64(const uint8_t* p)
{
    uint64_t v = 0;
    for (int i = 7; i >= 0; --i)
        v = (v << 8) | p[i];
    return static_cast<int64_t>(v);
}

} // namespace detail

/// The header in its 64 bytes, little-endian whatever the machine:
///
///   0 magic  4 version  6 kind  7 flags (bit 0: keyframe)  8 payload size
///   12 frame number  16 present  24 captured  32 submitted  40 converted
///   48 encoded  56 published
inline void encodeHeader(const Header& h, uint8_t out[kHeaderSize])
{
    using namespace detail;
    put32(out + 0, kMagic);
    put16(out + 4, kVersion);
    out[6] = static_cast<uint8_t>(h.kind);
    out[7] = h.keyframe ? 1 : 0;
    put32(out + 8, h.payloadSize);
    put32(out + 12, h.frameNumber);
    put64(out + 16, h.presentUs);
    put64(out + 24, h.capturedUs);
    put64(out + 32, h.submittedUs);
    put64(out + 40, h.convertedUs);
    put64(out + 48, h.encodedUs);
    put64(out + 56, h.publishedUs);
}

enum class Parse
{
    Ok,
    /// Fewer than kHeaderSize bytes so far: read on.
    NeedMore,
    /// Not a header this build reads — the pipe is out of step, or the other
    /// end is not the feed. Nothing after it can be trusted: close.
    Bad,
};

/// Read a header off the front of @p size bytes. @p why says what was wrong
/// with a Bad one.
inline Parse decodeHeader(const uint8_t* data, size_t size, Header& out, std::string* why = nullptr)
{
    using namespace detail;
    if (size < kHeaderSize) return Parse::NeedMore;
    auto bad = [why](const char* reason) {
        if (why) *why = reason;
        return Parse::Bad;
    };
    if (get32(data) != kMagic) return bad("not the feed's magic");
    if (get16(data + 4) != kVersion) return bad("another version of the feed's wire");
    const uint8_t kind = data[6];
    if (kind != static_cast<uint8_t>(Kind::Frame) && kind != static_cast<uint8_t>(Kind::Control))
        return bad("an unknown kind of message");
    if (data[7] & ~1u) return bad("unknown flags");
    const uint32_t size32 = get32(data + 8);
    if (size32 > kMaxPayload) return bad("a payload larger than any frame");
    Header h;
    h.kind = static_cast<Kind>(kind);
    h.keyframe = (data[7] & 1u) != 0;
    if (h.kind == Kind::Control && h.keyframe) return bad("a control message marked keyframe");
    h.payloadSize = size32;
    h.frameNumber = get32(data + 12);
    h.presentUs = get64(data + 16);
    h.capturedUs = get64(data + 24);
    h.submittedUs = get64(data + 32);
    h.convertedUs = get64(data + 40);
    h.encodedUs = get64(data + 48);
    h.publishedUs = get64(data + 56);
    out = h;
    return Parse::Ok;
}

/// One message whole: header and payload, as the pipe carries it.
inline std::vector<uint8_t> message(const Header& h, const uint8_t* payload, size_t size)
{
    std::vector<uint8_t> out(kHeaderSize + size);
    Header copy = h;
    copy.payloadSize = static_cast<uint32_t>(size);
    encodeHeader(copy, out.data());
    if (size) std::copy(payload, payload + size, out.begin() + kHeaderSize);
    return out;
}

/// What one subscriber still has to be sent, when its pipe is slower than the
/// feed: "the freshest wins".
///
/// The feed never waits for a guest — a guest whose worker stopped reading
/// must not slow the capture of everyone else's picture, the owner's included.
/// So while a subscriber's pipe is backed up, what waits for it is kept small:
///
///  - a delta still waiting when a newer delta comes is replaced by it: that
///    guest's picture skips a frame, and the intra-refresh repairs the
///    reference it loses;
///  - a keyframe is never replaced by a delta — the deltas after it need it —
///    and a newer keyframe replaces every picture still waiting, itself
///    included: it needs nothing before it;
///  - control messages are never dropped, and keep their order with the
///    pictures around them.
///
/// Single-threaded: its owner locks around it.
class FreshestQueue
{
public:
    struct Item
    {
        std::vector<uint8_t> bytes; ///< one whole message
        Kind kind = Kind::Frame;
        bool keyframe = false;
    };

    /// A picture, as one whole message. Returns the pictures dropped for it.
    int pushFrame(std::vector<uint8_t> bytes, bool keyframe)
    {
        int dropped = 0;
        if (keyframe) {
            for (auto it = m_Items.begin(); it != m_Items.end();) {
                if (it->kind == Kind::Frame) {
                    it = m_Items.erase(it);
                    ++dropped;
                } else {
                    ++it;
                }
            }
        } else if (!m_Items.empty() && m_Items.back().kind == Kind::Frame &&
                   !m_Items.back().keyframe) {
            m_Items.pop_back();
            ++dropped;
        }
        m_Items.push_back(Item{std::move(bytes), Kind::Frame, keyframe});
        m_Dropped += dropped;
        return dropped;
    }

    void pushControl(std::vector<uint8_t> bytes)
    {
        m_Items.push_back(Item{std::move(bytes), Kind::Control, false});
    }

    bool empty() const { return m_Items.empty(); }
    size_t size() const { return m_Items.size(); }

    /// The next message to write, taken off the queue.
    Item take()
    {
        Item front = std::move(m_Items.front());
        m_Items.pop_front();
        return front;
    }

    /// Pictures dropped since this subscriber arrived.
    int64_t dropped() const { return m_Dropped; }

private:
    std::deque<Item> m_Items;
    int64_t m_Dropped = 0;
};

} // namespace mw::native::feed
