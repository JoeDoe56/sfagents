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

#include "WinTextKeys.h"

#include "../../core/Log.h"

#include <windows.h>

#include <cstdio>
#include <mutex>

// Last: the keyboard layout DLLs' own structures (KBDTABLES, DEADKEY), from the
// SDK. The header defines a crowd of short macros (T00…, GRAVE, TILDE…) that
// nothing below names.
#include <kbd.h>

namespace mw::native::input {
namespace {

/// ToUnicodeEx's wFlags bit 2: answer without changing the keyboard state, the
/// dead key a person at the host may have just pressed included. Windows 10
/// 1607 and later; older builds ignore it.
constexpr UINT kKeepKeyboardState = 0x4;

/// The levels a person types at: none, Shift, AltGr, Shift+AltGr.
constexpr uint8_t kLevels[] = {0, 1, 6, 7};

/// The left modifiers' scancodes, the same on every layout.
constexpr uint8_t kShiftScan = 0x2A;
constexpr uint8_t kCtrlScan = 0x1D;
constexpr uint8_t kAltScan = 0x38;

/// Keys that are not a character at any level, and keys whose character the
/// table could not promise.
bool scannable(int vk)
{
    switch (vk) {
    // The mouse.
    case VK_LBUTTON:
    case VK_RBUTTON:
    case VK_CANCEL:
    case VK_MBUTTON:
    case VK_XBUTTON1:
    case VK_XBUTTON2:
    // Levels and locks, not characters.
    case VK_SHIFT:
    case VK_CONTROL:
    case VK_MENU:
    case VK_LSHIFT:
    case VK_RSHIFT:
    case VK_LCONTROL:
    case VK_RCONTROL:
    case VK_LMENU:
    case VK_RMENU:
    case VK_LWIN:
    case VK_RWIN:
    case VK_CAPITAL:
    case VK_NUMLOCK:
    case VK_SCROLL:
    // What an input method makes of the keyboard.
    case VK_PACKET:
    case VK_PROCESSKEY: return false;
    default: break;
    }
    // The input method keys (VK_KANA … VK_MODECHANGE), Escape aside.
    if (vk >= 0x15 && vk <= 0x1F && vk != VK_ESCAPE) return false;
    // The numeric keypad follows NumLock, which the table does not know: sent
    // by scancode with NumLock off, its 1 is End.
    if (vk >= VK_NUMPAD0 && vk <= VK_DIVIDE) return false;
    return true;
}

/// A character someone types, as opposed to a control character.
bool printable(char32_t ch)
{
    if (ch < 0x20 || ch == 0x7F) return false;
    if (ch >= 0x80 && ch < 0xA0) return false; // C1 controls
    return true;
}

void fillState(BYTE state[256], uint8_t mods, bool capsLock)
{
    for (int i = 0; i < 256; ++i)
        state[i] = 0;
    if (mods & 1) state[VK_SHIFT] = state[VK_LSHIFT] = 0x80;
    if (mods & 2) state[VK_CONTROL] = state[VK_LCONTROL] = 0x80;
    if (mods & 4) state[VK_MENU] = state[VK_LMENU] = 0x80;
    if (capsLock) state[VK_CAPITAL] = 0x01;
}

/// Keep @p stroke for @p ch when nothing types it yet, or when it does so at
/// a lower level. At equal level the first one found stays: the lower VK.
void keepBetter(std::unordered_map<wchar_t, WinStroke>& table, wchar_t ch, const WinStroke& stroke)
{
    auto it = table.find(ch);
    if (it == table.end() || winLevelCost(stroke.mods) < winLevelCost(it->second.mods))
        table[ch] = stroke;
}

std::string narrow(const std::wstring& wide)
{
    if (wide.empty()) return {};
    const int len = ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                          nullptr, 0, nullptr, nullptr);
    if (len <= 0) return {};
    std::string out(static_cast<size_t>(len), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), len,
                          nullptr, nullptr);
    return out;
}

std::string hkl8(uintptr_t hkl)
{
    char buffer[16];
    std::snprintf(buffer, sizeof(buffer), "0x%08X", static_cast<unsigned>(hkl & 0xFFFFFFFFu));
    return buffer;
}

const wchar_t kLayoutsKey[] = L"SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts";

