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

#include "../../capture/windows/IWindowsCapture.h"
#include "../IInputSink.h"
#include "../RecentreDetector.h"
#include "../SystemMouse.h"
#include "../VirtualHid.h"
#include "../../core/ClickTrace.h"
#include "VigemGamepad.h"
#include "WinTextKeys.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <unordered_map>

namespace mw::native::input {

/// Keyboard and mouse injection through SendInput.
///
/// ── Scancodes, not virtual keys ─────────────────────────────────────────────
///
/// Games read the keyboard through Raw Input or DirectInput, and both of those
/// see SCANCODES. A virtual-key injection is invisible to them: the menu of a
/// game would respond while the game itself would not, which is the confusing
/// half-working failure this avoids. So a press is mapped VK → scancode and
/// injected with KEYEVENTF_SCANCODE.
///
/// The exception is the browser's NON_NORMALIZED flag, which says "this key had
/// no US-layout equivalent, take the code as it is". There, injecting a
/// scancode would resolve through the wrong layout, so the virtual key goes in
/// directly and the host's active layout decides.
///
/// ── Not usable from session 0 ───────────────────────────────────────────────
///
/// SendInput targets the calling thread's desktop. A Windows service in session
/// 0 has no interactive desktop, so injection silently does nothing there. That
/// is a property of the OS, not of this class — the console-session launcher is
/// what solves it, and the probe already refuses a session with no interactive
/// desktop.
class Win32Input final : public IInputSink
{
public:
    /// @param displayRect  where the captured display sits on the desktop.
    ///                     Absolute pointer positions from the browser are
    ///                     relative to THAT display, not to the whole desktop:
    ///                     the client is looking at one screen and its top-left
    ///                     is not the desktop's.
    /// @param onRumble     where a game's vibration request goes. Optional: with
    ///                     no sink the pad still works, it just does not shake.
    explicit Win32Input(const capture::DesktopRect& displayRect,
                        VigemGamepad::RumbleSink onRumble = {});
    ~Win32Input() override;

    bool start(std::string& error) override;
    void stop() override;
    void inject(const InputEvent& event) override;
    void setDisplayRect(int left, int top, int right, int bottom) override;
    void setAllowElevated(bool allow) override;
    void setGateCallback(InputGateCallback callback) override;
    bool releaseBlock() override;

    /// The bench's click trace (clicktrace=1): each mouse button press handed
    /// to the OS goes into @p trace, which must outlive this sink. Before
    /// start(), or not at all.
    void setClickTrace(ClickTrace* trace) { m_ClickTrace = trace; }

    /// The host's own mouse (input/SystemMouse.h), made by start() through the
    /// "MoonlightWeb Virtual HID" driver: -1 (the product) when the host has
    /// no pointing device of its own, 0 never, 1 always — beside a real mouse
    /// too, for the bench (EncoderTuning::virtualMouse). Before start().
    void setVirtualMouse(int mode) { m_MouseMode = mode; }

    bool showsPointer() override;

private:
    /// The body of releaseBlock, on its own thread — see the .cpp.
    void runRelease(void* blockerWindow);

    /// inject()'s own body: the gate, then the switch onto the platform calls.
    /// Called directly on the caller's thread in the ordinary case, and from
    /// the follower thread when this worker follows the desktop.
    void injectNow(const InputEvent& event);
    /// The follower thread: attach to the input desktop, drain the queue,
    /// re-attach whenever Windows has switched. See m_Follow.
    void runFollower();
    /// Drop the held-key bookkeeping without pressing anything, for a desktop
    /// switch that took the real state with it.
    void forgetHeld();

