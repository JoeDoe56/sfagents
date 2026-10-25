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

#include "../../core/PointerPresence.h"

namespace mw::native {

/// PointerPresence's view of Windows: SM_MOUSEPRESENT and Mouse Keys, for the
/// console session the calling process sits in. No elevation needed, and the
/// same from a SYSTEM worker on the console desktop: the setting belongs to
/// the session, not to the account.
class Win32PointerSystem final : public PointerSystem
{
public:
    bool mousePresent() override;
    bool readMouseKeys(MouseKeysState& out) override;
    bool writeMouseKeys(const MouseKeysState& state) override;
};

} // namespace mw::native
