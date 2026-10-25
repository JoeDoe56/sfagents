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
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace mw::native::input {

// ── Characters as the keys of the host's own layout ─────────────────────────
//
// Text from a phone's keyboard arrives as characters, and Windows can inject a
// character as itself (KEYEVENTF_UNICODE). The classic console ignores that
// kind of input outright, administrator or not, so a phone typed nothing into
// cmd or a conhost PowerShell (Odin, 22/10/2026), while the real keys of the
// touch keyboard's bar went through. Games do not see it either: it presses no
// key. So a character goes as the keys that type it on the host's layout, the
// way a person at that keyboard would type it, and Unicode is kept for what no
// key of the layout produces (an emoji, a script the layout does not have).
//
// The keys are worked out here, in plain data, so a test can read a plan back
// on any layout without a desktop to send it to; Win32Input turns the plan
// into one SendInput.

/// One step of a plan: a key of the host's layout going down or up, or one
/// UTF-16 unit typed as itself (KEYEVENTF_UNICODE).
struct WinKeyEvent
{
    enum class Kind : uint8_t
    {
        Key,
        Unicode
    };
    Kind kind = Kind::Key;
    bool up = false;
    uint8_t vk = 0;        ///< Key: its virtual key on the host's layout
    uint8_t scan = 0;      ///< Key: its scancode there; 0 = none, the VK goes as is
    bool extended = false; ///< Key: the scancode carries the E0 prefix
    uint16_t unit = 0;     ///< Unicode: the UTF-16 unit
};

/// A key of one layout and the level it types at, in VkKeyScan's modifier
/// bits: 1 Shift, 2 Ctrl, 4 Alt — Ctrl+Alt (6) is AltGr.
struct WinStroke
{
    uint8_t vk = 0;
    uint8_t scan = 0;
    bool extended = false;
    uint8_t mods = 0;
};

/// How one character is typed on one layout.
struct WinRecipe
{
    enum class Kind : uint8_t
    {
        Unicode, ///< no key of the layout types it
        Key,     ///< one key, at its level
        DeadKey, ///< a dead key, then the key it composes with
    };
    Kind kind = Kind::Unicode;
    WinStroke key;  ///< Key: the key; DeadKey: the dead key
    WinStroke base; ///< DeadKey: the key after it
};

/// The key a plan taps so that an Alt is never seen going down and up alone:
/// an unassigned virtual key, sent as itself, with no scancode.
constexpr uint8_t kWinMaskVk = 0xE8;

/// The modifiers the viewer holds on the host — Win32Input's own record of
/// what it pressed for them, generic and sided VKs alike.
struct WinHeldMods
{
    bool shift = false;
    bool ctrl = false;
    bool alt = false;
    bool win = false;
    /// The Ctrl and Alt held are a level, not a shortcut: AltGr, or a Mac's
    /// Option, chose the character on the client, so they are let go when
    /// the host's layout does not need them — "@" from a French AltGr is
    /// Shift+2 on a US host, "{" from a Mac's Option is Shift+[. Without it,
    /// a Ctrl or an Alt held is a shortcut (Ctrl+A, Ctrl+Alt+T) and stays.
    bool altLevel = false;
};

/// What a plan did, for the session's one line of log. Never a character.
struct WinTextCounts
{
    int keys = 0;     ///< characters typed as one key
    int deadKeys = 0; ///< characters typed as a dead key then a key
    int unicode = 0;  ///< characters no key of the layout types
    int dropped = 0;  ///< control characters, which no one types

    WinTextCounts& operator+=(const WinTextCounts& o)
    {
        keys += o.keys;
        deadKeys += o.deadKeys;
        unicode += o.unicode;
        dropped += o.dropped;
        return *this;
    }
};

/// What one keyboard layout types, read from Windows once and kept.
///
/// ── Verified, never assumed ─────────────────────────────────────────────────
///
/// VkKeyScanExW answers "which key carries this character" without the host's
/// Caps Lock and without dead keys, and it can be wrong for both: on the French
/// AZERTY with Caps Lock on, the é key types 2; on the newer French AFNOR it
/// names the é key for É, which takes Caps Lock to type. So it is not asked.
/// The table is built the other way round — every key of the layout, at every
/// level a person types at (none, Shift, AltGr, Shift+AltGr), with Caps Lock
/// off and on, read back through ToUnicodeEx: whatever is in it is what that
/// key really types. ToUnicodeEx is called with the flag that leaves the
/// keyboard's dead-key state alone (bit 2, Windows 10 1607 and later), so
/// building it never disturbs what the person at the host is typing.
///
/// Levels with Ctrl alone or Alt alone are never in it: they type control
/// characters, and a 0x03 in pasted text must not become Ctrl+C.
///
/// ── Dead keys ───────────────────────────────────────────────────────────────
///
/// ê has no key on a French keyboard: it is the dead ^, then e. What a dead key
/// composes with is not something ToUnicodeEx can be asked without changing
/// the keyboard's state, so it is read where Windows itself reads it: the
/// layout's own DLL (KBDFR.DLL…), its table of compositions. A layout whose
/// DLL cannot be read still types every key it has; only its compositions go
/// as Unicode, and composes() says so.
class WinKeyLayout
{
public:
    /// The table for @p hkl, built on first use and shared from then on: a
    /// layout's keys do not change while it is loaded. Null for 0.
    static std::shared_ptr<const WinKeyLayout> of(uintptr_t hkl);

    /// Built on the spot, without the cache — for the tests.
    explicit WinKeyLayout(uintptr_t hkl);

    uintptr_t hkl() const { return m_Hkl; }

    /// The layout of an input method editor (Japanese, Chinese, Korean): keys
    /// there go through a composition window, so text is better left as text.
    bool ime() const { return m_Ime; }

    /// Whether the dead-key compositions were read; when not, why() says why.
    bool composes() const { return m_Composes; }
    const std::string& why() const { return m_Why; }

    /// How @p ch is typed with the host's Caps Lock @p capsLock. Unicode for a
    /// character outside the BMP, a control character, or one the layout has
    /// no key for.
    WinRecipe recipe(char32_t ch, bool capsLock) const;

    /// The key that carries @p ch at any level, for a chord: Ctrl+z is the
    /// key Z, whatever level z sits at. False when the layout has none.
    bool chordKey(char32_t ch, WinStroke& out) const;

    /// The key Windows calls @p ch on this layout, for an ASCII letter in a
    /// shortcut from a physical keyboard: programs read Ctrl+A by its virtual
    /// key, which every layout keeps — a Russian one at the US place of A,
    /// where no key types "a". False for anything but a letter.
    bool letterKey(char32_t ch, WinStroke& out) const;

    /// What @p stroke types: 1 and the character, -1 and the accent for a dead
    /// key, 0 for nothing. The same read the table was built from, through
    /// ToUnicodeEx without touching the dead-key state.
    int typed(const WinStroke& stroke, bool capsLock, wchar_t& out) const;

    /// What @p accent's dead key then @p base compose to, by the layout's own
    /// table; 0 when they do not.
    wchar_t composed(wchar_t accent, wchar_t base) const;

    /// How many characters the table holds at Caps Lock @p capsLock, keys and
    /// dead-key pairs together — for the log line and the tests.
    size_t size(bool capsLock) const;

private:
    struct Table
    {
        std::unordered_map<wchar_t, WinStroke> direct;
        std::unordered_map<wchar_t, WinStroke> dead; ///< by accent
        std::unordered_map<wchar_t, std::pair<WinStroke, WinStroke>> viaDead;
    };

    void build();
    void readCompositions();

    uintptr_t m_Hkl = 0;
    bool m_Ime = false;
    bool m_Composes = false;
    std::string m_Why;
    Table m_Tables[2]; ///< Caps Lock off, on
    /// accent << 16 | base → composed character
    std::unordered_map<uint32_t, wchar_t> m_Compositions;
};

/// @p text, as the keys of @p layout, appended to @p out — the whole of it in
/// one batch, so nothing the person at the host types gets in between.
///
/// The layout decides Shift and AltGr: a Shift or an AltGr the viewer holds
/// and a character does not need is let go for it, and put back at the end.
/// A Ctrl or an Alt held alone is a chord the viewer asked for, and stays.
/// An Alt let go or put back alone is masked (kWinMaskVk), so Windows never
/// takes it for a tap of Alt.
/// Tab, Enter (any of \n, \r, \r\n) are their keys; other control characters
/// are dropped, never typed as the Ctrl chords that would make them.
WinTextCounts planText(const WinKeyLayout& layout, const std::u32string& text, bool capsLock,
                       WinHeldMods held, std::vector<WinKeyEvent>& out);

/// @p text as Unicode, every character — where no layout is to be trusted:
/// an input method open, no window to read the layout of. Control characters
/// are dropped all the same.
WinTextCounts planUnicode(const std::u32string& text, std::vector<WinKeyEvent>& out);

/// One edge of a key held for a character from a physical keyboard (the
/// layout fidelity path, CharDown/CharUp): the same rule as text for the
/// levels around it, but the key stays down between the two calls. The press
/// sets the levels the character needs, presses the key and puts the levels
/// back as the viewer holds them, all in one batch; the release lets go of
/// the key alone. Windows repeats nothing it is sent — the client's repeats
/// come as presses — so no level has to stay down with the key, and one that
/// did was under the next key typed while this one was still down: "1a"
/// rolled on a US keyboard came out "1A" on an AZERTY host.
void planKeyEdge(const WinStroke& key, bool down, WinHeldMods held, std::vector<WinKeyEvent>& out);

/// One edge of a chord's key (Ctrl+z from the touch keyboard's bar): the key
/// alone, every modifier left exactly as the viewer holds it — Ctrl+Shift+T
/// stays Ctrl+Shift+T, where text would have let the Shift go.
void planChordEdge(const WinStroke& key, bool down, std::vector<WinKeyEvent>& out);

/// The cost of a level, for picking among keys that type the same character:
/// none, then Shift, then AltGr, then both.
int winLevelCost(uint8_t mods);

} // namespace mw::native::input