    void injectKey(const InputEvent& event, bool down);
    /// One character the client's layout produced, pressed and released as the
    /// real key of the HOST's layout that carries it — so the scancode exists
    /// and games see a key. A character the layout reaches through a dead key
    /// is typed whole on the press, and Unicode is the fallback for one no
    /// local key can reach (WinTextKeys.h).
    void injectChar(const InputEvent& event, bool down);
    /// A chord of the touch keyboard's bar: the key carrying the character,
    /// nothing else touched (WinTextKeys planChordEdge).
    void injectChord(const InputEvent& event, char32_t ch, const WinKeyLayout* layout, bool down);
    /// Text from a soft keyboard: the keys of the host's layout, in one
    /// SendInput per piece, Unicode only where no key types a character.
    void injectText(const std::string& utf8);
    /// Count what a text did, for the session's line at stop(); the first one
    /// also says which kind of window took it. Never a character.
    void noteText(const WinTextCounts& counts, const std::string& unicodeWhy, void* window,
                  uintptr_t hkl);
    /// The modifiers the viewer holds, read off m_HeldKeys. Under m_HeldMutex.
    WinHeldMods heldModsLocked() const;
    void injectMouseMove(int deltaX, int deltaY);
    /// Warp the pointer to the nearest point of the captured display if it is
    /// on another screen. A relative move applied from there is visible.
    void bringCursorOntoDisplay();
    /// A client position — placed as such, or, once a game is found to be
    /// re-centring the pointer, applied as the delta from the previous one.
    /// See RecentreDetector.
    void injectMousePosition(const InputEvent& event);
    /// Applies the press if — and only if — it changes the button's state.
    void injectMouseButton(int button, bool down);
    /// Sends it regardless. For the release-everything path, which has already
    /// decided what is down.
    void sendMouseButton(int button, bool down);
    void injectScroll(int amount, bool horizontal);
    void syncLockKeys(const InputEvent& event);

    // ── The host's own mouse ────────────────────────────────────────────────
    //
    // On a host with no pointing device, a mouse of our own, made through the
    // driver (porte S1: one fixed descriptor, input/SystemMouse.h). Windows
    // then shows its pointer, and games that read Raw Input by device get one.
    //
    // What goes through it: relative moves, and — while the viewer moves the
    // pointer relatively (gaming mode, a game that re-centres) — the buttons
    // and the wheels. An absolute position stays SendInput, which has no
    // device to say it: a report travels the HID stack and lands after a
    // SendInput sent at the same moment, so a click right after a placement
    // goes the same way as the placement, or it would land before it. A
    // button is released the way it was pressed.
    //
    // Made in start() when it can be (a worker elevated or SYSTEM, the driver
    // 0.1.2.0 or later); when it cannot, everything is SendInput as before
    // and Mouse Keys show the pointer (PointerPresence).

    /// Makes it, per m_MouseMode. Said in the log either way.
    void startVirtualMouse();
    /// One movement through it, with the buttons it holds. Under m_HeldMutex.
    /// False when the device refused it — then it is let go of, and the
    /// caller does it through SendInput instead.
    bool sendThroughMouseLocked(int dx, int dy, int notches, int panNotches);
    /// The device let go of, after a refusal: what it held is released with it.
    void dropVirtualMouseLocked();

    int m_MouseMode = -1;
    std::unique_ptr<IVirtualHid> m_Mouse;
    /// Its buttons down (systemmouse::buttonBit). Under m_HeldMutex.
    uint8_t m_MouseButtons = 0;
    /// Whether the viewer's last motion was relative: buttons and wheels go
    /// through the device then. Input-thread only.
    bool m_Relative = false;
    systemmouse::Notches m_WheelNotches;
    systemmouse::Notches m_PanNotches;
    /// When it was made, and whether Windows lists it yet — see showsPointer().
    int64_t m_MouseMadeUs = 0;
    int64_t m_MouseLookedUs = 0;
    bool m_MouseListed = false;
    bool m_MouseUnlistedSaid = false;

    /// Release everything still recorded as held. Called by stop().
    void releaseAll();

public:
    /// What a window's process runs as — see standingOf() in the .cpp. Public
    /// only so the file-local helper can build one.
    struct WindowStanding
    {
        int level = -1;   ///< integrity RID; -1 = unknown (protected process)
        std::string name; ///< "title" (exe, pid), filled for elevated windows only
    };

private:
    /// One window's standing, remembered for a second (see cachedStanding).
    struct StandingCache
    {
        void* window = nullptr; ///< HWND, kept opaque: no windows.h here
        int64_t expiresUs = 0;
        WindowStanding standing;
    };

    const WindowStanding& cachedStanding(void* window, StandingCache& cache);
    /// "uipi", "policy", or "" when a press aimed at `standing` goes through.
    const char* gateReason(const WindowStanding& standing) const;
    /// Tell the log and the listener when the gate's state changed. @p window
    /// is the HWND `standing` describes, kept so releaseBlock knows what to
    /// leave minimised. @p force reports even an unchanged state, which is how
    /// releaseBlock answers a viewer waiting on its own button.
    void reportGate(const WindowStanding& standing, void* window, bool force = false);

