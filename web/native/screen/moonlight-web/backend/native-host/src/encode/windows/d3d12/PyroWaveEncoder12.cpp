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
 * Ported from PyroWave by Hans-Kristian Arntzen, MIT licence, commit 509e4f88
 * (pyrowave_encoder.cpp, pyrowave_common.hpp/.cpp):
 *
 *   Copyright (c) 2025 Hans-Kristian Arntzen
 *   SPDX-License-Identifier: MIT
 */

#include "PyroWaveEncoder12.h"

#include "PyroWaveEncoder12Hlsl.h" // generated: kPyroWaveEncoderHlsl

#include <d3dcompiler.h>

#include <algorithm>
#include <cmath>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace mw::native::encode {

namespace {

constexpr int kLevels = 5;
constexpr int kAlign = 1 << kLevels;
constexpr int kMinSize = 4 << kLevels;
constexpr int kBuckets = 128;
constexpr int kSubdivisions = 16;
constexpr uint32_t kStatsStride = 132;
constexpr uint32_t kSequenceMask = 7;

int alignUp(int v, int a)
{
    return (v + a - 1) & ~(a - 1);
}

uint32_t nextPow2(uint32_t v)
{
    uint32_t p = 1;
    while (p < v)
        p <<= 1;
    return p;
}

// Upstream's custom float for a block's dequantization step.
float decodeQuant(uint32_t code)
{
    int e = 4 - int(code >> 3);
    int m = int(code & 7);
    return float(8 + m) * std::exp2(float(e - 3));
}

uint32_t encodeQuant(float decoderScale)
{
    uint32_t v;
    std::memcpy(&v, &decoderScale, sizeof v);
    int e = int((v >> 23) & 0xff) - 127 - 4;
    int m = int((v >> 20) & 7);
    e = -e;
    return uint32_t((e << 3) | m);
}

// Upstream: a flat spectrum with noise power normalization, the CDF 9/7
// low-pass gain being 6 dB a level (precision 1: FP32 arithmetic).
float noiseNormalizedResolution(int level, int component, int band)
{
    int bits = 8;
    if (band == 0)
        bits += 2;
    else if (band < 3)
        bits += 1;
    bits += level;
    if (component != 0) bits--;
    return float(1 << bits);
}

// Upstream's perceptual weight of a band: a contrast sensitivity function at
// the band's frequency, for a 96 dpi screen at one unit of distance, chroma
// discounted under 4:2:0. In power, not amplitude.
float rdoDistortionScale(int level, int component, int band)
{
    float horiz = (band & 1) ? 0.75f : 0.25f;
    float vert = (band & 2) ? 0.75f : 0.25f;
    constexpr float dpi = 96.0f;
    constexpr float viewingDistance = 1.0f;
    constexpr float cpdNyquist = 0.34f * viewingDistance * dpi;
    float cpd = std::sqrt(horiz * horiz + vert * vert) * cpdNyquist * std::exp2(-float(level));
    cpd = (std::max)(cpd, 8.0f);
    float csf = 2.6f * (0.0192f + 0.114f * cpd) * std::exp(-std::pow(0.114f * cpd, 1.1f));
    if (component != 0 && level != kLevels - 1) csf *= 0.6f;
    float weighted = csf * noiseNormalizedResolution(level, component, band);
    return weighted * weighted;
}

D3D12_RESOURCE_BARRIER uavBarrier()
{
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
    b.UAV.pResource = nullptr;
    return b;
}

D3D12_RESOURCE_BARRIER transition(ID3D12Resource* r, D3D12_RESOURCE_STATES before,
                                  D3D12_RESOURCE_STATES after)
{
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = r;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = before;
    b.Transition.StateAfter = after;
    return b;
}

} // namespace

ComPtr<ID3D12Resource> PyroWaveEncoder12::buffer(uint64_t size, D3D12_HEAP_TYPE heap,
                                                 D3D12_RESOURCE_STATES state)
{
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = heap;
    D3D12_RESOURCE_DESC desc = {};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    desc.Width = (std::max<uint64_t>)(size, 256);
    desc.Height = 1;
    desc.DepthOrArraySize = 1;
    desc.MipLevels = 1;
    desc.SampleDesc.Count = 1;
    desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    if (heap == D3D12_HEAP_TYPE_DEFAULT) desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
    ComPtr<ID3D12Resource> r;
    if (FAILED(m_Device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr,
                                                 IID_PPV_ARGS(&r))))
        return nullptr;
    return r;
}

