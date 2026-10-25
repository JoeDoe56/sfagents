/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#include <QObject>
#include <QTimer>

#include <functional>
#include <utility>

/// How long a session waits for its browser to open the signalling socket.
///
/// The page opens it as soon as /start answers, so it arrives within a second
/// or two, through the rendezvous tunnel too. A browser killed, closed or sent
/// to the background in between never comes, and nothing else ends the session:
/// the ICE deadline only starts once the browser's answer is in. On 20/10 such a
/// session encoded for nobody for 11 min, until the next /start took it over.
namespace mw::signaling {

/// Bruno's call (20/10): 30 to 60 s. Long past any real page, short enough
/// that a lost one gives the encoder and the display back quickly.
inline constexpr int kClientWaitMs = 45000;

/// Calls `giveUp` once, `ms` from now on `context`'s thread, unless `arrived`
/// says the browser came in the meantime. Nothing runs if `context` is gone
/// by then (a take-over tears the session down first).
inline void armClientWait(QObject* context, int ms, std::function<bool()> arrived,
                          std::function<void()> giveUp)
{
    QTimer::singleShot(ms, context, [arrived = std::move(arrived), giveUp = std::move(giveUp)]() {
        if (!arrived()) giveUp();
    });
}

} // namespace mw::signaling
