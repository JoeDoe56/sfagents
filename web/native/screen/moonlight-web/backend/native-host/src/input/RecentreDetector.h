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

#include <cstdint>
#include <cstdlib>
#include <string>

namespace mw::native::input {

/// Tells a game that keeps warping the pointer back to one spot from an
/// application that leaves it where it was put — and, for the former, turns
/// the client's absolute positions into the deltas the game is really after.
///
/// ── The problem ─────────────────────────────────────────────────────────────
///
/// In desktop mode the browser sends where its own pointer IS, and the host
/// places the system pointer there. An old-school first-person game (GoldSrc,
/// Source without raw input, many others) reads the mouse by warping the
/// pointer to the middle of its window every frame and measuring how far it
/// got pushed since. The two fight: the game puts the pointer at the centre,
/// the next client position puts it back where the viewer's pointer is, and
/// the game reads that whole distance — half a screen — as one flick. The
/// view spins, the sky and the floor alternate, and nothing is aimable. On
/// the desktop, where nothing warps the pointer, the same stream is perfect;
/// and a game reading raw input (Unity's, say) never warps either, so it is
/// perfect too. Only the warping kind breaks, and it breaks completely.
///
/// ── The tell ────────────────────────────────────────────────────────────────
///
/// The host knows where it put the pointer. Before the next placement it
/// looks where the pointer is: if it has moved, someone else moved it, and if
/// it keeps turning up at the SAME spot, that someone is re-centring it. Three
/// returns to one spot is the verdict — a physical mouse at the host does not
/// come back to the pixel, and a window clipping the pointer only pins it to
/// an edge the viewer would have to trace on purpose.
///
/// The spot has to be ON the captured display. A game left running on the
/// host's other screen re-centres the pointer there just the same (GoldSrc
/// does it in the background, measured 18/09/2026 with Counter-Strike behind
/// a stream of the second display), and following it would take the mouse
/// away from the screen the viewer is looking at: every click would land in
/// the game and the stream would feel dead. Off the display, nothing is ours
/// to follow, and positions are placed as on any desktop.
///
/// From then on the client's positions go in as the difference between two
/// consecutive ones, applied from wherever the game keeps the pointer: the
/// game measures exactly the distance the viewer moved. The verdict is
/// dropped again when the pointer stops turning up at that spot for a while
/// (a menu opened, the game quit) — a while, not one miss, because between a
/// placement and the game's next frame the pointer is legitimately elsewhere.
///
/// Platform-neutral arithmetic on purpose: every host reads and places a
/// pointer, and every host has these games.
class RecentreDetector
{
public:
    struct Verdict
    {
        bool relative = false; ///< send the delta below instead of the position
        int64_t deltaX = 0;    ///< in desktop pixels, meaningful when relative
        int64_t deltaY = 0;
        bool changed = false; ///< the verdict flipped on this very call
    };

    /// One client position, about to be applied. @p found is where the pointer
    /// was found just now (ignored when @p haveFound is false — a desktop
    /// Windows would not tell us about); @p want is where the client puts it,
    /// already clamped to the captured display; @p nowUs is a monotonic clock.
    Verdict observe(bool haveFound, int64_t foundX, int64_t foundY, int64_t wantX, int64_t wantY,
                    int64_t nowUs)
    {
        Verdict verdict;
        if (haveFound && m_HaveLast) {
            if (!m_Relative) {
                // Where we put it last time is where it should still be.
                if (!within(foundX, foundY, m_LastX, m_LastY)) {
                    if (m_HaveAnchor && within(foundX, foundY, m_AnchorX, m_AnchorY)) {
                        ++m_Hits;
                    } else if (onDisplay(foundX, foundY)) {
                        m_AnchorX = foundX;
                        m_AnchorY = foundY;
                        m_HaveAnchor = true;
                        m_Hits = 1;
                    } else {
                        // Held somewhere the viewer cannot see: not a spot
                        // to learn.
                        m_HaveAnchor = false;
                        m_Hits = 0;
                    }
                    if (m_Hits >= kHitsToEnter) {
                        m_Relative = true;
                        m_MissSinceUs = -1;
                        verdict.changed = true;
                    }
                } else {
                    m_Hits = 0;
                    m_HaveAnchor = false;
                }
            } else if (within(foundX, foundY, m_AnchorX, m_AnchorY)) {
                m_MissSinceUs = -1;
            } else if (m_MissSinceUs < 0) {
                m_MissSinceUs = nowUs;
            } else if (nowUs - m_MissSinceUs >= kMissToLeaveUs) {
                leave();
                verdict.changed = true;
            }
        }

        if (m_Relative && m_HaveLast) {
            verdict.relative = true;
            verdict.deltaX = wantX - m_LastX;
            verdict.deltaY = wantY - m_LastY;
        }
        m_LastX = wantX;
        m_LastY = wantY;
        m_HaveLast = true;
        return verdict;
    }