bool readString(HKEY key, const wchar_t* name, std::wstring& out)
{
    wchar_t buffer[256] = {};
    DWORD size = sizeof(buffer);
    if (::RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ, nullptr, buffer, &size) != ERROR_SUCCESS)
        return false;
    out = buffer;
    return true;
}

/// The layout's DLL, as the registry names it for @p hkl: KBDFR.DLL for the
/// French AZERTY. The HKL's high word is the layout's own handle — its KLID's
/// low word, or 0xFnnn for a variant whose "Layout Id" is nnn (the US
/// International, AFNOR, an Apple keyboard's).
bool layoutFile(uintptr_t hkl, std::wstring& file, std::string& why)
{
    const unsigned device = static_cast<unsigned>((hkl >> 16) & 0xFFFF);
    if ((device & 0xF000) == 0xE000) {
        why = "an input method";
        return false;
    }

    HKEY layouts = nullptr;
    if (::RegOpenKeyExW(HKEY_LOCAL_MACHINE, kLayoutsKey, 0, KEY_READ, &layouts) != ERROR_SUCCESS) {
        why = "the registry's list of layouts cannot be read";
        return false;
    }
    std::wstring klid;
    if ((device & 0xF000) == 0xF000) {
        const unsigned id = device & 0x0FFF;
        for (DWORD i = 0;; ++i) {
            wchar_t name[64] = {};
            DWORD len = 64;
            if (::RegEnumKeyExW(layouts, i, name, &len, nullptr, nullptr, nullptr, nullptr) !=
                ERROR_SUCCESS)
                break;
            HKEY entry = nullptr;
            if (::RegOpenKeyExW(layouts, name, 0, KEY_READ, &entry) != ERROR_SUCCESS) continue;
            std::wstring layoutId;
            const bool named = readString(entry, L"Layout Id", layoutId);
            ::RegCloseKey(entry);
            if (named && std::wcstoul(layoutId.c_str(), nullptr, 16) == id) {
                klid = name;
                break;
            }
        }
    } else {
        wchar_t name[16];
        std::swprintf(name, 16, L"0000%04X", device);
        klid = name;
    }

    bool found = false;
    if (!klid.empty()) {
        HKEY entry = nullptr;
        if (::RegOpenKeyExW(layouts, klid.c_str(), 0, KEY_READ, &entry) == ERROR_SUCCESS) {
            found = readString(entry, L"Layout File", file);
            ::RegCloseKey(entry);
        }
    }
    ::RegCloseKey(layouts);
    if (!found) {
        why = klid.empty() ? "no registry entry for this layout"
                           : "no layout file for KLID " + narrow(klid);
        return false;
    }
    // A name, never a path: the DLL is looked for in System32 and nowhere else.
    if (file.find_first_of(L"\\/:") != std::wstring::npos) {
        why = "the registry names a path, not a file: " + narrow(file);
        return false;
    }
    return true;
}

// ── Plans ───────────────────────────────────────────────────────────────────

struct Mods
{
    bool shift = false;
    bool ctrl = false;  ///< the left Ctrl
    bool alt = false;   ///< the left Alt
    bool altGr = false; ///< the right Alt, over the left Ctrl
};

/// What has to be down for a key at @p level, beside what the viewer holds.
///
/// Shift is the host layout's decision, not the viewer's hand's: the viewer
/// pressed Shift for their own layout, where 1 on AZERTY is Shift+&, and on a
/// US host that character is VK_1 with nothing held. Left in place, the
/// viewer's Shift turned every AZERTY digit into a US symbol on the way
/// through (10/09/2026). So are the Ctrl and Alt of an AltGr, or a Mac's
/// Option, when the client says they chose the character (altLevel). Held
/// otherwise they are a shortcut the viewer asked for — Ctrl+A, Ctrl+Alt+T —
/// and stay.
///
/// The AltGr level is pressed as a keyboard has it, the left Ctrl and the
/// RIGHT Alt. A left Ctrl+Alt types the same in Notepad, but Windows Terminal
/// takes Ctrl+Alt+2 for "go to tab 2" and PSReadLine a dead key under it for
/// a shortcut: on an AZERTY host, # { [ ~ \ | never reached the terminal, and
/// a tilde came out "é~" in PowerShell (P3, 22/10/2026).
Mods wantFor(uint8_t level, const WinHeldMods& held)
{
    Mods want;
    want.shift = (level & 1) != 0;
    want.altGr = (level & 6) == 6;
    want.ctrl = want.altGr || (held.ctrl && !held.altLevel);
    want.alt = held.alt && !held.altLevel;
    return want;
}

