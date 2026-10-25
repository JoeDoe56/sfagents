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

#include "ReferenceSlots.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

namespace mw::native::encode {

/// The decoded picture buffer of an HEVC encoder that is told, picture by
/// picture, what to reference and what to keep: D3D12 Video Encode, where the
/// application names the reconstructed pictures and the driver writes the
/// reference picture set it is given into each slice.
///
/// ── What is kept ────────────────────────────────────────────────────────────
///
/// The previous picture, always: the ordinary delta predicts from it. Then the
/// long-reach ones, marked every `stride` frames into `slots` (ReferenceSlots,
/// kReachMs): a loss reported up to 125 ms late still finds a picture from
/// before it. Every kept picture is listed in each slice's reference picture
/// set — HEVC forgets for good a picture the set leaves out — and exactly one
/// is used: the AMD iGPU takes a single L0 reference, and one is all a stream
/// that heals by reaching back needs. The three drivers of DualRTX keep a
/// listed-but-unused picture in the slice's set (26/09/2026).
///
/// ── A loss ──────────────────────────────────────────────────────────────────
///
/// Every picture from the lost frame on predicts from it, directly or not, so
/// the whole tail goes, not only the lost one — the VA-API rule. The next
/// picture predicts from the newest survivor; with none left, it is an IDR.
///
/// Pure bookkeeping, in two steps: plan() says what the next picture is, and
/// encoded() records it once the driver confirmed it — a picture that failed
/// never enters the buffer.
class HevcDpb
{
public:
    /// A picture of the buffer, as the next one sees it.
    struct Reference
    {
        int texture = -1;   ///< its reconstructed picture, an index in the pool
        uint32_t poc = 0;   ///< picture order count: pictures since the IDR
        uint32_t frame = 0; ///< the engine's frame number, what a loss report names
        bool used = false;  ///< predicted from: the L0 entry. The others are only kept.
    };

    /// What the next picture is.
    struct Plan
    {
        bool idr = false;
        uint32_t poc = 0;
        uint32_t frame = 0;
        int texture = -1; ///< where it is reconstructed: never a kept picture's
        /// Every picture kept, the one used first, then newest to oldest.
        std::vector<Reference> references;
    };

    /// @p capacity pictures kept at most — sps_max_dec_pic_buffering_minus1,
    /// within the driver's DPB and the level's: one is the previous picture,
    /// the others the long-reach slots, spread over kReachMs at @p fps.
    explicit HevcDpb(int capacity = 1, int fps = 60)
        : m_Capacity(std::clamp(capacity, 1, ReferenceSlots::kMaxSlots + 1))
        , m_Slots(m_Capacity - 1, ReferenceSlots::strideFor(fps, m_Capacity - 1))
    {}

    int capacity() const { return m_Capacity; }
    /// The reconstructed pictures to allocate: the kept ones and the one written.
    int textures() const { return m_Capacity + 1; }
    int slots() const { return m_Slots.count(); }
    int stride() const { return m_Slots.stride(); }
    /// How far back, in frames, a loss can be named and still be healed by a
    /// delta once the slots are full.
    int reachFrames() const { return m_Slots.enabled() ? m_Slots.reachFrames() : 1; }

    /// The next picture, for engine frame @p frame: an IDR when @p forceIdr,
    /// or when nothing is kept (the first picture, a loss out of reach).
    Plan plan(uint32_t frame, bool forceIdr) const
    {
        Plan p;
        p.frame = frame;
        std::vector<Picture> kept = held();
        p.idr = forceIdr || kept.empty();
        if (p.idr) {
            p.texture = 0; // an IDR empties the buffer: every texture is free
            return p;
        }
        p.poc = m_NextPoc;
        std::sort(kept.begin(), kept.end(),
                  [](const Picture& a, const Picture& b) { return a.poc > b.poc; });
        for (size_t i = 0; i < kept.size(); ++i)
            p.references.push_back({kept[i].texture, kept[i].poc, kept[i].frame, i == 0});
        for (int t = 0; t < textures() && p.texture < 0; ++t)
            if (std::none_of(kept.begin(), kept.end(),
                             [&](const Picture& k) { return k.texture == t; }))
                p.texture = t;
        return p;
    }

    /// The driver encoded @p p: it is the previous picture now, and marked
    /// into its slot when its turn has come — an IDR always is, so that a
    /// loss right after it still has somewhere to go.
    void encoded(const Plan& p)
    {
        if (p.idr) {
            m_Slots.clear();
            m_IdrFrame = p.frame;
        }
        const Picture now{p.texture, p.poc, p.frame, true};
        const int slot = m_Slots.slotFor(p.frame, p.idr);
        if (slot >= 0) {
            m_Slots.marked(slot, p.frame);
            m_InSlot[static_cast<size_t>(slot)] = now;
        }
        m_Previous = now;
        m_NextPoc = p.poc + 1;
    }

    /// Frame @p lostFrom never arrived: it and everything after it are
    /// dropped. False when nothing older is kept — the next picture is an IDR.
    /// A loss from before the last IDR drops nothing: the IDR predicts from
    /// nothing, and every kept picture comes after it.
    bool invalidate(uint32_t lostFrom)
    {
        if (lostFrom < m_IdrFrame) return !held().empty();
        m_Slots.dropFrom(lostFrom);
        if (m_Previous.valid && m_Previous.frame >= lostFrom) m_Previous = Picture{};
        return !held().empty();
    }

    /// Every picture kept, newest first — for a log line or a test.
    std::vector<Reference> kept() const
    {
        std::vector<Picture> pictures = held();
        std::sort(pictures.begin(), pictures.end(),
                  [](const Picture& a, const Picture& b) { return a.poc > b.poc; });
        std::vector<Reference> out;
        for (const Picture& k : pictures)
            out.push_back({k.texture, k.poc, k.frame, false});
        return out;
    }

    void reset()
    {
        m_Slots.clear();
        m_Previous = Picture{};
        m_NextPoc = 0;
        m_IdrFrame = 0;
    }

private:
    struct Picture
    {
        int texture = -1;
        uint32_t poc = 0;
        uint32_t frame = 0;
        bool valid = false;
    };

    /// The previous picture and the slots', each once: the previous one may
    /// sit in a slot as well.
    std::vector<Picture> held() const
    {
        std::vector<Picture> out;
        if (m_Previous.valid) out.push_back(m_Previous);
        for (int s = 0; s < m_Slots.count(); ++s) {
            if (!m_Slots.holds(s)) continue;
            const Picture& in = m_InSlot[static_cast<size_t>(s)];
            if (!(m_Previous.valid && m_Previous.frame == in.frame)) out.push_back(in);
        }
        return out;
    }

    int m_Capacity;
    ReferenceSlots m_Slots;
    std::array<Picture, ReferenceSlots::kMaxSlots> m_InSlot{};
    Picture m_Previous;
    uint32_t m_NextPoc = 0;
    uint32_t m_IdrFrame = 0;
};

} // namespace mw::native::encode