    bool relative() const { return m_Relative; }
    int64_t anchorX() const { return m_AnchorX; }
    int64_t anchorY() const { return m_AnchorY; }

    /// A delta no hand made: the viewer's pointer left the picture and came
    /// back somewhere else, and the difference between the two client
    /// positions is a jump across the screen. A game turned by it would face
    /// the other way; a delta this size is dropped instead. A quarter of the
    /// captured display, which no single mouse event between two frames
    /// reaches.
    static bool isReentryJump(int64_t deltaX, int64_t deltaY, int64_t displayWidth)
    {
        const int64_t jump = displayWidth / 4 > 1 ? displayWidth / 4 : 1;
        return std::llabs(deltaX) >= jump || std::llabs(deltaY) >= jump;
    }

    /// The log lines for the two flips of the verdict, worded once for every
    /// host so the same situation reads the same in every log.
    static std::string enteredMessage(int64_t anchorX, int64_t anchorY)
    {
        return "[native] input: the application keeps putting the pointer back at " +
               std::to_string(anchorX) + "," + std::to_string(anchorY) +
               " (a game reading the mouse from the cursor) — client positions go in as "
               "deltas from there";
    }
    static const char* leftMessage()
    {
        return "[native] input: the pointer is no longer put back, client positions are "
               "placed again";
    }

    /// Forget everything: a new session, or a display that moved.
    void reset()
    {
        leave();
        m_HaveLast = false;
    }

    /// The captured display, [left, right) x [top, bottom), in the same
    /// coordinates as the positions observed. Only a spot inside it can be
    /// the one a game re-centres to (see the header). Unknown — the default —
    /// means no such check, and forgets everything learnt like reset().
    void setDisplay(int64_t left, int64_t top, int64_t right, int64_t bottom)
    {
        m_DispLeft = left;
        m_DispTop = top;
        m_DispRight = right;
        m_DispBottom = bottom;
        reset();
    }

    /// Absolute placement lands within a pixel or two of what was asked (the
    /// 16-bit absolute axis rounds), so "the same spot" has some give.
    static constexpr int64_t kTolerance = 2;
    /// Returns to one spot before it counts as re-centring.
    static constexpr int kHitsToEnter = 3;
    /// Time away from the spot before the game is considered to have let go.
    /// Longer than any frame of a game that is still running, shorter than a
    /// viewer notices when a menu opens.
    static constexpr int64_t kMissToLeaveUs = 300000;

private:
    // Not "near": windows.h defines that word away as an empty macro.
    static bool within(int64_t x, int64_t y, int64_t toX, int64_t toY)
    {
        return std::llabs(x - toX) <= kTolerance && std::llabs(y - toY) <= kTolerance;
    }

    void leave()
    {
        m_Relative = false;
        m_HaveAnchor = false;
        m_Hits = 0;
        m_MissSinceUs = -1;
    }

    bool onDisplay(int64_t x, int64_t y) const
    {
        if (m_DispRight <= m_DispLeft || m_DispBottom <= m_DispTop) return true; // unknown
        return x >= m_DispLeft && x < m_DispRight && y >= m_DispTop && y < m_DispBottom;
    }

    int64_t m_DispLeft = 0;
    int64_t m_DispTop = 0;
    int64_t m_DispRight = 0;
    int64_t m_DispBottom = 0;

    bool m_HaveLast = false; ///< a position was applied (or, relative, asked)
    int64_t m_LastX = 0;
    int64_t m_LastY = 0;
    bool m_Relative = false;
    bool m_HaveAnchor = false; ///< the spot the pointer keeps returning to
    int64_t m_AnchorX = 0;
    int64_t m_AnchorY = 0;
    int m_Hits = 0;
    int64_t m_MissSinceUs = -1; ///< first miss of the current run, or -1
};

} // namespace mw::native::input