void pushKey(std::vector<WinKeyEvent>& out, uint8_t vk, uint8_t scan, bool extended, bool up)
{
    WinKeyEvent e;
    e.kind = WinKeyEvent::Kind::Key;
    e.up = up;
    e.vk = vk;
    e.scan = scan;
    e.extended = extended;
    out.push_back(e);
}

void tap(std::vector<WinKeyEvent>& out, const WinStroke& s)
{
    pushKey(out, s.vk, s.scan, s.extended, false);
    pushKey(out, s.vk, s.scan, s.extended, true);
}

/// A tap of an unassigned virtual key (AutoHotkey's menu mask is the same
/// key). An Alt that goes down and up with no other key between is a tap of
/// Alt to Windows, which hands the keys to the menu bar; with Shift, Alt+Shift
/// switches the input language. A Mac's Option is exactly that Alt, let go
/// and put back alone here.
void mask(std::vector<WinKeyEvent>& out)
{
    pushKey(out, kWinMaskVk, 0, false, false);
    pushKey(out, kWinMaskVk, 0, false, true);
}

/// From the modifiers that are down to the ones wanted: let go first, then
/// press, so a level is never briefly both. An Alt down without Ctrl is masked
/// before anything under it is let go, and after it is pressed alone. Under a
/// Ctrl, Windows reads Alt as an ordinary key, which opens nothing.
void transition(Mods& now, const Mods& want, std::vector<WinKeyEvent>& out)
{
    const bool letsGo = (now.shift && !want.shift) || (now.alt && !want.alt) ||
                        (now.altGr && !want.altGr) || (now.ctrl && !want.ctrl);
    if (letsGo && now.alt && !now.ctrl) mask(out);
    if (now.shift && !want.shift) pushKey(out, VK_SHIFT, kShiftScan, false, true);
    if (now.alt && !want.alt) pushKey(out, VK_MENU, kAltScan, false, true);
    if (now.altGr && !want.altGr) {
        pushKey(out, VK_MENU, kAltScan, true, true);
        // On a layout with AltGr, Windows lets go with the right Alt of the
        // Ctrl it puts under it: the Ctrl wanted goes back down, and one not
        // wanted is let go again, whoever pressed it.
        pushKey(out, VK_CONTROL, kCtrlScan, false, !want.ctrl);
        now.ctrl = want.ctrl;
    }
    if (now.ctrl && !want.ctrl) pushKey(out, VK_CONTROL, kCtrlScan, false, true);
    if (!now.ctrl && want.ctrl) pushKey(out, VK_CONTROL, kCtrlScan, false, false);
    if (!now.alt && want.alt) {
        pushKey(out, VK_MENU, kAltScan, false, false);
        if (!want.ctrl) mask(out);
    }
    if (!now.altGr && want.altGr) pushKey(out, VK_MENU, kAltScan, true, false);
    if (!now.shift && want.shift) pushKey(out, VK_SHIFT, kShiftScan, false, false);
    now = want;
}

void pushUnicode(std::vector<WinKeyEvent>& out, char32_t ch)
{
    uint16_t units[2];
    int count = 1;
    if (ch > 0xFFFF) {
        const char32_t v = ch - 0x10000;
        units[0] = static_cast<uint16_t>(0xD800 + (v >> 10));
        units[1] = static_cast<uint16_t>(0xDC00 + (v & 0x3FF));
        count = 2;
    } else {
        units[0] = static_cast<uint16_t>(ch);
    }
    // One unit after the other, each down then up: Windows expects the two
    // halves of a surrogate pair as consecutive events.
    for (int i = 0; i < count; ++i) {
        WinKeyEvent e;
        e.kind = WinKeyEvent::Kind::Unicode;
        e.unit = units[i];
        out.push_back(e);
        e.up = true;
        out.push_back(e);
    }
}

} // namespace

