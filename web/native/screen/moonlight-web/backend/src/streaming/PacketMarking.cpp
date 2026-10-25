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
#include "PacketMarking.h"

#include "../server/AppSettings.h"

#include <rtc/global.hpp>

#include <QDebug>
#include <QString>

#include <atomic>

namespace PacketMarking {

void apply()
{
    const auto values =
        resolve(AppSettings().packetMarking(), qEnvironmentVariable("MW_DSCP").toStdString());
    rtc::DscpSettings s;
    s.audio = values[0];
    s.video = values[1];
    s.data = values[2];
    rtc::SetDscpSettings(s);

    static std::atomic<unsigned int> logged{~0u};
    const unsigned int key = values[0] << 12 | values[1] << 6 | values[2];
    if (logged.exchange(key) != key)
        qInfo().noquote() << QStringLiteral("[PacketMarking] DSCP audio %1, video %2, data %3")
                                 .arg(values[0])
                                 .arg(values[1])
                                 .arg(values[2]);
}

} // namespace PacketMarking
