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

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

namespace mw::native::encode {

/// A fingerprint of the configuration an encoder handed its driver: FNV-1a
/// over the bytes of the structures (NVENC) or over the properties read back
/// once the encoder is initialized (AMF).
///
/// In each encoder's ready line, and asked of it by the tests: it is what makes
/// "this refactor changes no setting" a comparison instead of a claim (plan
/// pipeline-video-d3d12-v2, C7.1 and C7.3), and what holds the D3D12 encoders
/// to the configuration of the D3D11 ones they stand beside (C7.2, C7.4). The
/// value means nothing on its own; two of them are equal or they are not.
class ConfigFingerprint
{
public:
    void add(const void* data, size_t size)
    {
        const auto* bytes = static_cast<const uint8_t*>(data);
        for (size_t i = 0; i < size; ++i) {
            m_Hash ^= bytes[i];
            m_Hash *= 16777619u;
        }
    }

    template <typename T> void addValue(const T& value) { add(&value, sizeof(value)); }

    uint32_t value() const { return m_Hash; }

    /// Eight hex digits, as the ready lines print it.
    static std::string text(uint32_t value)
    {
        char digits[16];
        std::snprintf(digits, sizeof(digits), "%08x", value);
        return digits;
    }

private:
    uint32_t m_Hash = 2166136261u;
};

} // namespace mw::native::encode