int winLevelCost(uint8_t mods)
{
    switch (mods) {
    case 0: return 0;
    case 1: return 1;
    case 6: return 2;
    case 7: return 3;
    default: return 9;
    }
}

std::shared_ptr<const WinKeyLayout> WinKeyLayout::of(uintptr_t hkl)
{
    if (hkl == 0) return nullptr;
    static std::mutex mutex;
    static std::unordered_map<uintptr_t, std::shared_ptr<const WinKeyLayout>> cache;
    std::lock_guard<std::mutex> lock(mutex);
    auto it = cache.find(hkl);
    if (it != cache.end()) return it->second;

    auto layout = std::make_shared<const WinKeyLayout>(hkl);
    // Space types a space on every layout there is. When it does not, the
    // table was read while something else held the keyboard's state, and it
    // is not kept: the next character reads it again.
    WinStroke space;
    if (!layout->chordKey(U' ', space) || space.vk != VK_SPACE) {
        log::warning("[native] input: layout " + hkl8(hkl) +
                     " read back no space on the space bar — read again next time");
        return layout;
    }
    cache[hkl] = layout;
    log::info("[native] input: layout " + hkl8(hkl) + " read — " +
              std::to_string(layout->m_Tables[0].direct.size()) + " character(s) on keys, " +
              std::to_string(layout->m_Tables[0].viaDead.size()) + " through dead keys" +
              (layout->composes() ? std::string() : " (none composed: " + layout->why() + ")") +
              (layout->ime() ? ", an input method" : ""));
    return layout;
}

WinKeyLayout::WinKeyLayout(uintptr_t hkl)
    : m_Hkl(hkl)
{
    build();
}

int WinKeyLayout::typed(const WinStroke& stroke, bool capsLock, wchar_t& out) const
{
    BYTE state[256];
    fillState(state, stroke.mods, capsLock);
    wchar_t buffer[8] = {};
    // The scancode without its E0: ToUnicodeEx reads the high bit as "key up".
    const int n = ::ToUnicodeEx(stroke.vk, stroke.scan, state, buffer, 8, kKeepKeyboardState,
                                reinterpret_cast<HKL>(m_Hkl));
    out = n != 0 ? buffer[0] : 0;
    if (n < 0) return -1;
    return n == 1 ? 1 : 0;
}

wchar_t WinKeyLayout::composed(wchar_t accent, wchar_t base) const
{
    auto it = m_Compositions.find((static_cast<uint32_t>(accent) << 16) | base);
    return it == m_Compositions.end() ? 0 : it->second;
}

void WinKeyLayout::build()
{
    const HKL hkl = reinterpret_cast<HKL>(m_Hkl);
    m_Ime = ((m_Hkl >> 16) & 0xF000) == 0xE000;

    for (int vk = 1; vk <= 0xFE; ++vk) {
        if (!scannable(vk)) continue;
        // The scancode comes from the same layout as the virtual key. Mixed
        // with the US table (usScanCode, which is for the browser's positions),
        // a French host typed the character's US neighbour: a resolved to VK_A,
        // whose US scancode 0x1E the French layout reads as q (986bf929).
        const UINT mapped = ::MapVirtualKeyExW(static_cast<UINT>(vk), MAPVK_VK_TO_VSC_EX, hkl);
        const UINT prefix = (mapped >> 8) & 0xFF;
        if ((mapped & 0xFF) == 0 || prefix == 0xE1) continue; // no key for it here
        WinStroke stroke;
        stroke.vk = static_cast<uint8_t>(vk);
        stroke.scan = static_cast<uint8_t>(mapped & 0xFF);
        stroke.extended = prefix == 0xE0;
        for (int caps = 0; caps < 2; ++caps) {
            for (uint8_t level : kLevels) {
                stroke.mods = level;
                wchar_t ch = 0;
                const int n = typed(stroke, caps != 0, ch);
                if (n == 1 && printable(ch))
                    keepBetter(m_Tables[caps].direct, ch, stroke);
                else if (n == -1 && ch != 0)
                    keepBetter(m_Tables[caps].dead, ch, stroke);
            }
        }
    }

    readCompositions();

    // A character no key types, reached through a dead key: the cheapest pair
    // whose dead key and base the layout has at this Caps Lock.
    for (int caps = 0; caps < 2; ++caps) {
        Table& t = m_Tables[caps];
        for (const auto& [both, result] : m_Compositions) {
            if (result == 0 || t.direct.count(result)) continue;
            const wchar_t accent = static_cast<wchar_t>(both >> 16);
            const wchar_t base = static_cast<wchar_t>(both & 0xFFFF);
            auto dead = t.dead.find(accent);
            auto key = t.direct.find(base);
            if (dead == t.dead.end() || key == t.direct.end()) continue;
            const int cost = winLevelCost(dead->second.mods) + winLevelCost(key->second.mods);
            auto it = t.viaDead.find(result);
            if (it == t.viaDead.end() ||
                cost < winLevelCost(it->second.first.mods) + winLevelCost(it->second.second.mods))
                t.viaDead[result] = {dead->second, key->second};
        }
    }
}

