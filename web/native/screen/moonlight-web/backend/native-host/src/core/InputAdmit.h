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

#include "mw/native/InputEvent.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <bitset>
#include <cstdint>
#include <string>
#include <vector>

namespace mw::native {

/// Tells a press from everything else the input channel carries, for
/// InputAdmit: a key, a mouse button or a pad's button going down, a trigger
/// pulled past a quarter of its travel.
///
/// Not a press: a key the browser repeats while it is held (a keydown again,
/// with no keyup between), any event of the held-state heartbeat (`resync`,
/// which re-presses what a stall made the host let go of, every 100 ms while
/// anything is held), releases, motion, the wheel, the sticks. A window opened
/// by any of those would be spent on pictures nobody waits for: a key held
/// down for a run is thirty presses a second.
///
/// The filter keeps its own idea of what is held — the injectors keep theirs,
/// each for the OS it speaks to. Pure; under the caller's lock (the session's
/// input mutex, which every event already goes through).
class PressFilter
{
public:
    /// A trigger is pressed past this, of 255.
    static constexpr uint8_t kTriggerPressAt = 64;
    /// Pads tracked; a number past it is no press.
    static constexpr int kPads = 16;
    /// Characters held at once (CharDown): a hand holds fewer.
    static constexpr size_t kMaxChars = 16;

    /// True when @p event is a press; updates what is held either way.
    bool isPress(const InputEvent& event)
    {
        switch (event.type) {
        case InputEvent::Type::KeyDown: {
            if (event.keyCode <= 0 || event.keyCode > 0xFF) return false;
            const bool held = m_Keys.test(static_cast<size_t>(event.keyCode));
            m_Keys.set(static_cast<size_t>(event.keyCode));
            return !held && !event.resync;
        }
        case InputEvent::Type::KeyUp:
            if (event.keyCode > 0 && event.keyCode <= 0xFF)
                m_Keys.reset(static_cast<size_t>(event.keyCode));
            return false;
        case InputEvent::Type::CharDown: {
            const bool held =
                std::find(m_Chars.begin(), m_Chars.end(), event.text) != m_Chars.end();
            if (!held && m_Chars.size() < kMaxChars) m_Chars.push_back(event.text);
            return !held && !event.resync && !event.text.empty();
        }
        case InputEvent::Type::CharUp:
            m_Chars.erase(std::remove(m_Chars.begin(), m_Chars.end(), event.text), m_Chars.end());
            return false;
        case InputEvent::Type::Utf8Text: return !event.text.empty() && !event.resync;
        case InputEvent::Type::MouseButtonDown: {
            if (event.button < 1 || event.button > 31) return false;
            const uint32_t bit = 1u << event.button;
            const bool held = (m_Buttons & bit) != 0;
            m_Buttons |= bit;
            return !held && !event.resync;
        }
        case InputEvent::Type::MouseButtonUp:
            if (event.button >= 1 && event.button <= 31) m_Buttons &= ~(1u << event.button);
            return false;
        case InputEvent::Type::ControllerArrival:
        case InputEvent::Type::ControllerRemoval:
            if (event.controllerNumber < kPads) m_Pads[event.controllerNumber] = Pad{};
            return false;
        case InputEvent::Type::ControllerState: {
            if (event.controllerNumber >= kPads) return false;
            Pad& pad = m_Pads[event.controllerNumber];
            const bool newButton = (event.buttonFlags & ~pad.buttons) != 0;
            const bool left = event.leftTrigger >= kTriggerPressAt && pad.left < kTriggerPressAt;
            const bool right = event.rightTrigger >= kTriggerPressAt && pad.right < kTriggerPressAt;
            pad.buttons = event.buttonFlags;
            pad.left = event.leftTrigger;
            pad.right = event.rightTrigger;
            return !event.resync && (newButton || left || right);
        }
        default: return false;
        }
    }

private:
    struct Pad
    {
        int32_t buttons = 0;
        uint8_t left = 0;
        uint8_t right = 0;
    };
    std::bitset<256> m_Keys;
    std::vector<std::string> m_Chars;
    uint32_t m_Buttons = 0;
    std::array<Pad, kPads> m_Pads{};
};

/// For a moment after each press, every present goes out — on top of the
/// stream's gate, whose grid keeps its phase (plan « inputadmit », 13/10/2026).
///
/// ── Why the gate costs a click its picture ──────────────────────────────────
///
/// FrameCadence encodes the first present of each window of the stream's grid
/// and skips the rest of the window. At 60 fps on the product's virtual
/// display at 240 Hz that is one present in four. The picture that carries a
/// click's effect comes when the application has drawn it — 1 to 7 ms after
/// the press for mw-click-target, ~10 ms for the bench's flag, a game frame or
/// two for a game — so it is usually NOT the first of its window, and waits
/// for the next one: 9.7 ms at the median on the bench of 13/10/2026
/// (docs/bench-native-host.md §8v.5). v0.4.0's click at 60 fps gained nothing
/// on v0.3.1 for that alone.
///
/// "The present after the press goes at once and counts for the next window"
/// was the first idea, and made it worse (replayed: 9.5 → 11.2 ms): that
/// present comes before the application has drawn anything, and the one that
/// carries the click then waits a whole window more.
///
/// ── The window ──────────────────────────────────────────────────────────────
///
/// From the press to kWindowUs after it, every present the gate skips goes
/// out all the same, kMaxExtra at most. The gate is asked first, on every
/// present, and never hears of these pictures: its grid keeps its phase and
/// its windows stay served, nothing is ever held, and once the window closes
/// the stream is exactly what it would have been. Replayed on the passes of
/// 09-13/10/2026 (scripts/bench/clickpath/inputsim.py):
///
///  - the bench's flag, 60 fps: `present` 9.5 → 2.6 ms at the median, p90
///    14.2 → 11.3, 3.0 pictures more a click; at 120 fps 5.2 → 2.3 ms;
///  - mw-click-target: 4 to 8 ms (p90 13) → 0;
///  - RE9 at 78 pictures a second: the window of 33 ms carries a reaction up
///    to 24 ms late (p90 13.6 → 0) for 0.7 pictures more a press. One of
///    16.7 ms carried 8 ms at most, which is why kWindowUs is two intervals
///    of a 60 fps stream; kMaxExtra keeps it at three pictures on a display
///    that presents at 240 Hz;
///  - a client that paints at its vsync at 120 Hz holds a picture three
///    refreshes around 10 % of clicks instead of 19 %, and steps over none
///    more. At 60 Hz the click's picture comes early on the client's own
///    grid: double steps on 19 % of clicks instead of 9, unless two pictures
///    keep half an interval apart (gapFor(): 10 %).
///
/// The window is keyed on each picture's PRESENT, not on when the loop took
/// it: a picture composed before the press cannot carry it. Presses that
/// come between two of the loop's calls are taken together — the window from
/// the first to kWindowUs after the last — and a press inside an open window
/// carries it on, for nothing.
///
/// ── What keeps it from costing the stream ───────────────────────────────────
///
///  - **A bucket of windows**, kBurst ahead and kPerSecond more a second: a
///    window opens whole or not at all. Charging each picture instead would
///    spend the bucket on the presents right after the press, which carry
///    nothing yet. Held keys, a broken filter, a stream of taps: never more
///    than ~6 pictures a second more (10 % at 60 fps), and a press the bucket
///    refuses waits exactly as long as without the window — never longer.
///  - **The link** (the caller's word): no window picture onto a link the
///    governor has cut or seen a queue on lately, or that the stream's own
///    estimate says is still busy.
///  - **The encoder** (the caller's word): with a synchronous encode slower
///    than a refresh of the display, the window's pictures would push the
///    grid's later.
///
/// Pure and clocked by the caller. notePress() from the input thread, the
/// rest from the capture loop. ⚠️ scripts/bench/clickpath/gatesim.py's
/// InputAdmit is a copy, the one the bench replays: change both together.
class InputAdmit
{
public:
    static constexpr int64_t kWindowUs = 33000;
    static constexpr int kBurst = 3;
    static constexpr double kPerSecond = 2.0;
    static constexpr int kMaxExtra = 3;

