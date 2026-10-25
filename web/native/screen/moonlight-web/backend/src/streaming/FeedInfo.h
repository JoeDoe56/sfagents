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

#include "mw/native/SessionConfig.h"

#include <QJsonObject>
#include <QString>

/// What the guests' shared feed says about itself (its `info` message), and
/// what a guest's worker reads back from it (plan « flux commun des invités »,
/// S4).
///
/// A guest's worker has no capture and no encoder: the session its browser is
/// told about — the codec it decodes, the frame's size, whether the stream
/// repairs itself by intra-refresh, where the display sits on the desktop for
/// the pointer — is the feed's, word for word. Pure, so both ends and a test
/// share one spelling of it.
namespace feedinfo {

/// The feed's session, as its `info` message. @p format is the VIDEO_FORMAT_*
/// bit of what it encodes; @p encoder the overlay's name for its encoder
/// ("NVENC", "D3D12 VE (Intel)"); @p description the log's line for it.
QJsonObject toJson(const mw::native::SessionInfo& info, int format, const QString& encoder,
                   const QString& description);

/// Read an `info` message back. False when it is not one, or names no frame:
/// a guest cannot describe to its browser a session it does not know.
bool fromJson(const QJsonObject& json, mw::native::SessionInfo& info, int& format, QString& encoder,
              QString& description);

} // namespace feedinfo
