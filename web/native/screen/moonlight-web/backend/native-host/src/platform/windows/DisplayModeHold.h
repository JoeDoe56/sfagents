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

// Which session a display's "Match my screen" mode belongs to.
//
// A session that matches the client's screen puts the display in that mode
// (CDS_FULLSCREEN) and puts the display's own back when it ends. Two sessions
// overlap on one display when a client relaunches: the new stream starts
// before the old one has ended. Measured on the N95 (16/10/2026):
//   - Windows undoes a CDS_FULLSCREEN mode when the process that set it exits;
//   - unless another process has set that mode again meanwhile (CDS_FULLSCREEN
//     alone, no CDS_RESET needed): that one holds it from then on, and the
//     first one's exit undoes nothing.
// The new session found the display at the client's size already and set
// nothing; the old one's end then put the display's own mode back, under the
// new stream.
//
// So a display's mode has a holder: the session that set it last. A session
// that finds another one's mode on the display sets it again, and holds it; a
// session that ends puts the display's own mode back only while it is still
// the holder. The holder is one word in a section named after the display, in
// the console session's namespace (Local\) — a process id and a generation,
// swapped atomically — and a mutex of the same name orders a takeover against
// an end.
//
// "The display's own mode" is what Windows calls its registry mode, unless
// our virtual display is on: Windows then has 800x600 there for the owner's
// own virtual display (N95, 16/10/2026), and an end that asked for it put
// that display in 800x600 until ours went off. So the section keeps a second
// word: the mode the display had when a session first changed it — the
// sessions that take it over after that never saw it — and the holder's end
// puts that one back itself when the registry's is another.
//
// The rules (the name, the word) are pure and tested on every OS; the section
// and the mutex are Windows' (DisplayModeHold.cpp).

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <string>

