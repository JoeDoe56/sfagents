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

#include <windows.h>

#include <string>

namespace mw::native::platform {

/// Whether the adapter DXGI lists under @p luid is an indirect display
/// adapter that renders nothing itself: a virtual display driver built on
/// IddCx (Parsec, Virtual Display Driver, SudoVDA, MoonlightWeb's own) or a
/// DisplayLink dock.
///
/// DXGI lists each of them under a LUID of its own, but with the name, ids
/// and memory of the GPU that renders for it, and puts their screens under
/// that GPU. Measured on 27/09/2026: the N95's three virtual display drivers
/// made four "Intel(R) UHD Graphics", and Parsec on DualRTX a second "Arc
/// A380", none of the extra ones with a screen. Only the kernel tells them
/// apart (D3DKMT_ADAPTERTYPE: IndirectDisplayDevice without RenderSupported).
///
/// @p driver, when given, receives the kernel's name for it ("Parsec Virtual
/// Display Adapter"), left empty where the kernel does not say. False
/// whenever the kernel cannot be asked: a real GPU is never taken for one on
/// a doubt.
bool isIndirectDisplayOnly(const LUID& luid, std::wstring* driver = nullptr);

} // namespace mw::native::platform
