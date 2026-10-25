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

#include <linux/capability.h>
#include <sys/syscall.h>
#include <unistd.h>

// A capability in the effective set of THIS thread for a scope.
//
// The package's launcher hands the app two capabilities (backend/packaging/
// linux/moonlightweb-launch.c), and the app keeps both PERMITTED only
// (backend/src/common/LinuxCapabilities.h): nothing in the process carries
// them while it serves HTTP, relays or decodes input. The engine raises one
// into the calling thread's effective set around the one call the kernel checks
// it on, and lowers it again — Sunshine's posture for CAP_SYS_ADMIN:
//
//  - CAP_SYS_ADMIN around GETFB2, which hands out scanout buffer handles to
//    nobody else (KmsCapture);
//  - CAP_SYS_NICE around the creation of a GPU context or device above normal
//    priority, which amdgpu, i915 and xe grant to nobody else (GlConvert, and
//    the Vulkan device). The priority is fixed at creation: the capability is
//    not needed afterwards, and not held.
//
// Raw capget/capset on the calling thread, no libcap: nothing to link, and
// libcap's setter would sync every thread of the process, which is the
// opposite of the intent. A process that does not hold the capability at all
// is left alone, and the call then runs without it — the caller says why.

namespace mw::native::platform {

class ScopedCapability
{
public:
    explicit ScopedCapability(int capability)
        : m_Index(static_cast<unsigned>(capability) >> 5)
        , m_Bit(1u << (static_cast<unsigned>(capability) & 31))
    {
        __user_cap_header_struct header{};
        __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3]{};
        header.version = _LINUX_CAPABILITY_VERSION_3;
        if (syscall(SYS_capget, &header, data) != 0) return;
        if (!(data[m_Index].permitted & m_Bit)) return;
        if (data[m_Index].effective & m_Bit) {
            m_Effective = true;
            return;
        }
        data[m_Index].effective |= m_Bit;
        m_Raised = syscall(SYS_capset, &header, data) == 0;
        m_Effective = m_Raised;
    }
    ~ScopedCapability()
    {
        if (!m_Raised) return;
        __user_cap_header_struct header{};
        __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3]{};
        header.version = _LINUX_CAPABILITY_VERSION_3;
        if (syscall(SYS_capget, &header, data) != 0) return;
        data[m_Index].effective &= ~m_Bit;
        syscall(SYS_capset, &header, data);
    }
    ScopedCapability(const ScopedCapability&) = delete;
    ScopedCapability& operator=(const ScopedCapability&) = delete;

    /// Whether the capability is effective on this thread for the scope: it
    /// already was, or it was raised here.
    bool effective() const { return m_Effective; }

    /// Whether this process holds @p capability at all — in its permitted set,
    /// whatever the effective set says right now.
    static bool permitted(int capability)
    {
        __user_cap_header_struct header{};
        __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3]{};
        header.version = _LINUX_CAPABILITY_VERSION_3;
        if (syscall(SYS_capget, &header, data) != 0) return false;
        const unsigned index = static_cast<unsigned>(capability) >> 5;
        const unsigned bit = 1u << (static_cast<unsigned>(capability) & 31);
        return (data[index].permitted & bit) != 0;
    }

private:
    unsigned m_Index = 0;
    unsigned m_Bit = 0;
    bool m_Raised = false;
    bool m_Effective = false;
};

} // namespace mw::native::platform
