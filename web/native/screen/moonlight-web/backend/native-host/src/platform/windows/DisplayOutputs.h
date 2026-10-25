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

#include "../../capture/windows/OutputMatch.h"

#include <cstdint>
#include <string>
#include <vector>

namespace mw::native::platform {

/// Every output of the adapter @p adapterLuid (packed as GpuInfo::nativeHandle)
/// in the order DXGI enumerates them — the index IDXGIAdapter::EnumOutputs
/// takes, which is what DxgiDuplication and WgcCapture are given — each with
/// its GDI name and the monitor device paths QueryDisplayConfig gives its
/// source (the probe's DisplayInfo::key). Unfiltered: an output off the
/// desktop still holds its index.
///
/// False with @p error when the adapter is gone. A QueryDisplayConfig that
/// fails is not an error: the outputs come back without paths, and
/// capture::outputIndexOf() then goes by GDI name.
bool adapterOutputs(uint64_t adapterLuid, std::vector<capture::OutputIdentity>& outputs,
                    std::string& error);

} // namespace mw::native::platform
