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

#include "DisplayOutputs.h"

#include <windows.h>

#include <dxgi.h>
#include <wrl/client.h>

#include <unordered_map>

using Microsoft::WRL::ComPtr;

namespace mw::native::platform {
namespace {

std::string narrow(const wchar_t* wide)
{
    if (!wide || !*wide) return {};
    const int bytes = ::WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
    if (bytes <= 1) return {};
    std::string out(static_cast<size_t>(bytes - 1), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), bytes, nullptr, nullptr);
    return out;
}

/// GDI source name → the monitor device path of each active target it feeds,
/// joined the way WindowsProbe's realDisplayModes() joins them. Empty when
/// QueryDisplayConfig does not answer.
std::unordered_map<std::string, std::vector<std::string>> monitorPathsBySource()
{
    std::unordered_map<std::string, std::vector<std::string>> bySource;

    UINT32 pathCount = 0;
    UINT32 modeCount = 0;
    if (::GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount) !=
        ERROR_SUCCESS)
        return bySource;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
    if (::QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(), &modeCount,
                             modes.data(), nullptr) != ERROR_SUCCESS)
        return bySource;
    paths.resize(pathCount);

    for (const DISPLAYCONFIG_PATH_INFO& path : paths) {
        DISPLAYCONFIG_SOURCE_DEVICE_NAME source = {};
        source.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = sizeof(source);
        source.header.adapterId = path.sourceInfo.adapterId;
        source.header.id = path.sourceInfo.id;
        if (::DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS) continue;

        DISPLAYCONFIG_TARGET_DEVICE_NAME target = {};
        target.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        target.header.size = sizeof(target);
        target.header.adapterId = path.targetInfo.adapterId;
        target.header.id = path.targetInfo.id;
        if (::DisplayConfigGetDeviceInfo(&target.header) != ERROR_SUCCESS) continue;

        const std::string devicePath = narrow(target.monitorDevicePath);
        if (!devicePath.empty()) bySource[narrow(source.viewGdiDeviceName)].push_back(devicePath);
    }
    return bySource;
}

} // namespace

bool adapterOutputs(uint64_t adapterLuid, std::vector<capture::OutputIdentity>& outputs,
                    std::string& error)
{
    outputs.clear();

    ComPtr<IDXGIFactory1> factory;
    if (FAILED(::CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        error = "DXGI is unavailable";
        return false;
    }
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0;
         factory->EnumAdapters1(i, adapter.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 desc = {};
        if (FAILED(adapter->GetDesc1(&desc))) continue;
        const uint64_t luid =
            (static_cast<uint64_t>(static_cast<uint32_t>(desc.AdapterLuid.HighPart)) << 32) |
            static_cast<uint64_t>(desc.AdapterLuid.LowPart);
        if (luid == adapterLuid) break;
        adapter.Reset();
    }
    if (!adapter) {
        error = "the GPU that drives that display is no longer present";
        return false;
    }

    const auto paths = monitorPathsBySource();
    ComPtr<IDXGIOutput> output;
    for (UINT j = 0;
         adapter->EnumOutputs(j, output.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND; ++j) {
        capture::OutputIdentity identity;
        DXGI_OUTPUT_DESC desc = {};
        // Kept even when it says nothing: the index is what matters, and an
        // output that cannot describe itself still holds its place.
        if (SUCCEEDED(output->GetDesc(&desc))) {
            identity.gdiName = narrow(desc.DeviceName);
            const auto found = paths.find(identity.gdiName);
            if (found != paths.end()) identity.monitorPaths = found->second;
        }
        outputs.push_back(std::move(identity));
    }
    return true;
}

} // namespace mw::native::platform
