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

#include "IndirectDisplay.h"

namespace mw::native::platform {
namespace {

// d3dkmthk.h is a WDK header; the entry points live in gdi32 and are looked
// up, and the structures they take are restated as the header lays them out
// (as StreamPriority.cpp does).
struct KmtOpenAdapterFromLuid
{
    LUID luid;
    UINT adapter;
};
struct KmtQueryAdapterInfo
{
    UINT adapter;
    int type;
    void* data;
    UINT size;
};
struct KmtCloseAdapter
{
    UINT adapter;
};
constexpr int KmtQaiAdapterType = 15;              // KMTQAITYPE_ADAPTERTYPE
constexpr int KmtQaiDriverDescription = 65;        // KMTQAITYPE_DRIVER_DESCRIPTION (WDDM 2.6)
constexpr UINT KmtRenderSupported = 0x1;           // D3DKMT_ADAPTERTYPE bit 0
constexpr UINT KmtIndirectDisplayDevice = 0x40;    // D3DKMT_ADAPTERTYPE bit 6
constexpr size_t KmtDriverDescriptionChars = 4096; // D3DKMT_DRIVER_DESCRIPTION
using OpenAdapterFromLuidFn = LONG(APIENTRY*)(KmtOpenAdapterFromLuid*);
using QueryAdapterInfoFn = LONG(APIENTRY*)(const KmtQueryAdapterInfo*);
using CloseAdapterFn = LONG(APIENTRY*)(const KmtCloseAdapter*);

} // namespace

bool isIndirectDisplayOnly(const LUID& luid, std::wstring* driver)
{
    if (driver) driver->clear();
    HMODULE gdi = ::GetModuleHandleW(L"gdi32.dll");
    if (!gdi) gdi = ::LoadLibraryW(L"gdi32.dll");
    if (!gdi) return false;
    const auto open =
        reinterpret_cast<OpenAdapterFromLuidFn>(::GetProcAddress(gdi, "D3DKMTOpenAdapterFromLuid"));
    const auto query =
        reinterpret_cast<QueryAdapterInfoFn>(::GetProcAddress(gdi, "D3DKMTQueryAdapterInfo"));
    const auto close =
        reinterpret_cast<CloseAdapterFn>(::GetProcAddress(gdi, "D3DKMTCloseAdapter"));
    if (!open || !query || !close) return false;

    KmtOpenAdapterFromLuid opened = {luid, 0};
    if (open(&opened) != 0) return false;
    UINT type = 0;
    const KmtQueryAdapterInfo askType = {opened.adapter, KmtQaiAdapterType, &type, sizeof(type)};
    const bool indirect = query(&askType) == 0 && (type & KmtIndirectDisplayDevice) != 0 &&
                          (type & KmtRenderSupported) == 0;
    if (indirect && driver) {
        std::wstring name(KmtDriverDescriptionChars, L'\0');
        const KmtQueryAdapterInfo askName = {
            opened.adapter, KmtQaiDriverDescription, name.data(),
            static_cast<UINT>(KmtDriverDescriptionChars * sizeof(wchar_t))};
        if (query(&askName) == 0) {
            const size_t end = name.find(L'\0');
            if (end != std::wstring::npos) name.resize(end);
            *driver = std::move(name);
        }
    }
    const KmtCloseAdapter closing = {opened.adapter};
    close(&closing);
    return indirect;
}

} // namespace mw::native::platform
