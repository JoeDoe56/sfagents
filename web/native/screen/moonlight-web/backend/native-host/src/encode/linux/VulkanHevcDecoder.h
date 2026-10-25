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
#include <memory>
#include <string>
#include <vector>

// The eyes of the Vulkan encoder's pixel proof (VulkanHevcProof): HEVC decode
// through Vulkan Video, on the GPU that encoded, of the streams this engine
// writes — one layer, I and P slices, references named by each slice's own
// short-term set, no tiles, no scaling list data, no long-term pictures, no
// missing reference. Anything else is refused by name: a decoder that guessed
// would prove nothing.
//
// Its output is the decoder's, read back to the CPU and cropped to the
// conformance window: what a browser would show.

namespace mw::native::vulkan {
class VulkanDevice;
}

namespace mw::native::encode {

class VulkanHevcDecoder
{
public:
    VulkanHevcDecoder();
    ~VulkanHevcDecoder();

    VulkanHevcDecoder(const VulkanHevcDecoder&) = delete;
    VulkanHevcDecoder& operator=(const VulkanHevcDecoder&) = delete;

    /// A decoder for the stream whose VPS, SPS and PPS are @p parameterSets
    /// (Annex-B), on @p device, opened with a decode queue
    /// (DeviceOptions::decodeHevc). Refused, with the reason, where the driver
    /// cannot or the stream is outside what is followed here.
    bool init(const std::shared_ptr<vulkan::VulkanDevice>& device,
              const std::vector<uint8_t>& parameterSets, std::string& error);

    /// One access unit — parameter sets in front of its slices are passed
    /// over — decoded, and the picture back as NV12 at the cropped size.
    bool decode(const uint8_t* data, size_t size, std::vector<uint8_t>& nv12, std::string& error);

    /// The picture's size once cropped.
    int width() const { return m_Width; }
    int height() const { return m_Height; }

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;

    bool createResources(std::string& error);
    bool createSession(std::string& error);

    int m_Width = 0;
    int m_Height = 0;
};

} // namespace mw::native::encode
