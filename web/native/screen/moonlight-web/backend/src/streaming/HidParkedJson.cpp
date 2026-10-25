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

#include "HidParkedJson.h"

#include <QByteArray>
#include <QJsonArray>

#include <algorithm>

using mw::native::HidFfb;
using mw::native::HidParkedState;
using mw::native::HidParking;

namespace {

// A descriptor is 4096 bytes at most (hid::validate), a report far less; an
// effect table is a few dozen operations.
constexpr int kMaxDescriptor = 4096;
constexpr int kMaxReport = 4096;
constexpr int kMaxEffects = 1024;

QString base64(const std::vector<uint8_t>& bytes)
{
    return QString::fromLatin1(
        QByteArray(reinterpret_cast<const char*>(bytes.data()), static_cast<int>(bytes.size()))
            .toBase64());
}

std::vector<uint8_t> bytesOf(const QJsonValue& v, int max, bool* ok)
{
    const QByteArray b = QByteArray::fromBase64(v.toString().toLatin1());
    if (b.size() > max) *ok = false;
    return std::vector<uint8_t>(b.begin(), b.end());
}

QJsonArray reportsToJson(const std::vector<std::pair<uint8_t, std::vector<uint8_t>>>& reports)
{
    QJsonArray out;
    for (const auto& [id, bytes] : reports)
        out.append(
            QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("report"), base64(bytes)}});
    return out;
}

bool reportsFromJson(const QJsonValue& v,
                     std::vector<std::pair<uint8_t, std::vector<uint8_t>>>* out)
{
    bool ok = true;
    for (const QJsonValue& r : v.toArray()) {
        const int id = r[QLatin1String("id")].toInt(-1);
        if (id < 0 || id > 255) return false;
        out->emplace_back(static_cast<uint8_t>(id),
                          bytesOf(r[QLatin1String("report")], kMaxReport, &ok));
    }
    return ok;
}

} // namespace

QJsonObject hidFfbToJson(const HidFfb& op)
{
    QJsonObject m{{QStringLiteral("op"), QString::fromStdString(op.op)},
                  {QStringLiteral("effect"), op.effect}};
    if (!op.kind.empty()) m[QStringLiteral("kind")] = QString::fromStdString(op.kind);
    for (const auto& [name, value] : op.fields)
        m[QString::fromStdString(name)] = value;
    return m;
}

HidFfb hidFfbFromJson(const QJsonObject& o)
{
    HidFfb op;
    for (auto it = o.begin(); it != o.end(); ++it) {
        const QString key = it.key();
        if (key == QLatin1String("op"))
            op.op = it.value().toString().toStdString();
        else if (key == QLatin1String("effect"))
            op.effect = it.value().toInt();
        else if (key == QLatin1String("kind"))
            op.kind = it.value().toString().toStdString();
        else if (key != QLatin1String("type") && key != QLatin1String("slot") &&
                 it.value().isDouble())
            op.fields.emplace_back(key.toStdString(), it.value().toInt());
    }
    return op;
}

QJsonObject hidParkedToJson(const HidParkedState& s)
{
    QJsonArray effects;
    for (const HidFfb& op : s.effects)
        effects.append(hidFfbToJson(op));
    return QJsonObject{{QStringLiteral("name"), QString::fromStdString(s.name)},
                       {QStringLiteral("vendorId"), s.vendorId},
                       {QStringLiteral("productId"), s.productId},
                       {QStringLiteral("version"), s.version},
                       {QStringLiteral("descriptor"), base64(s.descriptor)},
                       {QStringLiteral("first"), reportsToJson(s.first)},
                       {QStringLiteral("last"), reportsToJson(s.last)},
                       {QStringLiteral("pidFirstId"), s.pidFirstId},
                       {QStringLiteral("pidState"), base64(s.pidState)},
                       {QStringLiteral("effects"), effects},
                       {QStringLiteral("keepMs"), static_cast<double>(s.keepMs)}};
}

bool hidParkedFromJson(const QJsonObject& o, HidParkedState* s)
{
    *s = HidParkedState();
    bool ok = true;
    s->name = o[QLatin1String("name")].toString().left(120).toStdString();
    auto u16 = [&](const char* key) {
        const int v = o[QLatin1String(key)].toInt(-1);
        if (v < 0 || v > 0xFFFF) ok = false;
        return static_cast<uint16_t>(v);
    };
    s->vendorId = u16("vendorId");
    s->productId = u16("productId");
    s->version = u16("version");
    s->descriptor = bytesOf(o[QLatin1String("descriptor")], kMaxDescriptor, &ok);
    if (s->descriptor.empty()) ok = false;
    if (!reportsFromJson(o[QLatin1String("first")], &s->first) ||
        !reportsFromJson(o[QLatin1String("last")], &s->last))
        ok = false;
    const int pidFirstId = o[QLatin1String("pidFirstId")].toInt(0);
    if (pidFirstId < 0 || pidFirstId > 255) ok = false;
    s->pidFirstId = static_cast<uint8_t>(pidFirstId);
    s->pidState = bytesOf(o[QLatin1String("pidState")], 256, &ok);
    const QJsonArray effects = o[QLatin1String("effects")].toArray();
    if (effects.size() > kMaxEffects) ok = false;
    for (const QJsonValue& e : effects)
        s->effects.push_back(hidFfbFromJson(e.toObject()));
    s->keepMs = std::clamp<int64_t>(static_cast<int64_t>(o[QLatin1String("keepMs")].toDouble()), 0,
                                    HidParking::kKeepMs);
    return ok;
}
