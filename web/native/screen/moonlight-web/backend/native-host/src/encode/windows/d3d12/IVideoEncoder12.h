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

#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"
#include "encode/EncoderOutput.h"

#include <d3d12.h>

#include <cstdint>
#include <memory>
#include <string>

namespace mw::native::d3d12 {
class D3d12Device;
}

namespace mw::native::encode {

/// A hardware encoder fed D3D12 pictures: D3D12 Video Encode (VideoEncode12),
/// then NVENC and AMF through their D3D12 interfaces (plan Phase 7).
///
/// The D3D12 pipeline's contract (plan §3.1): the conversion writes the picture
/// at the encoder's coded size — codedWidth() × codedHeight(), asked of the
/// encoder before the conversion is set up — leaves it in COMMON and signals a
/// fence; encode() waits for that fence ON THE GPU, and the CPU waits once per
/// picture, for the bitstream. The same zero-copy rule as IVideoEncoder: the
/// texture the conversion wrote is the one encoded.
class IVideoEncoder12
{
public:
    virtual ~IVideoEncoder12() = default;

    IVideoEncoder12(const IVideoEncoder12&) = delete;
    IVideoEncoder12& operator=(const IVideoEncoder12&) = delete;

    /// @param width, height the picture as the viewer sees it; the encoder
    ///        codes it at codedWidth() × codedHeight() and crops.
    /// @param hdr P010 in, Main 10 with BT.2020 PQ out.
    /// The rest as IVideoEncoder::init.
    virtual bool init(const std::shared_ptr<d3d12::D3d12Device>& device, Codec codec, int width,
                      int height, int fps, int bitrateKbps, bool hdr, bool intraRefresh,
                      const EncoderTuning& tuning, std::string& error) = 0;

    virtual int codedWidth() const = 0;
    virtual int codedHeight() const = 0;

    /// Encode @p picture once @p ready reaches @p readyValue. Blocking:
    /// returns with the bitstream ready.
    virtual bool encode(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                        bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                        std::string& error) = 0;

    virtual bool supportsReferenceInvalidation() const { return false; }
    virtual bool invalidateReference(uint32_t frameNumber, std::string& error)
    {
        (void)frameNumber;
        error = "reference invalidation is not available on this encoder";
        return false;
    }

    /// Where whatever writes the picture next must wait, on the GPU, before it
    /// does: the fence and its value — the encoder may still be putting the
    /// picture back in the COMMON state the conversion expects (AMF leaves it
    /// in COPY_SOURCE). Null when the bitstream's arrival said it all.
    virtual ID3D12Fence* inputReleased(uint64_t& value) const
    {
        value = 0;
        return nullptr;
    }

    /// Release the buffer handed out by the last encode(). Must be called
    /// before the next encode().
    virtual void releaseOutput() = 0;
    virtual void stop() = 0;
    virtual bool setBitrate(int bitrateKbps, std::string& error) = 0;
    virtual bool intraRefreshEnabled() const = 0;
    virtual int intraRefreshHorizonFrames() const { return 0; }

    /// The encoder, for the log and the overlay: "D3D12 VE", "NVENC (D3D12)".
    virtual std::string describe() const = 0;

protected:
    IVideoEncoder12() = default;
};

} // namespace mw::native::encode
