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

#include <cmath>
#include <cstdint>
#include <mutex>

namespace mw::native {

/// cadence=deadline (plan framerate-hote §13, Bruno's idea): one frame per
/// refresh of the client's screen, the freshest that can still make it.
///
/// ── Why ─────────────────────────────────────────────────────────────────────
///
/// A screen shows a new picture once per refresh. A host whose display runs
/// faster than the client's — a virtual display at 240 or 500 Hz — has
/// several pictures to offer per client refresh, and only one of them can be
/// shown. Sending all of them (cadence=host) lets the client take the
/// freshest, at the price of decoding every one; sending on a grid of its own
/// (today's gate) decodes one each, but lands it anywhere in the refresh and
/// wastes half of one on average. Aimed at the refresh, one frame is enough.
///
/// ── The grid ────────────────────────────────────────────────────────────────
///
/// The client (frontend VsyncGrid.js) sends, every 500 ms, its refresh period,
/// one refresh on this host's steady clock, and its lead: how long a frame
/// takes from being taken here to being ready there (drawn when its canvas
/// tears, decoded on vsync), with a margin it widens on every miss. For the
/// refresh R, the picture must be taken at R − lead: whatever the display
/// last presented by then is the freshest that can make it, and taking it
/// later could not. The loop sleeps until that instant, takes what is there,
/// and encodes it at once; nothing new, nothing sent.
///
/// The lead is counted from the moment the picture is TAKEN, not from its
/// own present, and the frames aimed this way carry that moment as their
/// capture time: a game at 60 fps on a 240 Hz display leaves its last present
/// up to 16 ms behind the instant, and a lead that counted it would move
/// every instant earlier for nothing.
///
/// ── A client that tears ─────────────────────────────────────────────────────
///
/// A canvas that tears shows a frame the moment it is drawn, on the lines the
/// scan has not reached yet: there is no refresh to aim at, and any wait here
/// is lost on every line — a game at 50 frames a second on a 60 Hz screen
/// would pay half a refresh for nothing (Bruno's cases, 30/09). Such a client
/// says so (`tearing`) with a budget, the frames a second it takes; the loop
/// then sends each new picture as it comes, through a gate at that budget
/// that skips and never holds.
///
/// ── A link too uneven to aim through ────────────────────────────────────────
///
/// Aiming needs the frames to arrive when the lead says. Over a link whose
/// capture → ready wanders by more than half a refresh (an N95 on Wi-Fi at
/// 60 Hz: 40 to 60 ms, 11 to 22 % of the refreshes missed, 35 drawn a second
/// instead of 50 — plan §13, P3), no margin holds, and the frames aimed one
/// per refresh pile up two in one and none in the next. The client then says
/// its link is not `steady`, and the loop sends each picture as it comes, as
/// for a canvas that tears — today's cadence, and the client keeps the
/// reserve it would drop for aimed frames.
///
/// ── Staleness ───────────────────────────────────────────────────────────────
///
/// A grid not heard for kStaleUs is dropped and the loop goes back to the
/// cadence it had; so is one that makes no sense (a period outside 10 to
/// 500 Hz, a lead of more than half a second, a refresh far from now).
///
/// Pure and clocked by the caller; note() from the thread that reads the
/// control channel, the rest from the capture loop.
class DeadlineCadence
{
public:
    /// A grid not heard again for this long no longer holds.
    static constexpr int64_t kStaleUs = 2000 * 1000;
    /// How far past its instant a refresh is still aimed at: a wake-up that
    /// came late by less than this still has the client's margin to spend.
    static constexpr int64_t kLateUs = 1000;
    /// What a page may say.
    static constexpr double kMinPeriodUs = 2000.0;
    static constexpr double kMaxPeriodUs = 100000.0;
    static constexpr int64_t kMaxLeadUs = 500 * 1000;
    static constexpr int64_t kMaxPhaseAwayUs = 10 * 1000 * 1000;
    static constexpr double kMaxBudgetFps = 1000.0;

    /// The refresh aimed at, and the instant its picture is taken.
    struct Aim
    {
        int64_t captureUs = 0;
        int64_t refreshUs = 0;
        bool valid() const { return refreshUs != 0; }
    };