void WinKeyLayout::readCompositions()
{
    std::wstring file;
    if (!layoutFile(m_Hkl, file, m_Why)) return;
    HMODULE dll = ::LoadLibraryExW(file.c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!dll) {
        m_Why = "cannot load " + narrow(file) + " (error " + std::to_string(::GetLastError()) + ")";
        return;
    }
    using Descriptor = PKBDTABLES(WINAPI*)();
    const auto descriptor =
        reinterpret_cast<Descriptor>(::GetProcAddress(dll, "KbdLayerDescriptor"));
    const PKBDTABLES tables = descriptor ? descriptor() : nullptr;
    if (!tables) {
        m_Why = narrow(file) + " has no layer descriptor";
        ::FreeLibrary(dll);
        return;
    }
    // DEADTRANS(base, accent, composed, flags): the key is MAKELONG(base,
    // accent), which is how compositions are looked up here too. A dead key
    // that leads to another dead key (DKF_DEAD) is not followed: two dead
    // keys in a row is not how anyone types a character this table needs.
    // Bounded, in case a DLL's table is not terminated as it should be.
    if (tables->pDeadKey) {
        int count = 0;
        for (const DEADKEY* dk = tables->pDeadKey; dk->dwBoth != 0 && count < 8192; ++dk, ++count) {
            if (dk->uFlags & DKF_DEAD) continue;
            m_Compositions[dk->dwBoth] = dk->wchComposed;
        }
    }
    m_Composes = true;
    ::FreeLibrary(dll);
}

WinRecipe WinKeyLayout::recipe(char32_t ch, bool capsLock) const
{
    WinRecipe r;
    if (ch > 0xFFFF || !printable(ch)) return r;
    const Table& t = m_Tables[capsLock ? 1 : 0];
    const wchar_t c = static_cast<wchar_t>(ch);
    auto key = t.direct.find(c);
    if (key != t.direct.end()) {
        r.kind = WinRecipe::Kind::Key;
        r.key = key->second;
        return r;
    }
    auto pair = t.viaDead.find(c);
    if (pair != t.viaDead.end()) {
        r.kind = WinRecipe::Kind::DeadKey;
        r.key = pair->second.first;
        r.base = pair->second.second;
    }
    return r;
}

bool WinKeyLayout::chordKey(char32_t ch, WinStroke& out) const
{
    if (ch > 0xFFFF || !printable(ch)) return false;
    const wchar_t c = static_cast<wchar_t>(ch);
    // The key, at whichever level it carries the character: with Caps Lock
    // off first, then on (a layout whose letters are only reached through
    // Caps Lock), then a dead key for a lone accent.
    for (int caps = 0; caps < 2; ++caps) {
        auto key = m_Tables[caps].direct.find(c);
        if (key != m_Tables[caps].direct.end()) {
            out = key->second;
            out.mods = 0;
            return true;
        }
    }
    auto dead = m_Tables[0].dead.find(c);
    if (dead != m_Tables[0].dead.end()) {
        out = dead->second;
        out.mods = 0;
        return true;
    }
    return false;
}