// Planes, bands and block indices in the order of bitstream.md.
void PyroWaveEncoder12::layout()
{
    const uint32_t W = uint32_t(m_AlignedW), H = uint32_t(m_AlignedH);
    uint32_t floats = 0;
    for (int level = 0; level < kLevels; level++)
        for (int c = 0; c < 3; c++) {
            if (level == 0 && c != 0) continue;
            for (int b = 0; b < 4; b++) {
                m_PlaneOf[level][c][b] = floats;
                floats += (W >> (level + 1)) * (H >> (level + 1));
            }
        }
    m_CoefFloats = floats;

    m_Bands.clear();
    m_Blocks8 = 0;
    m_Blocks32 = 0;
    for (int level = kLevels - 1; level >= 0; level--)
        for (int c = 0; c < 3; c++) {
            if (level == 0 && c != 0) continue;
            for (int b = (level == kLevels - 1 ? 0 : 1); b < 4; b++) {
                Band band = {};
                band.level = level;
                band.component = c;
                band.band = b;
                band.plane = m_PlaneOf[level][c][b];
                band.width = W >> (level + 1);
                band.height = H >> (level + 1);
                band.blocks8x = (band.width + 7) / 8;
                band.blocks8y = (band.height + 7) / 8;
                band.blocks32x = (band.width + 31) / 32;
                band.blocks32y = (band.height + 31) / 32;
                band.first8 = m_Blocks8;
                band.first32 = m_Blocks32;
                m_Blocks8 += band.blocks8x * band.blocks8y;
                m_Blocks32 += band.blocks32x * band.blocks32y;
                float res = (std::min)(4096.0f, noiseNormalizedResolution(level, c, b));
                band.quantCode = encodeQuant(1.0f / res);
                band.quantResolution = 1.0f / decodeQuant(band.quantCode);
                band.rdoScale = rdoDistortionScale(level, c, b) * (1.0f / 256.0f);
                m_Bands.push_back(band);
            }
        }

    // The order blocks go out in: index order, except the finest level (luma
    // only, the last three bands, the largest), whose three bands are
    // interleaved by rows of blocks. A decoder by slices can then rebuild the
    // top of the picture while its bottom is still on the wire. A decoder
    // doesn't depend on the order: each block carries its index.
    m_SendOrder.clear();
    m_SendOrder.reserve(m_Blocks32);
    const size_t fine = m_Bands.size() - 3;
    for (uint32_t i = 0; i < m_Bands[fine].first32; i++)
        m_SendOrder.push_back(i);
    for (uint32_t y = 0; y < m_Bands[fine].blocks32y; y++)
        for (size_t k = fine; k < m_Bands.size(); k++)
            for (uint32_t x = 0; x < m_Bands[k].blocks32x; x++)
                m_SendOrder.push_back(m_Bands[k].first32 + y * m_Bands[k].blocks32x + x);
    m_PerSubdivision =
        nextPow2((uint32_t(alignUp(int(m_Blocks32), kSubdivisions))) / kSubdivisions);
    m_SubdivisionShift = 0;
    while ((1u << m_SubdivisionShift) < m_PerSubdivision)
        m_SubdivisionShift++;
    m_BucketBytes =
        64 + kBuckets * kSubdivisions * 4 + kBuckets * m_PerSubdivision * kSubdivisions * 8;
    m_StreamBytes = W * H * 2 + m_Blocks32 * 16;
}