    /// The client refreshes every @p periodUs, one refresh at @p phaseUs (this
    /// host's steady clock), a frame needing @p leadUs to be ready; its canvas
    /// @p tearing or not, its link @p steady enough to aim through or not,
    /// taking @p budgetFps frames a second when frames go as they come (0: one
    /// per refresh) — heard at @p nowUs. False, and nothing kept, for a grid
    /// that makes no sense.
    bool note(double periodUs, int64_t phaseUs, int64_t leadUs, bool tearing, bool steady,
              double budgetFps, int64_t nowUs)
    {
        if (!(periodUs >= kMinPeriodUs && periodUs <= kMaxPeriodUs)) return false;
        if (leadUs <= 0 || leadUs > kMaxLeadUs) return false;
        if (phaseUs < nowUs - kMaxPhaseAwayUs || phaseUs > nowUs + kMaxPhaseAwayUs) return false;
        if (!(budgetFps > 0 && budgetFps <= kMaxBudgetFps)) budgetFps = 1000000.0 / periodUs;
        std::lock_guard<std::mutex> lock(m_Mutex);
        m_PeriodUs = periodUs;
        m_PhaseUs = phaseUs;
        m_LeadUs = leadUs;
        m_Tearing = tearing;
        m_Steady = steady;
        m_BudgetFps = budgetFps;
        m_HeardUs = nowUs;
        m_Heard = true;
        m_Grids++;
        return true;
    }

    /// True while the last grid is younger than kStaleUs at @p nowUs.
    bool fresh(int64_t nowUs) const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return freshLocked(nowUs);
    }

    /// True while the last grid, fresh, is a canvas that tears or a link too
    /// uneven to aim through: nothing is aimed, each new picture goes at once
    /// under budgetFps().
    bool asItComes(int64_t nowUs) const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return freshLocked(nowUs) && (m_Tearing || !m_Steady);
    }

    /// Why, of the last grid: its canvas tears (else its link is uneven).
    bool tearing() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_Tearing;
    }

    /// The frames a second a client takes when frames go as they come.
    double budgetFps() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_BudgetFps;
    }

    /// The refresh to aim at next from @p nowUs: the first whose instant is
    /// no more than kLateUs behind, after the one served last. Invalid while
    /// the grid is not fresh, or frames go as they come.
    Aim next(int64_t nowUs) const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        if (!freshLocked(nowUs) || m_Tearing || !m_Steady) return {};
        const double from =
            static_cast<double>(nowUs - kLateUs + m_LeadUs - m_PhaseUs) / m_PeriodUs;
        auto refreshAt = [this](int64_t n) {
            return m_PhaseUs +
                   static_cast<int64_t>(std::llround(static_cast<double>(n) * m_PeriodUs));
        };
        int64_t n = static_cast<int64_t>(std::ceil(from));
        int64_t refresh = refreshAt(n);
        // A refresh served already — the phase re-anchors every grid, so it is
        // told by its time, not by its number.
        while (m_ServedUs != 0 && refresh <= m_ServedUs + static_cast<int64_t>(m_PeriodUs / 2))
            refresh = refreshAt(++n);
        return Aim{refresh - m_LeadUs, refresh};
    }

    /// The picture for @p aim was taken (whether or not anything was new).
    void served(const Aim& aim)
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        m_ServedUs = aim.refreshUs;
    }

    /// Grids heard, for the log.
    int64_t grids() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_Grids;
    }

    /// The last grid's period and lead, µs, for the log.
    double periodUs() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_PeriodUs;
    }
    int64_t leadUs() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_LeadUs;
    }

private:
    bool freshLocked(int64_t nowUs) const { return m_Heard && nowUs - m_HeardUs < kStaleUs; }

    mutable std::mutex m_Mutex;
    double m_PeriodUs = 0;
    int64_t m_PhaseUs = 0;
    int64_t m_LeadUs = 0;
    int64_t m_HeardUs = 0;
    bool m_Heard = false;
    bool m_Tearing = false;
    bool m_Steady = true;
    double m_BudgetFps = 0;
    int64_t m_ServedUs = 0;
    int64_t m_Grids = 0;
};

} // namespace mw::native