    StandingCache m_Focused;     ///< the foreground window — keyboard's target
    StandingCache m_UnderCursor; ///< the window under the pointer — a click's
    bool m_AllowElevated = true;
    InputGateCallback m_OnGate;
    /// The gate's last reported state, and the window it named. Guarded because
    /// the unblock thread reports too — see reportGate.
    std::mutex m_GateMutex;
    bool m_GateBlocked = false;
    std::string m_GateWindow;
    void* m_GateHwnd = nullptr;
    std::atomic<uint64_t> m_Gated{0}; ///< presses dropped at the gate

    /// releaseBlock's worker: COM into the shell, then a wait, so it cannot run
    /// on the thread that asked. Joined by stop().
    std::mutex m_UnblockMutex;
    std::thread m_UnblockThread;

    // ── Following the desktop switch (SYSTEM workers only) ──────────────────
    //
    // SendInput injects into the desktop of the CALLING thread, so reaching a
    // UAC prompt means standing on `Winlogon` when it is up. SetThreadDesktop
    // refuses to move a thread that owns a window or a hook, and the thread
    // that delivers input here runs a Qt event loop — which on Windows owns an
    // internal window. It can never follow, so it hands the event to a thread
    // that can: one thread, created by start(), that does nothing else.
    //
    // This is the exception to InputEvent.h's "no queue, no thread hop": it
    // buys the secure desktop, it costs one condition-variable wake (tens of
    // microseconds, against a frame time of 8 ms), and it exists ONLY when the
    // worker runs as SYSTEM. An ordinary worker still injects on the caller's
    // thread, on exactly the path that was measured.
    bool m_Follow = false;
    ClickTrace* m_ClickTrace = nullptr;
    /// When the last button press was queued for the follower (click trace).
    std::atomic<int64_t> m_PressQueuedUs{0};
    std::thread m_Follower;
    std::mutex m_QueueMutex;
    std::condition_variable m_QueueWake;
    std::deque<InputEvent> m_Queue;
    bool m_FollowerQuit = false;
    /// Events dropped because the queue hit its bound — a host so wedged that
    /// SendInput itself is not returning. Reported once, at stop().
    uint64_t m_Dropped = 0;

    /// Not const: the display can be re-resolved under a running session (see
    /// setDisplayRect). Written and read under the caller's own serialisation.
    capture::DesktopRect m_DisplayRect;

    /// Whether the application under the pointer keeps warping it back to one
    /// spot — the one case where placing the client's position is wrong.
    /// Input-thread only, like the diagnostics below.
    RecentreDetector m_Recentre;

    /// Null when ViGEmBus is absent — the overwhelmingly common case, and not a
    /// failure. Keyboard and mouse are unaffected.
    std::unique_ptr<VigemGamepad> m_Gamepad;
    VigemGamepad::RumbleSink m_OnRumble;

    /// What we have pressed and not yet released, so a session that ends
    /// mid-keypress does not leave the host holding a key down forever. Guarded
    /// because inject() runs on the network thread while stop() runs on the
    /// session's — the only shared state in this class, and small enough that a
    /// plain mutex costs nothing next to the SendInput call it wraps.
    std::mutex m_HeldMutex;
    std::set<int> m_HeldKeys;    ///< virtual-key codes
    std::set<int> m_HeldButtons; ///< browser button numbers, 1..5
    /// The scancode a held key went down with, when the host's layout chose
    /// it rather than the US table (a character's key), E0 in the high byte:
    /// what releaseAll lets go of is the key that went down, not its VK's US
    /// position — on AZERTY those are different keys.
    std::map<int, uint16_t> m_HeldScan;
    /// The key each character went down on, so its release lets go of that
    /// key whatever the layout says by then. Only for characters held as one
    /// key: a dead-key pair or Unicode is typed whole on the press.
    std::unordered_map<char32_t, WinStroke> m_CharKeys;

    /// What the session's text did, for one line at stop(): counts and why
    /// Unicode was needed, never a character. Guarded: the follower thread
    /// types while stop() reads.
    std::mutex m_TextMutex;
    WinTextCounts m_Text;
    std::set<std::string> m_TextUnicodeWhy;
    bool m_TextWindowSaid = false;

    /// Events applied since start(), and which InputEvent::Type values have
    /// been seen at least once (one bit each). Only ever read for the log
    /// lines, hence relaxed ordering — diagnostics, not synchronisation.
    std::atomic<uint64_t> m_Injected{0};
    std::atomic<uint32_t> m_SeenTypes{0};

    bool m_Started = false;
};

} // namespace mw::native::input
