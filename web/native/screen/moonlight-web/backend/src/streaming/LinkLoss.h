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

#include <cstdint>

/// The bench's own losses on the video channel (EncoderTuning::lossPermille,
/// plan Idées Punktfunk, A0): messages thrown away before SCTP is handed them.
///
/// What a lossy link does to the RECEIVER — holes in frames, the recovery
/// that follows — with none of what it does to the SENDER: SCTP never sees
/// these losses, so its congestion window does not shrink and nothing is
/// retransmitted. That is the point: tc netem or the WinDivert shaper give
/// the whole picture, this key gives the receiver's half alone, the same on
/// every run (a fixed seed), on any client — an iPhone included.
///
/// A loss takes `burst` messages in a row, as a Wi-Fi fade does; the next
/// loss is drawn after the burst. Not thread-safe: one sender calls it.
class LinkLoss
{
public:
    /// @p permille in [0, 1000]: the chance each message STARTS a loss. 0 turns
    /// it off. @p burst: messages each loss takes, at least one.
    void configure(int permille, int burst)
    {
        m_Permille = permille < 0 ? 0 : (permille > 1000 ? 1000 : permille);
        m_Burst = burst < 1 ? 1 : burst;
        m_Left = 0;
    }

    bool active() const { return m_Permille > 0; }

    /// Whether the next message is thrown away.
    bool dropNext()
    {
        if (m_Left > 0) {
            m_Left--;
            m_Dropped++;
            return true;
        }
        if (m_Permille <= 0) return false;
        if (static_cast<int>(next() % 1000u) >= m_Permille) return false;
        m_Left = m_Burst - 1;
        m_Dropped++;
        m_Losses++;
        return true;
    }

    /// Messages thrown away so far, and the losses (bursts) they came in.
    uint64_t dropped() const { return m_Dropped; }
    uint64_t losses() const { return m_Losses; }

private:
    /// xorshift32: deterministic, the same sequence on every run.
    uint32_t next()
    {
        m_State ^= m_State << 13;
        m_State ^= m_State >> 17;
        m_State ^= m_State << 5;
        return m_State;
    }

    int m_Permille = 0;
    int m_Burst = 1;
    int m_Left = 0;
    uint32_t m_State = 0x9E3779B9u;
    uint64_t m_Dropped = 0;
    uint64_t m_Losses = 0;
};