    struct Settings
    {
        int64_t windowUs = kWindowUs;
        int burst = kBurst;
        double perSecond = kPerSecond;
        int maxExtra = kMaxExtra;
        /// The least gap between two pictures admitted, µs; -1: gapFor()'s.
        int64_t gapUs = -1;
    };

    enum class Verdict
    {
        Skip,
        Grid,
        Window,
    };

    /// Whether the window serves this client, for the bench's @p mode
    /// (EncoderTuning::inputAdmit: -1 the product, 0 off, 1 every client).
    /// The product: a client whose tearing is real (@p tearingReal, Chromium
    /// on Windows) and that does not paint at its vsync now (@p clientVsync,
    /// which the client may change mid-session). On its vsync a client gained
    /// nothing at 60 and 120 Hz and stepped over pictures on 12 to 21 % of
    /// clicks; a client that tears at 60 Hz gained 7.6 ms (bench §8w.9).
    static bool forClient(int mode, bool tearingReal, bool clientVsync)
    {
        if (mode >= 0) return mode == 1;
        return tearingReal && !clientVsync;
    }

    /// For a stream whose gate's interval is @p intervalUs.
    void configure(const Settings& settings, int64_t intervalUs)
    {
        m_Settings = settings;
        m_Tokens = settings.burst;
        setIntervalUs(intervalUs);
    }

    /// The gate moved to @p intervalUs (the client's screen, a step of the
    /// detection). The window is never shorter than an interval: one that
    /// closes before the grid's next picture would have come carries nothing
    /// the grid would not have.
    void setIntervalUs(int64_t intervalUs)
    {
        m_WindowUs = m_Settings.windowUs > intervalUs ? m_Settings.windowUs : intervalUs;
    }

