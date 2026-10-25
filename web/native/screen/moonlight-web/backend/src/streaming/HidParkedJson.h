/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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

#include "mw/native/HidPassthrough.h"

#include <QJsonObject>

/// One force-feedback operation as the page's hidffb reads it: op, effect,
/// kind when there is one, then each field by name. The relay adds the
/// message's type and slot.
QJsonObject hidFfbToJson(const mw::native::HidFfb& op);
/// The reverse; type and slot are not fields.
mw::native::HidFfb hidFfbFromJson(const QJsonObject& o);

/// A parked device's state as it travels between the server and a stream's
/// worker (mw::native::HidParking::handOut, takeIn), bytes in base64. False
/// when it cannot be one: no descriptor, a report id or a size out of range.
/// The descriptor itself is checked again by the parking (hid::validate).
QJsonObject hidParkedToJson(const mw::native::HidParkedState& s);
bool hidParkedFromJson(const QJsonObject& o, mw::native::HidParkedState* s);