bool PyroWaveEncoder12::pipelines(std::string* error)
{
    // Root: 16 constants, the source as SRV, eight UAVs, all root descriptors.
    D3D12_ROOT_PARAMETER params[10] = {};
    params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    params[0].Constants.Num32BitValues = 16;
    params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_SRV;
    for (int i = 0; i < 8; i++) {
        params[2 + i].ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
        params[2 + i].Descriptor.ShaderRegister = UINT(i);
    }
    D3D12_ROOT_SIGNATURE_DESC rs = {};
    rs.NumParameters = 10;
    rs.pParameters = params;
    ComPtr<ID3DBlob> blob, err;
    if (FAILED(D3D12SerializeRootSignature(&rs, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &err))) {
        *error = "root signature: " + std::string(err ? (const char*)err->GetBufferPointer() : "");
        return false;
    }
    if (FAILED(m_Device->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(),
                                             IID_PPV_ARGS(&m_Root)))) {
        *error = "CreateRootSignature failed";
        return false;
    }

    struct Entry
    {
        const char* name;
        ComPtr<ID3D12PipelineState>* pso;
    } entries[] = {{"DwtCS", &m_Dwt},         {"QuantCS", &m_Quant},
                   {"AnalyzeCS", &m_Analyze}, {"FinalizeCS", &m_Finalize},
                   {"ResolveCS", &m_Resolve}, {"PackCS", &m_Pack},
                   {"ClearCS", &m_Clear},     {"SelfTestCS", &m_SelfTest}};
    for (auto& e : entries) {
        ComPtr<ID3DBlob> code, messages;
        HRESULT hr = D3DCompile(kPyroWaveEncoderHlsl, std::strlen(kPyroWaveEncoderHlsl),
                                "PyroWaveEncoder12.hlsl", nullptr, nullptr, e.name, "cs_5_0",
                                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &messages);
        if (FAILED(hr)) {
            *error = std::string(e.name) + ": " +
                     (messages ? std::string((const char*)messages->GetBufferPointer())
                               : "compile failed");
            return false;
        }
        D3D12_COMPUTE_PIPELINE_STATE_DESC pd = {};
        pd.pRootSignature = m_Root.Get();
        pd.CS = {code->GetBufferPointer(), code->GetBufferSize()};
        if (FAILED(
                m_Device->CreateComputePipelineState(&pd, IID_PPV_ARGS(e.pso->GetAddressOf())))) {
            *error = std::string(e.name) + ": CreateComputePipelineState failed";
            return false;
        }
    }
    return true;
}

