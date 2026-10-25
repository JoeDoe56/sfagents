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

#include "DisplayModeHold.h"

#include "../../core/Log.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <sddl.h>

namespace mw::native::platform {

namespace {

/// Whoever a worker runs as in this console session — the user, or SYSTEM
/// for the secure desktop — reads and writes the holder, so either kind of
/// worker can follow the other on a display.
constexpr wchar_t kSddl[] = L"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)";

struct Security
{
    SECURITY_ATTRIBUTES attributes{};
    PSECURITY_DESCRIPTOR descriptor = nullptr;

    Security()
    {
        if (::ConvertStringSecurityDescriptorToSecurityDescriptorW(kSddl, SDDL_REVISION_1,
                                                                   &descriptor, nullptr)) {
            attributes.nLength = sizeof(attributes);
            attributes.lpSecurityDescriptor = descriptor;
        }
    }
    ~Security()
    {
        if (descriptor) ::LocalFree(descriptor);
    }
    SECURITY_ATTRIBUTES* get() { return descriptor ? &attributes : nullptr; }
};

/// A process a holder names is still there: a session that ended with its
/// process took its mode with it (Windows undid it).
bool processAlive(uint32_t pid)
{
    if (pid == ::GetCurrentProcessId()) return true;
    HANDLE process = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return ::GetLastError() == ERROR_ACCESS_DENIED; // there, not ours to ask
    DWORD code = 0;
    const bool alive = ::GetExitCodeProcess(process, &code) && code == STILL_ACTIVE;
    ::CloseHandle(process);
    return alive;
}

std::wstring wide(const std::string& ascii)
{
    return std::wstring(ascii.begin(), ascii.end());
}

uint64_t readWord(volatile int64_t* w)
{
    return static_cast<uint64_t>(::InterlockedCompareExchange64(w, 0, 0));
}

} // namespace

DisplayModeHold::DisplayModeHold(const std::string& displayKey)
{
    if (displayKey.empty()) return;
    const std::string name = modehold::objectName(displayKey);
    Security security;
    // Two words. A section an older build made holds one, and its view of
    // two is refused: that session then goes on as before there was a holder.
    constexpr DWORD kSize = 2 * sizeof(int64_t);
    HANDLE section = ::CreateFileMappingW(INVALID_HANDLE_VALUE, security.get(), PAGE_READWRITE, 0,
                                          kSize, wide(name).c_str());
    if (!section) {
        log::warning("[native] the display's mode holder cannot be opened (error " +
                     std::to_string(::GetLastError()) +
                     ") — this session puts the display's own mode back at its end, as before");
        return;
    }
    void* view = ::MapViewOfFile(section, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, kSize);
    if (!view) {
        ::CloseHandle(section);
        return;
    }
    m_Section = section;
    m_Word = static_cast<volatile int64_t*>(view);
    m_Own = m_Word + 1;
    // Without it a takeover and an end are not ordered; the holder still is.
    m_Mutex = ::CreateMutexW(security.get(), FALSE, wide(name + "-turn").c_str());
}

DisplayModeHold::~DisplayModeHold()
{
    if (m_Word) ::UnmapViewOfFile(const_cast<int64_t*>(m_Word));
    if (m_Section) ::CloseHandle(m_Section);
    if (m_Mutex) ::CloseHandle(m_Mutex);
}

bool DisplayModeHold::heldByAnother() const
{
    if (!m_Word) return false;
    const uint64_t current = readWord(m_Word);
    return modehold::heldByAnother(current, m_Mine) && processAlive(modehold::pidOf(current));
}

void DisplayModeHold::claim(uint64_t before)
{
    if (!m_Word) return;
    for (;;) {
        const uint64_t current = readWord(m_Word);
        const uint64_t next = modehold::claimed(current, ::GetCurrentProcessId());
        if (static_cast<uint64_t>(::InterlockedCompareExchange64(
                m_Word, static_cast<int64_t>(next), static_cast<int64_t>(current))) == current) {
            m_Mine = next;
            // Under the turn, as every write of it: no other session comes
            // between the two words.
            ::InterlockedExchange64(
                m_Own, static_cast<int64_t>(modehold::ownAfterClaim(current, ownMode(), before)));
            return;
        }
    }
}

uint64_t DisplayModeHold::ownMode() const
{
    return m_Own ? readWord(m_Own) : 0;
}

bool DisplayModeHold::held() const
{
    return m_Word && modehold::holds(readWord(m_Word), m_Mine);
}

void DisplayModeHold::release()
{
    if (!m_Word || m_Mine == 0) return;
    const uint64_t current = readWord(m_Word);
    const uint64_t next = modehold::released(current, m_Mine);
    ::InterlockedExchange64(
        m_Own, static_cast<int64_t>(modehold::ownAfterRelease(current, ownMode(), m_Mine)));
    // Only from our own word to nobody: a claim since is left as it is.
    if (next != current)
        ::InterlockedCompareExchange64(m_Word, static_cast<int64_t>(next),
                                       static_cast<int64_t>(current));
    m_Mine = 0;
}

DisplayModeHold::Turn::Turn(DisplayModeHold* hold)
{
    if (!hold || !hold->m_Mutex) return;
    const DWORD rc = ::WaitForSingleObject(hold->m_Mutex, 2000);
    // Abandoned: the other side's process died holding it — ours now.
    if (rc == WAIT_OBJECT_0 || rc == WAIT_ABANDONED)
        m_Mutex = hold->m_Mutex;
    else
        log::warning("[native] the display's mode turn not had in 2 s — going on without it");
}

DisplayModeHold::Turn::~Turn()
{
    if (m_Mutex) ::ReleaseMutex(m_Mutex);
}

} // namespace mw::native::platform
