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

#include "FeedInfo.h"

#include <QJsonArray>

namespace feedinfo {

QJsonObject toJson(const mw::native::SessionInfo& info, int format, const QString& encoder,
                   const QString& description)
{
    QJsonObject j;
    j[QStringLiteral("type")] = QStringLiteral("info");
    j[QStringLiteral("displayId")] = info.displayId;
    j[QStringLiteral("width")] = info.width;
    j[QStringLiteral("height")] = info.height;
    j[QStringLiteral("fps")] = info.fps;
    // The enums travel as their values: both ends are the same build.
    j[QStringLiteral("codec")] = static_cast<int>(info.codec);
    j[QStringLiteral("encoderApi")] = static_cast<int>(info.encoder);
    j[QStringLiteral("format")] = format;
    j[QStringLiteral("gpu")] = QString::fromStdString(info.gpuName);
    j[QStringLiteral("encoder")] = encoder;
    j[QStringLiteral("description")] = description;
    j[QStringLiteral("hdr")] = info.hdr;
    j[QStringLiteral("displayWidth")] = info.displayWidth;
    j[QStringLiteral("displayHeight")] = info.displayHeight;
    j[QStringLiteral("displayHdr")] = info.displayHdr;
    j[QStringLiteral("hdrCapable")] = info.hdrCapable;
    j[QStringLiteral("desktop")] =
        QJsonArray{info.desktopLeft, info.desktopTop, info.desktopRight, info.desktopBottom};
    j[QStringLiteral("yuv444")] = info.yuv444;
    j[QStringLiteral("intraRefresh")] = info.intraRefresh;
    j[QStringLiteral("intraRefreshFrames")] = info.intraRefreshFrames;
    j[QStringLiteral("pipeline")] = static_cast<int>(info.videoPipeline);
    j[QStringLiteral("videoEncoder")] = QString::fromStdString(info.videoEncoder);
    j[QStringLiteral("videoEncoder12")] = static_cast<int>(info.videoEncoder12);
    j[QStringLiteral("pipelineRefused")] = info.videoPipelineRefused;
    return j;
}

bool fromJson(const QJsonObject& j, mw::native::SessionInfo& out, int& format, QString& encoder,
              QString& description)
{
    if (j.value(QStringLiteral("type")).toString() != QLatin1String("info")) return false;
    mw::native::SessionInfo info;
    info.displayId = j.value(QStringLiteral("displayId")).toInt(-1);
    info.width = j.value(QStringLiteral("width")).toInt();
    info.height = j.value(QStringLiteral("height")).toInt();
    if (info.width <= 0 || info.height <= 0) return false;
    info.fps = j.value(QStringLiteral("fps")).toInt();
    info.codec = static_cast<mw::native::Codec>(
        j.value(QStringLiteral("codec")).toInt(static_cast<int>(mw::native::Codec::H264)));
    info.encoder =
        static_cast<mw::native::EncoderApi>(j.value(QStringLiteral("encoderApi")).toInt());
    info.gpuName = j.value(QStringLiteral("gpu")).toString().toStdString();
    info.hdr = j.value(QStringLiteral("hdr")).toBool();
    info.displayWidth = j.value(QStringLiteral("displayWidth")).toInt();
    info.displayHeight = j.value(QStringLiteral("displayHeight")).toInt();
    info.displayHdr = j.value(QStringLiteral("displayHdr")).toBool();
    info.hdrCapable = j.value(QStringLiteral("hdrCapable")).toBool();
    const QJsonArray desktop = j.value(QStringLiteral("desktop")).toArray();
    if (desktop.size() == 4) {
        info.desktopLeft = desktop.at(0).toInt();
        info.desktopTop = desktop.at(1).toInt();
        info.desktopRight = desktop.at(2).toInt();
        info.desktopBottom = desktop.at(3).toInt();
    }
    info.yuv444 = j.value(QStringLiteral("yuv444")).toBool();
    info.intraRefresh = j.value(QStringLiteral("intraRefresh")).toBool();
    info.intraRefreshFrames =
        info.intraRefresh ? j.value(QStringLiteral("intraRefreshFrames")).toInt() : 0;
    // Never for a shared feed: a repair aimed at one receiver's loss would
    // be every receiver's next frame.
    info.referenceInvalidation = false;
    info.videoPipeline =
        static_cast<mw::native::VideoPipeline>(j.value(QStringLiteral("pipeline")).toInt());
    info.videoEncoder = j.value(QStringLiteral("videoEncoder")).toString().toStdString();
    info.videoEncoder12 = static_cast<mw::native::EncoderTuning::Encoder12>(
        j.value(QStringLiteral("videoEncoder12")).toInt());
    info.videoPipelineRefused = j.value(QStringLiteral("pipelineRefused")).toBool();
    // Nothing here is captured: the guest's own session says what it does
    // with audio.
    info.capture = mw::native::CaptureApi::None;
    out = info;
    format = j.value(QStringLiteral("format")).toInt();
    encoder = j.value(QStringLiteral("encoder")).toString();
    description = j.value(QStringLiteral("description")).toString();
    return true;
}

} // namespace feedinfo