    /// The least gap between two pictures admitted, for a client whose screen
    /// refreshes at @p clientMilliHz (0: not said) and paints at its vsync or
    /// not, on a stream at @p intervalUs: half an interval for a client that
    /// paints at its vsync slower than twice the stream's rate, none otherwise.
    /// A client that tears shows each picture as it is drawn.
    int64_t gapFor(int clientMilliHz, bool clientVsync, int64_t intervalUs) const
    {
        if (m_Settings.gapUs >= 0) return m_Settings.gapUs;
        if (!clientVsync || clientMilliHz <= 0 || intervalUs <= 0) return 0;
        // Refresh period over half the stream's interval: under twice its rate.
        const int64_t periodUs = 1000000000LL / clientMilliHz;
        return periodUs * 2 > intervalUs ? intervalUs / 2 : 0;
    }

    /// The input thread: a press, handed to the OS at @p nowUs.
    void notePress(int64_t nowUs)
    {
        int64_t none = 0;
        m_FirstUs.compare_exchange_strong(none, nowUs, std::memory_order_acq_rel);
        m_LastUs.store(nowUs, std::memory_order_release);
        m_Presses.fetch_add(1, std::memory_order_relaxed);
    }

    /// The capture loop, for a present the gate has just answered for
    /// (@p gridSaid). @p presentUs: the picture's present; @p nowUs: the
    /// loop's moment; @p gapUs: gapFor()'s; @p linkOk and @p encoderOk: the
    /// caller's guards.
    Verdict admit(bool gridSaid, int64_t presentUs, int64_t nowUs, int64_t gapUs, bool linkOk,
                  bool encoderOk)
    {
        takePress(nowUs);
        if (gridSaid) {
            m_LastAdmittedUs = nowUs;
            return Verdict::Grid;
        }
        if (!m_Open || presentUs < m_StartUs || presentUs >= m_EndUs) return Verdict::Skip;
        if (m_Extra >= m_Settings.maxExtra) {
            m_Capped++;
            return Verdict::Skip;
        }
        if (gapUs > 0 && m_LastAdmittedUs != 0 && nowUs - m_LastAdmittedUs < gapUs) {
            m_Gapped++;
            return Verdict::Skip;
        }
        if (!encoderOk) {
            m_EncoderRefused++;
            return Verdict::Skip;
        }
        if (!linkOk) {
            m_LinkRefused++;
            return Verdict::Skip;
        }
        m_Extra++;
        m_Frames++;
        m_LastAdmittedUs = nowUs;
        return Verdict::Window;
    }

    int64_t windowUs() const { return m_WindowUs; }
    int maxExtra() const { return m_Settings.maxExtra; }
    int64_t presses() const { return m_Presses.load(std::memory_order_relaxed); }
    int64_t windows() const { return m_Windows; }
    int64_t carried() const { return m_Carried; }
    int64_t refused() const { return m_Refused; }
    int64_t late() const { return m_Late; }
    /// Pictures the window added.
    int64_t frames() const { return m_Frames; }
    int64_t capped() const { return m_Capped; }
    int64_t gapped() const { return m_Gapped; }
    int64_t linkRefused() const { return m_LinkRefused; }
    int64_t encoderRefused() const { return m_EncoderRefused; }

private:
    void takePress(int64_t nowUs)
    {
        const int64_t first = m_FirstUs.exchange(0, std::memory_order_acq_rel);
        if (first == 0) return;
        int64_t last = m_LastUs.load(std::memory_order_acquire);
        if (last < first) last = first;
        // Presses the loop sees only once their window is over — it was busy
        // elsewhere, or skipped the window for a while: nothing to open.
        if (last + m_WindowUs <= nowUs) {
            m_Late++;
            return;
        }
        if (m_RefilledUs != 0) {
            m_Tokens += static_cast<double>(first - m_RefilledUs) * m_Settings.perSecond / 1e6;
            if (m_Tokens > m_Settings.burst) m_Tokens = m_Settings.burst;
        }
        m_RefilledUs = first;
        if (m_Open && first < m_EndUs) {
            m_EndUs = last + m_WindowUs;
            m_Carried++;
        } else if (m_Tokens >= 1.0) {
            m_Tokens -= 1.0;
            m_Open = true;
            m_StartUs = first;
            m_EndUs = last + m_WindowUs;
            m_Extra = 0;
            m_Windows++;
        } else {
            m_Refused++;
        }
    }

    Settings m_Settings;
    int64_t m_WindowUs = kWindowUs;
    std::atomic<int64_t> m_FirstUs{0};
    std::atomic<int64_t> m_LastUs{0};
    std::atomic<int64_t> m_Presses{0};
    double m_Tokens = kBurst;
    int64_t m_RefilledUs = 0;
    bool m_Open = false;
    int64_t m_StartUs = 0;
    int64_t m_EndUs = 0;
    int m_Extra = 0;
    int64_t m_LastAdmittedUs = 0;
    int64_t m_Windows = 0;
    int64_t m_Carried = 0;
    int64_t m_Refused = 0;
    int64_t m_Late = 0;
    int64_t m_Frames = 0;
    int64_t m_Capped = 0;
    int64_t m_Gapped = 0;
    int64_t m_LinkRefused = 0;
    int64_t m_EncoderRefused = 0;
};

} // namespace mw::native