bool PyroWaveEncoder12::init(ID3D12Device* device, int width, int height, std::string* error)
{
    if (width <= 0 || height <= 0 || (width & 1) || (height & 1) || width > 16384 ||
        height > 16384) {
        *error = "the size must be even, at most 16384";
        return false;
    }
    m_Device = device;
    m_Width = width;
    m_Height = height;
    m_AlignedW = (std::max)(alignUp(width, kAlign), kMinSize);
    m_AlignedH = (std::max)(alignUp(height, kAlign), kMinSize);
    layout();
    if (m_Blocks32 > 0xffff) {
        // The rate control packs a block index in 16 bits, as upstream does.
        *error = "picture too large for the rate control (more than 65535 32x32 blocks)";
        return false;
    }
    if (!pipelines(error)) return false;

    const auto UA = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
    m_Coef = buffer(uint64_t(m_CoefFloats) * 4, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_Meta = buffer(uint64_t(m_Blocks8) * 4, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_Stats = buffer(uint64_t(m_Blocks8) * kStatsStride, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_Scratch = buffer(uint64_t(m_Blocks8) * 8 * 16, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_Buckets = buffer(m_BucketBytes, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_QuantBuf = buffer(uint64_t(m_Blocks32) * 4, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_Stream = buffer(m_StreamBytes, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_Packets = buffer(uint64_t(m_Blocks32) * 8, D3D12_HEAP_TYPE_DEFAULT, UA);
    m_StreamReadback =
        buffer(m_StreamBytes, D3D12_HEAP_TYPE_READBACK, D3D12_RESOURCE_STATE_COPY_DEST);
    m_PacketsReadback = buffer(uint64_t(m_Blocks32) * 8 + 16, D3D12_HEAP_TYPE_READBACK,
                               D3D12_RESOURCE_STATE_COPY_DEST);
    for (auto* r : {m_Coef.Get(), m_Meta.Get(), m_Stats.Get(), m_Scratch.Get(), m_Buckets.Get(),
                    m_QuantBuf.Get(), m_Stream.Get(), m_Packets.Get(), m_StreamReadback.Get(),
                    m_PacketsReadback.Get()}) {
        if (!r) {
            *error = "buffer allocation failed";
            return false;
        }
    }
    return true;
}

PyroWaveEncoder12::SourceLayout PyroWaveEncoder12::planar(int width, int height)
{
    SourceLayout l;
    const uint32_t w = uint32_t(width), h = uint32_t(height);
    l.yOffset = 0;
    l.yPitch = w;
    l.cbOffset = w * h;
    l.crOffset = w * h + (w / 2) * (h / 2);
    l.cPitch = w / 2;
    l.bytes = w * h * 3 / 2;
    return l;
}

void PyroWaveEncoder12::record(ID3D12GraphicsCommandList* cmd, ID3D12Resource* source,
                               const SourceLayout& src, size_t targetBytes,
                               ID3D12QueryHeap* timestamps, UINT q,
                               ID3D12Resource* timestampReadback)
{
    m_Sequence = (m_Sequence + 1) & kSequenceMask;
    cmd->SetComputeRootSignature(m_Root.Get());
    cmd->SetComputeRootShaderResourceView(1, source->GetGPUVirtualAddress());
    ID3D12Resource* uavs[8] = {m_Coef.Get(),    m_Meta.Get(),     m_Stats.Get(),  m_Scratch.Get(),
                               m_Buckets.Get(), m_QuantBuf.Get(), m_Stream.Get(), m_Packets.Get()};
    for (int i = 0; i < 8; i++)
        cmd->SetComputeRootUnorderedAccessView(2 + i, uavs[i]->GetGPUVirtualAddress());
    auto constants = [&](std::initializer_list<uint32_t> values) {
        uint32_t c[16] = {};
        int i = 0;
        for (uint32_t v : values)
            c[i++] = v;
        cmd->SetComputeRoot32BitConstants(0, 16, c, 0);
    };
    auto f32 = [](float v) {
        uint32_t u;
        std::memcpy(&u, &v, 4);
        return u;
    };
    const D3D12_RESOURCE_BARRIER uav = uavBarrier();
    auto groups = [](uint32_t n, uint32_t size) { return (n + size - 1) / size; };

    cmd->EndQuery(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q + 0);
    cmd->SetPipelineState(m_Clear.Get());
    const uint32_t bucketWords = m_BucketBytes / 4;
    constants({bucketWords, m_Blocks32});
    cmd->Dispatch(groups((std::max)(bucketWords, m_Blocks32), 64), 1, 1);

    // Forward DWT, level by level; a level's components run side by side.
    cmd->SetPipelineState(m_Dwt.Get());
    const uint32_t W = uint32_t(m_AlignedW), H = uint32_t(m_AlignedH);
    const uint32_t w = uint32_t(m_Width), h = uint32_t(m_Height);
    for (int level = 0; level < kLevels; level++) {
        for (int c = 0; c < 3; c++) {
            if (level == 0 && c != 0) continue;
            uint32_t rw, rh, nw, nh, kind, off, stride;
            if (level == 0) { // the luma plane
                rw = w, rh = h, nw = W, nh = H, kind = 0, off = src.yOffset, stride = src.yPitch;
            } else if (level == 1 && c != 0) { // a chroma plane: 4:2:0 starts here
                rw = w / 2, rh = h / 2, nw = W / 2, nh = H / 2;
                kind = src.interleaved ? 2 : 0;
                off = c == 1 ? src.cbOffset : src.crOffset;
                stride = src.cPitch;
            } else { // the LL band of the level above
                nw = W >> level, nh = H >> level, rw = nw, rh = nh, kind = 1;
                off = m_PlaneOf[level - 1][c][0];
                stride = nw;
            }
            const uint32_t* p = m_PlaneOf[level][c];
            constants({rw, rh, nw, nh, kind, off, stride, p[0], p[1], p[2], p[3], nw / 2, nh / 2,
                       src.bytes, m_CoefFloats});
            cmd->Dispatch(groups(nw, 32), groups(nh, 32), 1);
        }
        cmd->ResourceBarrier(1, &uav);
    }
    cmd->EndQuery(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q + 1);

    cmd->SetPipelineState(m_Quant.Get());
    for (const Band& b : m_Bands) {
        constants({b.plane, b.width, b.height, b.blocks8x, b.blocks8y, b.first8,
                   f32(b.quantResolution), f32(b.rdoScale)});
        cmd->Dispatch(groups(b.blocks8x * b.blocks8y, 64), 1, 1);
    }
    cmd->ResourceBarrier(1, &uav);
    cmd->EndQuery(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q + 2);

    cmd->SetPipelineState(m_Analyze.Get());
    for (const Band& b : m_Bands) {
        constants({b.blocks32x, b.blocks32y, b.first32, b.blocks8x, b.blocks8y, b.first8,
                   m_PerSubdivision * kSubdivisions, m_SubdivisionShift});
        cmd->Dispatch(groups(b.blocks32x * b.blocks32y, 64), 1, 1);
    }
    cmd->ResourceBarrier(1, &uav);
    cmd->EndQuery(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q + 3);

    // The bound covers the payload; the start-of-frame header is extra.
    size_t payload = targetBytes > 8 ? targetBytes - 8 : 0;
    cmd->SetPipelineState(m_Finalize.Get());
    cmd->Dispatch(1, 1, 1);
    cmd->ResourceBarrier(1, &uav);
    cmd->SetPipelineState(m_Resolve.Get());
    constants({uint32_t(payload / 4), m_PerSubdivision});
    cmd->Dispatch(groups(kBuckets * kSubdivisions, 64), 1, 1);
    cmd->ResourceBarrier(1, &uav);
    cmd->EndQuery(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q + 4);

    cmd->SetPipelineState(m_Pack.Get());
    for (const Band& b : m_Bands) {
        constants({b.blocks32x, b.blocks32y, b.first32, b.blocks8x, b.blocks8y, b.first8,
                   b.quantCode, m_Sequence});
        cmd->Dispatch(groups(b.blocks32x * b.blocks32y, 64), 1, 1);
    }
    cmd->ResourceBarrier(1, &uav);
    cmd->EndQuery(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q + 5);

    // What the CPU reads: the block table, the stream, the stream's length.
    D3D12_RESOURCE_BARRIER toCopy[3] = {
        transition(m_Stream.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                   D3D12_RESOURCE_STATE_COPY_SOURCE),
        transition(m_Packets.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                   D3D12_RESOURCE_STATE_COPY_SOURCE),
        transition(m_Buckets.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                   D3D12_RESOURCE_STATE_COPY_SOURCE)};
    cmd->ResourceBarrier(3, toCopy);
    cmd->CopyBufferRegion(m_StreamReadback.Get(), 0, m_Stream.Get(), 0, m_StreamBytes);
    cmd->CopyBufferRegion(m_PacketsReadback.Get(), 0, m_Packets.Get(), 0, uint64_t(m_Blocks32) * 8);
    cmd->CopyBufferRegion(m_PacketsReadback.Get(), uint64_t(m_Blocks32) * 8, m_Buckets.Get(), 0, 8);
    for (auto& b : toCopy)
        std::swap(b.Transition.StateBefore, b.Transition.StateAfter);
    cmd->ResourceBarrier(3, toCopy);
    cmd->ResolveQueryData(timestamps, D3D12_QUERY_TYPE_TIMESTAMP, q, 6, timestampReadback,
                          uint64_t(q) * 8);
}

void PyroWaveEncoder12::recordSelfTest(ID3D12GraphicsCommandList* cmd)
{
    cmd->SetComputeRootSignature(m_Root.Get());
    cmd->SetComputeRootUnorderedAccessView(8, m_Stream->GetGPUVirtualAddress());
    cmd->SetPipelineState(m_SelfTest.Get());
    cmd->Dispatch(1, 1, 1);
    D3D12_RESOURCE_BARRIER b = transition(m_Stream.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                                          D3D12_RESOURCE_STATE_COPY_SOURCE);
    cmd->ResourceBarrier(1, &b);
    cmd->CopyBufferRegion(m_StreamReadback.Get(), 0, m_Stream.Get(), 0, 256);
    std::swap(b.Transition.StateBefore, b.Transition.StateAfter);
    cmd->ResourceBarrier(1, &b);
}

std::vector<uint8_t> PyroWaveEncoder12::selfTestBytes()
{
    std::vector<uint8_t> out(32);
    void* p = nullptr;
    D3D12_RANGE r = {0, 32};
    if (SUCCEEDED(m_StreamReadback->Map(0, &r, &p))) {
        std::memcpy(out.data(), p, 32);
        D3D12_RANGE none = {0, 0};
        m_StreamReadback->Unmap(0, &none);
    }
    return out;
}

PyroWaveEncoder12::StageTimes PyroWaveEncoder12::stageTimes(ID3D12Resource* readback, UINT q,
                                                            uint64_t frequency)
{
    StageTimes t;
    uint64_t* ts = nullptr;
    D3D12_RANGE range = {size_t(q) * 8, size_t(q + 6) * 8};
    if (FAILED(readback->Map(0, &range, reinterpret_cast<void**>(&ts)))) return t;
    const uint64_t* v = ts + q;
    auto ms = [&](int a, int b) { return double(v[b] - v[a]) * 1000.0 / double(frequency); };
    t.dwt = ms(0, 1);
    t.quant = ms(1, 2);
    t.analyze = ms(2, 3);
    t.resolve = ms(3, 4);
    t.pack = ms(4, 5);
    D3D12_RANGE none = {0, 0};
    readback->Unmap(0, &none);
    return t;
}

bool PyroWaveEncoder12::packets(size_t boundary, std::vector<std::vector<uint8_t>>& out,
                                std::string* error)
{
    out.clear();
    const uint32_t* table = nullptr;
    const uint32_t* stream = nullptr;
    D3D12_RANGE tableRange = {0, size_t(m_Blocks32) * 8 + 8};
    D3D12_RANGE streamRange = {0, m_StreamBytes};
    if (FAILED(m_PacketsReadback->Map(0, &tableRange, (void**)&table)) ||
        FAILED(m_StreamReadback->Map(0, &streamRange, (void**)&stream))) {
        *error = "readback Map failed";
        return false;
    }
    const uint32_t usedWords = table[m_Blocks32 * 2];
    bool ok = usedWords * 4 <= m_StreamBytes;
    uint32_t nonZero = 0;
    for (uint32_t i = 0; ok && i < m_Blocks32; i++) {
        uint32_t offset = table[2 * i], words = table[2 * i + 1];
        if (!words) continue;
        nonZero++;
        ok = offset + words <= usedWords && (stream[offset] >> 16 & 0xfff) == words &&
             (stream[offset + 1] >> 8) == i;
    }
    if (!ok) {
        *error = "inconsistent block table from the GPU";
    } else {
        // Start of frame: size, sequence, the number of coded blocks, 4:2:0.
        uint32_t header[2];
        header[0] = uint32_t(m_Width - 1) | (uint32_t(m_Height - 1) << 14) | (m_Sequence << 28) |
                    (1u << 31);
        header[1] = nonZero & 0xffffff; // code 0 = start of frame, chroma 0 = 4:2:0
        std::vector<uint8_t> packet(reinterpret_cast<uint8_t*>(header),
                                    reinterpret_cast<uint8_t*>(header) + 8);
        for (uint32_t i : m_SendOrder) {
            uint32_t offset = table[2 * i], words = table[2 * i + 1];
            if (!words) continue;
            size_t size = size_t(words) * 4;
            if (!packet.empty() && packet.size() + size > boundary) {
                out.push_back(std::move(packet));
                packet.clear();
            }
            const uint8_t* p = reinterpret_cast<const uint8_t*>(stream + offset);
            packet.insert(packet.end(), p, p + size);
        }
        if (!packet.empty()) out.push_back(std::move(packet));
    }
    D3D12_RANGE none = {0, 0};
    m_PacketsReadback->Unmap(0, &none);
    m_StreamReadback->Unmap(0, &none);
    return ok;
}

} // namespace mw::native::encode