bool WinKeyLayout::letterKey(char32_t ch, WinStroke& out) const
{
    const char32_t upper = ch >= U'a' && ch <= U'z' ? ch - (U'a' - U'A') : ch;
    if (upper < U'A' || upper > U'Z') return false;
    // A letter's virtual key is the letter itself, on every layout.
    const UINT mapped = ::MapVirtualKeyExW(static_cast<UINT>(upper), MAPVK_VK_TO_VSC_EX,
                                           reinterpret_cast<HKL>(m_Hkl));
    if ((mapped & 0xFF) == 0) return false;
    out = WinStroke{};
    out.vk = static_cast<uint8_t>(upper);
    out.scan = static_cast<uint8_t>(mapped & 0xFF);
    out.extended = ((mapped >> 8) & 0xFF) == 0xE0;
    return true;
}

size_t WinKeyLayout::size(bool capsLock) const
{
    const Table& t = m_Tables[capsLock ? 1 : 0];
    return t.direct.size() + t.viaDead.size();
}

WinTextCounts planText(const WinKeyLayout& layout, const std::u32string& text, bool capsLock,
                       WinHeldMods held, std::vector<WinKeyEvent>& out)
{
    WinTextCounts counts;
    // Text types characters: a Ctrl and an Alt held together under it are
    // AltGr, as they always were for text, never a two-modifier shortcut.
    if (held.ctrl && held.alt) held.altLevel = true;
    const Mods rest{held.shift, held.ctrl, held.alt};
    Mods now = rest;

    const auto keyOf = [&layout](uint8_t vk) {
        WinStroke s;
        s.vk = vk;
        const UINT mapped =
            ::MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC_EX, reinterpret_cast<HKL>(layout.hkl()));
        s.scan = static_cast<uint8_t>(mapped & 0xFF);
        s.extended = ((mapped >> 8) & 0xFF) == 0xE0;
        return s;
    };

    for (size_t i = 0; i < text.size(); ++i) {
        const char32_t ch = text[i];
        // Line breaks and Tab are their keys, at no level: a "\n" read off the
        // layout would be Ctrl+Enter, which sends a chat message.
        if (ch == U'\r' || ch == U'\n' || ch == U'\t') {
            if (ch == U'\r' && i + 1 < text.size() && text[i + 1] == U'\n') ++i;
            transition(now, wantFor(0, held), out);
            tap(out, keyOf(ch == U'\t' ? VK_TAB : VK_RETURN));
            ++counts.keys;
            continue;
        }
        if (!printable(ch)) {
            ++counts.dropped;
            continue;
        }
        const WinRecipe r = layout.recipe(ch, capsLock);
        switch (r.kind) {
        case WinRecipe::Kind::Key:
            transition(now, wantFor(r.key.mods, held), out);
            tap(out, r.key);
            ++counts.keys;
            break;
        case WinRecipe::Kind::DeadKey:
            transition(now, wantFor(r.key.mods, held), out);
            tap(out, r.key);
            transition(now, wantFor(r.base.mods, held), out);
            tap(out, r.base);
            ++counts.deadKeys;
            break;
        case WinRecipe::Kind::Unicode:
            // Under what the viewer holds, as Unicode always went.
            transition(now, rest, out);
            pushUnicode(out, ch);
            ++counts.unicode;
            break;
        }
    }
    transition(now, rest, out);
    return counts;
}

void planKeyEdge(const WinStroke& key, bool down, WinHeldMods held, std::vector<WinKeyEvent>& out)
{
    if (!down) {
        pushKey(out, key.vk, key.scan, key.extended, true);
        return;
    }
    const Mods rest{held.shift, held.ctrl, held.alt};
    Mods now = rest;
    transition(now, wantFor(key.mods, held), out);
    pushKey(out, key.vk, key.scan, key.extended, false);
    transition(now, rest, out);
}

void planChordEdge(const WinStroke& key, bool down, std::vector<WinKeyEvent>& out)
{
    pushKey(out, key.vk, key.scan, key.extended, !down);
}

WinTextCounts planUnicode(const std::u32string& text, std::vector<WinKeyEvent>& out)
{
    WinTextCounts counts;
    for (char32_t ch : text) {
        if (!printable(ch) && ch != U'\r' && ch != U'\n' && ch != U'\t') {
            ++counts.dropped;
            continue;
        }
        pushUnicode(out, ch);
        ++counts.unicode;
    }
    return counts;
}

} // namespace mw::native::input
