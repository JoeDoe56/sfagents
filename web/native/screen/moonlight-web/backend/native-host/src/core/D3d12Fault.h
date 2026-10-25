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

// The faults the D3D12 chain can be made to suffer, by MW_D3D12_FAULT=
// <kind>[@N] (plan pipeline-video-d3d12-v2, C8.1). Pure, so that it is tested
// everywhere; the chain reads the variable and acts on it (D3d12VideoPipeline).
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// D3D12 runs Intel's streams by default (§9-23), on one promise: nothing it
// does wrong ends a stream. A device removed, a GPU past its deadline, an
// encoder or a conversion that fails — the session goes back to D3D11 on one
// keyframe, and says why. Those are the paths no bench ever takes by itself:
// written once, never run, and found broken on the one machine that needed
// them. The reason MW_CAPTURE=wgc exists, and Linux's MW_VK_CONVERT_FAIL_AT.

#include <cctype>
#include <cstdint>
#include <string>

namespace mw::native {

struct D3d12Fault
{
    enum class Kind
    {
        None,
        /// The Nth D3D12 chain the process opens does not open, as on a GPU
        /// whose queue is refused: that build runs D3D11, and the next one
        /// asks for D3D12 again.
        Open,
        /// The Nth conversion is not recorded, as a list the driver refuses.
        Convert,
        /// The Nth conversion waits behind a fence nobody signals, so the
        /// encode after it runs past the deadline (d3d12::kGpuGoneMs); the GPU
        /// is let go once the chain has given up, as one that was only stuck
        /// behind a game would be.
        Timeout,
        /// The device is removed (ID3D12Device5::RemoveDevice) before the Nth
        /// conversion's picture is encoded: a TDR, a driver update.
        Removed,
        /// The Nth conversion's picture is encoded, then thrown away as one
        /// the driver flagged, or the header guard refused.
        Encode,
    };

    Kind kind = Kind::None;
    /// From 1: the Nth open of the process (Open), or the Nth conversion of a
    /// chain (the others).
    uint64_t at = 0;

    explicit operator bool() const { return kind != Kind::None; }
};

inline const char* toString(D3d12Fault::Kind kind)
{
    switch (kind) {
    case D3d12Fault::Kind::Open: return "open";
    case D3d12Fault::Kind::Convert: return "convert";
    case D3d12Fault::Kind::Timeout: return "timeout";
    case D3d12Fault::Kind::Removed: return "removed";
    case D3d12Fault::Kind::Encode: return "encode";
    case D3d12Fault::Kind::None: break;
    }
    return "none";
}

/// "removed@300", "Timeout@120", "encode": the kind, in any case, and where —
/// 1 when not said. False, @p out untouched, for anything else: an unknown
/// kind, @0, a place that does not read as a number to its end.
inline bool parseD3d12Fault(const std::string& text, D3d12Fault& out)
{
    const size_t sign = text.find('@');
    std::string name;
    for (char c : text.substr(0, sign))
        name += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    D3d12Fault fault;
    for (D3d12Fault::Kind kind :
         {D3d12Fault::Kind::Open, D3d12Fault::Kind::Convert, D3d12Fault::Kind::Timeout,
          D3d12Fault::Kind::Removed, D3d12Fault::Kind::Encode})
        if (name == toString(kind)) fault.kind = kind;
    if (!fault) return false;
    fault.at = 1;
    if (sign != std::string::npos) {
        const std::string place = text.substr(sign + 1);
        // Nine digits at most: a place past a billion pictures is a typo.
        if (place.empty() || place.size() > 9 ||
            place.find_first_not_of("0123456789") != std::string::npos)
            return false;
        fault.at = std::stoull(place);
        if (fault.at == 0) return false;
    }
    out = fault;
    return true;
}

/// "MW_D3D12_FAULT=removed@300": the fault as the log and the errors name it.
inline std::string describe(const D3d12Fault& fault)
{
    return std::string("MW_D3D12_FAULT=") + toString(fault.kind) + "@" + std::to_string(fault.at);
}

/// What the fault will do, for the log line that says it is armed.
inline std::string effect(const D3d12Fault& fault)
{
    const std::string n = std::to_string(fault.at);
    switch (fault.kind) {
    case D3d12Fault::Kind::Open: return "D3D12 chain " + n + " of this process does not open";
    case D3d12Fault::Kind::Convert: return "conversion " + n + " is not recorded";
    case D3d12Fault::Kind::Timeout:
        return "conversion " + n + " waits behind a fence nobody signals until the chain gives up";
    case D3d12Fault::Kind::Removed:
        return "the device is removed before the picture of conversion " + n + " is encoded";
    case D3d12Fault::Kind::Encode:
        return "the picture of conversion " + n + " is encoded, then thrown away as an error";
    case D3d12Fault::Kind::None: break;
    }
    return "nothing";
}

} // namespace mw::native
