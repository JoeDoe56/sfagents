/*
 * MoonlightWeb — POC Ultra: the PyroWave encoder on D3D12 compute.
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
 *
 * Ported from PyroWave by Hans-Kristian Arntzen (MIT, commit 509e4f88): the
 * host side of pyrowave_encoder.cpp (band layout, quant resolutions, the
 * perceptual weights, packetization). See PyroWaveEncoder12.hlsl.
 */

#pragma once

#include <d3d12.h>
#include <wrl/client.h>

#include <cstdint>
#include <string>
#include <vector>

namespace mw::native::encode {

// Encodes 8-bit 4:2:0 pictures to PyroWave on a D3D12 compute queue.
//
//   init()     once per size
//   record()   the picture (8-bit 4:2:0 in a buffer in NON_PIXEL_SHADER_RESOURCE
//              state, laid out as a SourceLayout says) to the stream, and
//              copies of what the CPU needs into readback memory
//   packets()  after the GPU is done: the frame, cut into network packets
class PyroWaveEncoder12
{
public:
    // GPU time of each stage of the last frame, from its timestamps.
    struct StageTimes
    {
        double dwt = 0, quant = 0, analyze = 0, resolve = 0, pack = 0;
        double total() const { return dwt + quant + analyze + resolve + pack; }
    };

    // Where the picture's samples sit in the source buffer, in bytes. Planar
    // (Y, then Cb, then Cr: a Y4M frame) or NV12 as copied from a texture
    // (Cb and Cr interleaved: crOffset = cbOffset + 1).
    struct SourceLayout
    {
        uint32_t yOffset = 0, yPitch = 0;
        uint32_t cbOffset = 0, crOffset = 0, cPitch = 0;
        bool interleaved = false;
        uint32_t bytes = 0; // the buffer's size, every read is kept inside it
    };
    static SourceLayout planar(int width, int height);

    bool init(ID3D12Device* device, int width, int height, std::string* error);

    // `targetBytes`: the frame may not exceed it (the rate control's bound).
    // `timestamps`: a heap of at least 6 queries, written from `firstQuery`.
    void record(ID3D12GraphicsCommandList* cmd, ID3D12Resource* source, const SourceLayout& layout,
                size_t targetBytes, ID3D12QueryHeap* timestamps, UINT firstQuery,
                ID3D12Resource* timestampReadback);

    // The frame as packets of at most `packetBoundary` bytes (a block is never
    // split: a block larger than the boundary is a packet of its own), the
    // start-of-frame header first. False if the GPU wrote nonsense.
    bool packets(size_t packetBoundary, std::vector<std::vector<uint8_t>>& out, std::string* error);

    // Lab: runs SelfTestCS (the stream writer alone) and copies its 32 bytes
    // to the stream readback; read them with selfTestBytes() once done.
    void recordSelfTest(ID3D12GraphicsCommandList* cmd);
    std::vector<uint8_t> selfTestBytes();

    static StageTimes stageTimes(ID3D12Resource* timestampReadback, UINT firstQuery,
                                 uint64_t frequency);

    int width() const { return m_Width; }
    int height() const { return m_Height; }
    size_t sourceBytes() const { return size_t(m_Width) * m_Height * 3 / 2; }

    // For the lab: the wavelet bands of the last frame (f32, in UAV state),
    // and where a band's plane starts in it.
    ID3D12Resource* coefficients() const { return m_Coef.Get(); }
    ID3D12Resource* blockMeta() const { return m_Meta.Get(); }
    uint32_t blockCount8x8() const { return m_Blocks8; }
    uint32_t coefficientCount() const { return m_CoefFloats; }
    uint32_t planeOffset(int level, int component, int band) const
    {
        return m_PlaneOf[level][component][band];
    }
    int alignedWidth() const { return m_AlignedW; }
    int alignedHeight() const { return m_AlignedH; }

private:
    struct Band
    {
        int level, component, band;
        uint32_t plane, width, height;
        uint32_t blocks8x, blocks8y, first8;
        uint32_t blocks32x, blocks32y, first32;
        float quantResolution, rdoScale;
        uint32_t quantCode;
    };

    void layout();
    bool pipelines(std::string* error);
    Microsoft::WRL::ComPtr<ID3D12Resource> buffer(uint64_t size, D3D12_HEAP_TYPE heap,
                                                  D3D12_RESOURCE_STATES state);

    ID3D12Device* m_Device = nullptr;
    int m_Width = 0, m_Height = 0, m_AlignedW = 0, m_AlignedH = 0;
    std::vector<Band> m_Bands;
    std::vector<uint32_t> m_SendOrder; // block indices in the order packets() sends them
    uint32_t m_PlaneOf[5][3][4] = {};
    uint32_t m_CoefFloats = 0, m_Blocks8 = 0, m_Blocks32 = 0;
    uint32_t m_PerSubdivision = 0, m_SubdivisionShift = 0, m_BucketBytes = 0;
    uint32_t m_StreamBytes = 0;
    uint32_t m_Sequence = 0;

    Microsoft::WRL::ComPtr<ID3D12RootSignature> m_Root;
    Microsoft::WRL::ComPtr<ID3D12PipelineState> m_Dwt, m_Quant, m_Analyze, m_Finalize, m_Resolve,
        m_Pack, m_Clear, m_SelfTest;
    Microsoft::WRL::ComPtr<ID3D12Resource> m_Coef, m_Meta, m_Stats, m_Scratch, m_Buckets,
        m_QuantBuf, m_Stream, m_Packets, m_StreamReadback, m_PacketsReadback;
};

} // namespace mw::native::encode