namespace mw::native::platform {

namespace modehold {

/// The name of the objects for the display @p displayKey (DisplayInfo::key:
/// the monitor device path, or the GDI name): "Local\MoonlightWeb-ModeHold-"
/// and a 64-bit FNV-1a hash of the key in lower case, in 16 hex digits — a
/// device path holds backslashes, which a name under Local\ may not, and
/// Windows does not promise one case for it.
inline std::string objectName(const std::string& displayKey)
{
    uint64_t hash = 0xcbf29ce484222325ULL;
    for (const char c : displayKey) {
        hash ^= static_cast<uint64_t>(std::tolower(static_cast<unsigned char>(c)));
        hash *= 0x100000001b3ULL;
    }
    char hex[17];
    std::snprintf(hex, sizeof(hex), "%016llx", static_cast<unsigned long long>(hash));
    return std::string("Local\\MoonlightWeb-ModeHold-") + hex;
}

/// The holder word: the process id above, a generation below; 0 is nobody.
inline uint64_t word(uint32_t pid, uint32_t generation)
{
    return (static_cast<uint64_t>(pid) << 32) | generation;
}

inline uint32_t pidOf(uint64_t w)
{
    return static_cast<uint32_t>(w >> 32);
}

/// The word once process @p pid has claimed a display whose word was
/// @p current: the next generation, so two sessions of one process are told
/// apart too.
inline uint64_t claimed(uint64_t current, uint32_t pid)
{
    uint32_t generation = static_cast<uint32_t>(current) + 1;
    if (generation == 0) generation = 1;
    return word(pid, generation);
}

/// Whether the claim that wrote @p mine still holds the display, whose word
/// is @p current: nobody has claimed it since.
inline bool holds(uint64_t current, uint64_t mine)
{
    return mine != 0 && current == mine;
}

/// Whether @p current names a holder other than the claim @p mine (0 when
/// this session has made none).
inline bool heldByAnother(uint64_t current, uint64_t mine)
{
    return current != 0 && current != mine;
}

/// The word once the claim @p mine lets go: nobody, or @p current as it is
/// when another session holds the display by now.
inline uint64_t released(uint64_t current, uint64_t mine)
{
    return holds(current, mine) ? 0 : current;
}

/// A display mode in one word: width and height (16 bits each), refresh in
/// hertz (16), bits per pixel (8); 0 is none, or a mode that does not fit.
inline uint64_t mode(uint32_t width, uint32_t height, uint32_t hz, uint32_t bitsPerPixel)
{
    if (width == 0 || height == 0 || width > 0xffff || height > 0xffff || hz > 0xffff ||
        bitsPerPixel > 0xff)
        return 0;
    return (static_cast<uint64_t>(width) << 48) | (static_cast<uint64_t>(height) << 32) |
           (static_cast<uint64_t>(hz) << 16) | (static_cast<uint64_t>(bitsPerPixel) << 8);
}

inline uint32_t widthOf(uint64_t m)
{
    return static_cast<uint32_t>(m >> 48);
}

inline uint32_t heightOf(uint64_t m)
{
    return static_cast<uint32_t>(m >> 32) & 0xffff;
}

inline uint32_t hzOf(uint64_t m)
{
    return static_cast<uint32_t>(m >> 16) & 0xffff;
}

inline uint32_t bitsPerPixelOf(uint64_t m)
{
    return static_cast<uint32_t>(m >> 8) & 0xff;
}

/// The display's own mode once a session has claimed it, the word being
/// @p current before the claim and @p recorded the own mode kept: @p before
/// (the mode that session changed) when nobody held the display, else the
/// one kept — the mode @p before then is another session's.
inline uint64_t ownAfterClaim(uint64_t current, uint64_t recorded, uint64_t before)
{
    return current == 0 ? before : recorded;
}

/// The own mode kept once the claim @p mine lets go: none, when it held the
/// display.
inline uint64_t ownAfterRelease(uint64_t current, uint64_t recorded, uint64_t mine)
{
    return holds(current, mine) ? 0 : recorded;
}

/// Whether the holder's end puts the display's own mode @p own back itself:
/// it is known, and Windows' registry mode (@p registry, 0 when unread) is
/// another size or another refresh (one hertz either way is the same).
inline bool putsOwnBackItself(uint64_t own, uint64_t registry)
{
    if (own == 0) return false;
    if (widthOf(own) != widthOf(registry) || heightOf(own) != heightOf(registry)) return true;
    const uint32_t a = hzOf(own), b = hzOf(registry);
    return (a > b ? a - b : b - a) > 1;
}

/// Whether the holder sets its client mode @p set again on a display that
/// runs @p now (0 when unread): the display was put in another size under
/// its stream — our virtual display turning off puts the others back in the
/// layout it saved. Its rate alone does not count: the picture is still the
/// client's, pixel for pixel.
inline bool setsClientModeAgain(uint64_t set, uint64_t now)
{
    if (set == 0 || now == 0) return false;
    return widthOf(set) != widthOf(now) || heightOf(set) != heightOf(now);
}

} // namespace modehold

/// One session's standing on one display's mode (Windows only).
class DisplayModeHold
{
public:
    /// Opens the display's holder word, or makes it. valid() is false when
    /// that cannot be done: the session then does what it did before there
    /// was a holder — it puts the display's own mode back at its end.
    explicit DisplayModeHold(const std::string& displayKey);
    ~DisplayModeHold();
    DisplayModeHold(const DisplayModeHold&) = delete;
    DisplayModeHold& operator=(const DisplayModeHold&) = delete;

    bool valid() const { return m_Word != nullptr; }

    /// Another session holds a mode it set on this display, and its process
    /// is alive.
    bool heldByAnother() const;

    /// This session holds the display's mode from now on. @p before: the
    /// mode it changed, 0 for a takeover (ownAfterClaim).
    void claim(uint64_t before = 0);

    /// The display's own mode, kept since a session first changed it, or 0.
    uint64_t ownMode() const;

    /// No session has claimed the display since this one did.
    bool held() const;

    /// This session lets go — after it put the display's own mode back.
    void release();

    /// A takeover and an end, one at a time on a display: held while a mode
    /// is set and claimed, or checked and put back. Waits two seconds at most
    /// for the other side, and goes on without the turn after that.
    class Turn
    {
    public:
        explicit Turn(DisplayModeHold* hold);
        ~Turn();
        Turn(const Turn&) = delete;
        Turn& operator=(const Turn&) = delete;

    private:
        void* m_Mutex = nullptr;
    };

private:
    void* m_Section = nullptr;
    void* m_Mutex = nullptr;
    /// The holder, then the own mode: two words of the section.
    volatile int64_t* m_Word = nullptr;
    volatile int64_t* m_Own = nullptr;
    uint64_t m_Mine = 0;
};

} // namespace mw::native::platform
