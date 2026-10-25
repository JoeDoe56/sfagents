// PyroWave encoder in HLSL for D3D12, shader model 5.0 (POC Ultra, U2.5).
//
// A port of the encoder shaders of PyroWave by Hans-Kristian Arntzen
// (https://github.com/Themaister/pyrowave, commit 509e4f88): dwt.comp,
// wavelet_quant.comp, analyze_rate_control.comp,
// analyze_rate_control_finalize.comp, resolve_rate_control.comp and
// block_packing.comp. Upstream notice, which covers the ported parts:
//
//   Copyright (c) 2025 Hans-Kristian Arntzen
//   SPDX-License-Identifier: MIT
//
// The bitstream is upstream's (bitstream/bitstream.md); the decisions (quant
// scales, rate-distortion buckets, plane dropping) follow its code. What
// differs, on purpose:
// - No wave intrinsic. Upstream's clustered subgroup operations become one
//   thread per 8x8 block (quantizer) or per 32x32 block (analysis, packing),
//   working serially. Nothing depends on a wave size, so the same code runs
//   on NVIDIA, AMD and Intel (upstream's Vulkan encoder is wrong on the Arc
//   A380), and it compiles with the d3dcompiler the engine already uses.
// - Coefficients are f32 in one buffer (upstream keeps the two finest levels
//   in FP16): the stream is not byte-identical, its quality is the same.
// - Each 4x2 subblock owns a 16-byte slot of scratch (a sign byte and up to
//   15 planes) instead of an atomically allocated, tightly packed payload.
//
// Bindings (one root signature, root descriptors and 16 root constants):
//   t0 Src      input planes, 8-bit Y then Cb then Cr (level 0 and chroma)
//   u0 Coef     wavelet bands, f32, one plane per level x component x band
//   u1 Meta     per 8x8 block: its code word (q planes, quant scale, 2-bit codes)
//   u2 Stats    per 8x8 block: planes, then distortion and bits for each drop
//   u3 Scratch  per 4x2 subblock: sign byte + magnitude planes, MSB first
//   u4 Buckets  rate control: [0] stream counter, [1] unquantized words,
//               [16..] savings per bucket x subdivision, then the operations
//   u5 Quant    per 32x32 block: planes dropped
//   u6 Stream   the coded 32x32 blocks, in no particular order
//   u7 Packets  per 32x32 block: word offset in Stream, word count

cbuffer Constants : register(b0)
{
    uint c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15;
};

ByteAddressBuffer Src : register(t0);
RWStructuredBuffer<float> Coef : register(u0);
RWStructuredBuffer<uint> Meta : register(u1);
RWByteAddressBuffer Stats : register(u2);
RWByteAddressBuffer Scratch : register(u3);
RWByteAddressBuffer Buckets : register(u4);
RWByteAddressBuffer Quant : register(u5);
RWByteAddressBuffer Stream : register(u6);
RWByteAddressBuffer Packets : register(u7);

static const float ALPHA = -1.586134342059924;
static const float BETA = -0.052980118572961;
static const float GAMMA = 0.882911075530934;
static const float DELTA = 0.443506852043971;
static const float K = 1.230174104914001;
static const float INV_K = 1.0 / 1.230174104914001;

static const uint STATS_STRIDE = 132;   // num_planes, then 16 x (f32 distortion), 16 x (u32 bits)
static const uint BUCKET_TOTALS = 64;   // byte offset of the savings, 128 buckets x 16 subdivisions
static const uint BUCKET_OPS = 64 + 128 * 16 * 4;
static const uint QUANT_IDENTITY = 6;

// Byte k (0..3) of a word, and a byte moved to lane k, with constant shifts
// only (a shift by a variable 24 gave 0 with d3dcompiler + WARP).
uint byteOf(uint w, uint k)
{
    return (k == 0 ? w : k == 1 ? (w >> 8) : k == 2 ? (w >> 16) : (w >> 24)) & 0xffu;
}

uint toLane(uint b, uint k)
{
    b &= 0xffu;
    return k == 0 ? b : k == 1 ? (b << 8) : k == 2 ? (b << 16) : (b << 24);
}

// ---------------------------------------------------------------- forward DWT
// One 32x32 tile of the input per group: 40x40 samples with 4 of apron, the
// four CDF 9/7 lifting steps along rows then columns, the four bands out.
// Edges: the input is extended by repeating its last row and column up to the
// aligned size, then mirrored (JPEG 2000 whole-sample symmetry) around it;
// that is what upstream's sampler coordinates do.
//   c0 c1  real size of the input (R)       c2 c3  aligned size (N)
//   c4     0: 8-bit plane in Src, DC shift  1: f32 plane in Coef (an LL band)
//          2: 8-bit samples two bytes apart in Src (NV12's interleaved chroma)
//   c5 c6  source offset, row stride        c7..c10 LL HL LH HH plane offsets
//   c11 c12 band size (N / 2)          c13 Src size in bytes   c14 Coef size in floats

groupshared float S[1600];

int mirrorIndex(int i, int n)
{
    if (i < 0)
        i = -i;
    if (i > n - 1)
        i = 2 * (n - 1) - i;
    return i;
}

// Root descriptors carry no size, so nothing bounds a read: an address out of
// the buffer is a page fault, and the driver resets (05/10/2026, the RTX).
// The compiler may run both sides of a branch, so every address is kept
// inside its buffer whichever side is taken (c13: Src bytes, c14: Coef floats).
float dwtInput(int x, int y)
{
    uint mx = (uint)min(mirrorIndex(x, (int)c2), (int)c0 - 1);
    uint my = (uint)min(mirrorIndex(y, (int)c3), (int)c1 - 1);
    uint i = c5 + my * c6 + mx * (c4 == 2 ? 2 : 1);
    [branch] if (c4 != 1) {
        uint a = min(i, c13 - 1);
        uint w = Src.Load(a & ~3u);
        return float(byteOf(w, a & 3u)) * (1.0 / 255.0) - 0.5;
    }
    return Coef[min(i, c14 - 1)];
}

void liftRows(uint2 t, uint first, uint last, float c)
{
    for (uint r = t.y; r < 40; r += 16)
        for (uint j = first + 2 * t.x; j <= last; j += 32) {
            uint i = r * 40 + j;
            S[i] += c * (S[i - 1] + S[i + 1]);
        }
    GroupMemoryBarrierWithGroupSync();
}

void liftCols(uint2 t, uint first, uint last, float c)
{
    for (uint col = 4 + t.x; col < 36; col += 16)
        for (uint j = first + 2 * t.y; j <= last; j += 32) {
            uint i = j * 40 + col;
            S[i] += c * (S[i - 40] + S[i + 40]);
        }
    GroupMemoryBarrierWithGroupSync();
}

[numthreads(16, 16, 1)]
void DwtCS(uint3 gid : SV_GroupID, uint3 tid : SV_GroupThreadID)
{
    uint2 t = tid.xy;
    int ox = (int)(gid.x * 32) - 4;
    int oy = (int)(gid.y * 32) - 4;
    for (uint y = t.y; y < 40; y += 16)
        for (uint x = t.x; x < 40; x += 16)
            S[y * 40 + x] = dwtInput(ox + (int)x, oy + (int)y);
    GroupMemoryBarrierWithGroupSync();

    // Each step only where its inputs are right: 4 samples of apron serve
    // the tile's 32 after four steps.
    liftRows(t, 1, 37, ALPHA);
    liftRows(t, 2, 36, BETA);
    liftRows(t, 3, 35, GAMMA);
    liftRows(t, 4, 34, DELTA);
    liftCols(t, 1, 37, ALPHA);
    liftCols(t, 2, 36, BETA);
    liftCols(t, 3, 35, GAMMA);
    liftCols(t, 4, 34, DELTA);

    for (uint y2 = t.y; y2 < 32; y2 += 16)
        for (uint x2 = t.x; x2 < 32; x2 += 16) {
            uint bx = (gid.x * 32 + x2) >> 1;
            uint by = (gid.y * 32 + y2) >> 1;
            if (bx >= c11 || by >= c12)
                continue;
            // Low (even) samples are scaled by 1/K, high (odd) ones by K, in
            // each direction; the bands are LL, HL (odd x), LH (odd y), HH.
            float scale = ((x2 & 1) ? K : INV_K) * ((y2 & 1) ? K : INV_K);
            uint band = (x2 & 1) + 2 * (y2 & 1);
            uint plane = band == 0 ? c7 : band == 1 ? c8 : band == 2 ? c9 : c10;
            Coef[plane + by * c11 + bx] = S[(y2 + 4) * 40 + x2 + 4] * scale;
        }
}

// ------------------------------------------------------------------ quantizer
// One thread per 8x8 block of a band. Picks the block's quant scale, codes its
// eight 4x2 subblocks as a sign byte and magnitude planes into Scratch, and
// records, for every number of planes dropped, the distortion and the bits
// the block would cost: the rate control chooses from those.
//   c0 plane offset   c1 c2 band size   c3 c4 band size in 8x8 blocks
//   c5 index of the band's first 8x8 block
//   c6 quant resolution (f32 bits)      c7 distortion weight (f32 bits)

void loadSubblock(uint bx, uint by, uint sub, float scale, out float v[8])
{
    uint x0 = bx * 8 + 4 * (sub >> 2);
    uint y0 = by * 8 + 2 * (sub & 3);
    [unroll] for (uint e = 0; e < 8; e++) {
        uint x = x0 + (e >> 1);
        uint y = y0 + (e & 1);
        // Outside the band: zero, read from an address that stays inside it.
        float value = Coef[c0 + min(y, c2 - 1) * c1 + min(x, c1 - 1)];
        v[e] = (x < c1 && y < c2) ? value * scale : 0.0;
    }
}

[numthreads(64, 1, 1)]
void QuantCS(uint3 dtid : SV_DispatchThreadID)
{
    uint k = dtid.x;
    if (k >= c3 * c4)
        return;
    uint bx = k % c3;
    uint by = k / c3;
    uint block = c5 + k;
    float qres = asfloat(c6);
    float rdo = asfloat(c7);
    uint statsAt = block * STATS_STRIDE;

    float v[8];
    float maxSub[8];
    float maxAll = 0.0;
    [unroll] for (uint s = 0; s < 8; s++) {
        loadSubblock(bx, by, s, qres, v);
        float m = 0.0;
        [unroll] for (uint e = 0; e < 8; e++)
            m = max(m, abs(v[e]));
        maxSub[s] = m;
        maxAll = max(maxAll, m);
    }

    // The block's quant scale: its largest value just under a power of two.
    uint quantCode = QUANT_IDENTITY;
    float quantScale = 1.0;
    if (maxAll >= 1.0) {
        float e;
        frexp(maxAll - 0.25, e);
        float targetMax = exp2(e) - 0.25;
        float invScale = maxAll / targetMax;
        quantCode = (uint)ceil((invScale - 0.25) * 8.0);
        quantScale = 1.0 / (float(quantCode) / 8.0 + 0.25);
    }
    maxAll *= quantScale;
    float invQuant = 1.0 / (qres * quantScale);
    float invQuant2 = invQuant * invQuant;
    int maxAbs = (int)maxAll;

    if (maxAbs == 0) {
        Meta[block] = 0;
        Stats.Store(statsAt, 0);
        Stats.Store(statsAt + 4, 0);
        Stats.Store(statsAt + 68, 0);
        return;
    }

    int msb = firstbithigh((uint)maxAbs);
    int planeCode[8];
    uint codeWord = 0;
    float allEnergy = 0.0;

    for (int q = 0; q <= msb; q++) {
        int qualityPlanes = (msb - q >= 3) ? msb - q - 2 : 0;
        uint bits = 0;
        float distortion = 0.0;
        [unroll] for (uint s2 = 0; s2 < 8; s2++) {
            loadSubblock(bx, by, s2, qres, v);
            [unroll] for (uint e0 = 0; e0 < 8; e0++)
                v[e0] *= quantScale;
            int shifted = ((int)(maxSub[s2] * quantScale)) >> q;
            int early = shifted > 0 ? 1 : 0;
            if (msb - q >= 3) {
                early = qualityPlanes + 1;
                shifted >>= qualityPlanes;
            }
            early += firstbithigh((uint)shifted) + 1;
            uint significant = 0;
            float err = 0.0;
            [unroll] for (uint e = 0; e < 8; e++) {
                float a = abs(v[e]);
                float iv = floor(ldexp(a, -q));
                if (iv != 0.0) {
                    significant++;
                    iv += 0.5;
                }
                iv = trunc(ldexp(iv, q));
                err += (a - iv) * (a - iv);
                if (q == 0)
                    allEnergy += v[e] * v[e];
            }
            bits += 8 * (uint)max(early - 1, 0) + significant;
            distortion += err * rdo;

            if (q == 0) {
                planeCode[s2] = firstbithigh((uint)shifted) + 1;
                codeWord |= (uint)planeCode[s2] << (2 * s2);
                // Scratch: the sign byte, then the magnitude planes, MSB first.
                uint slot[4] = { 0, 0, 0, 0 };
                if (shifted != 0 || qualityPlanes != 0) {
                    uint signs = 0;
                    [unroll] for (uint e2 = 0; e2 < 8; e2++)
                        signs |= (v[e2] < 0.0 ? 1u : 0u) << e2;
                    slot[0] = signs;
                    int planes = qualityPlanes + planeCode[s2];
                    for (int p = 0; p < planes; p++) {
                        int plane = planes - 1 - p;
                        uint byteValue = 0;
                        [unroll] for (uint e3 = 0; e3 < 8; e3++)
                            byteValue |= (((uint)abs((int)v[e3]) >> plane) & 1u) << e3;
                        uint at = p + 1;
                        slot[at >> 2] |= toLane(byteValue, at & 3);
                    }
                }
                Scratch.Store4((block * 8 + s2) * 16, uint4(slot[0], slot[1], slot[2], slot[3]));
            }
        }
        if (q == 0) {
            codeWord |= (uint)qualityPlanes << 16;
            codeWord |= quantCode << 20;
            // Distortion of q = 0 is not recorded: keeping a block is decided.
            Stats.Store(statsAt + 4, asuint(0.0));
        } else {
            Stats.Store(statsAt + 4 + 4 * q, asuint(min(distortion * invQuant2, 60000.0)));
        }
        Stats.Store(statsAt + 68 + 4 * q, bits);
    }
    Meta[block] = codeWord;
    Stats.Store(statsAt, (uint)msb + 1);
    // Dropping every plane: the whole energy, unweighted (as upstream does).
    Stats.Store(statsAt + 4 + 4 * (msb + 1), asuint(min(allEnergy * invQuant2, 60000.0)));
    Stats.Store(statsAt + 68 + 4 * (msb + 1), 0);
}

// ------------------------------------------------------- rate control: analyze
// One thread per 32x32 block of a band: the words the block costs for every
// number of planes dropped, and the distortion it adds, turned into
// operations ("drop q planes here, save n words") filed by how much distortion
// they add per word saved.
//   c0 c1 band size in 32x32 blocks   c2 index of its first 32x32 block
//   c3 c4 band size in 8x8 blocks     c5 index of its first 8x8 block
//   c6 blocks per bucket (all subdivisions)   c7 log2 of blocks per subdivision

[numthreads(64, 1, 1)]
void AnalyzeCS(uint3 dtid : SV_DispatchThreadID)
{
    uint k = dtid.x;
    if (k >= c0 * c1)
        return;
    uint x32 = k % c0;
    uint y32 = k / c0;
    uint block = c2 + k;

    uint cost[16];
    float dist[16];
    [unroll] for (uint i = 0; i < 16; i++) {
        cost[i] = 0;
        dist[i] = 0.0;
    }
    for (uint ly = 0; ly < 4; ly++)
        for (uint lx = 0; lx < 4; lx++) {
            uint bx = 4 * x32 + lx;
            uint by = 4 * y32 + ly;
            if (bx >= c3 || by >= c4)
                continue;
            uint at = (c5 + by * c3 + bx) * STATS_STRIDE;
            uint planes = Stats.Load(at);
            [unroll] for (uint i2 = 0; i2 < 16; i2++) {
                uint s = min(i2, planes);
                uint c = Stats.Load(at + 68 + 4 * s);
                if (c != 0)
                    c += 24; // 16 bits of codes, 8 of q planes and quant scale
                cost[i2] += c;
                dist[i2] += asfloat(Stats.Load(at + 4 + 4 * s));
            }
        }

    uint rate[16];
    [unroll] for (uint i3 = 0; i3 < 16; i3++) {
        uint c = cost[i3];
        if (c != 0)
            c += 64; // the block header
        rate[i3] = (c + 31) >> 5;
    }

    // Least added distortion per word saved first: ~1.5 dB a bucket.
    uint bucket[16];
    bucket[0] = 0;
    [unroll] for (uint i4 = 1; i4 < 16; i4++) {
        if (rate[i4] == rate[0]) {
            bucket[i4] = 0;
        } else {
            float index = 60.0 + 2.0 * log2(max(dist[i4] - dist[0], 0.0) / (float(rate[0]) - float(rate[i4])));
            bucket[i4] = (uint)max(index + 0.5, 0.0);
        }
    }
    // Buckets rise with the planes dropped, at least one apart, below 128.
    [unroll] for (uint i5 = 0; i5 < 16; i5++)
        bucket[i5] = min(bucket[i5], 112 + i5);
    [unroll] for (uint step = 1; step < 16; step *= 2) {
        uint next[16];
        [unroll] for (uint i6 = 0; i6 < 16; i6++)
        {
            // HLSL evaluates both sides of ?:, so the index is kept in range.
            uint up = bucket[i6 >= step ? i6 - step : 0] + step;
            next[i6] = max(bucket[i6], i6 >= step ? up : 0);
        }
        [unroll] for (uint i7 = 0; i7 < 16; i7++)
            bucket[i7] = next[i7];
    }

    uint ignored;
    Buckets.InterlockedAdd(4, rate[0], ignored);
    uint subdivision = block >> c7;
    [unroll] for (uint i8 = 1; i8 < 16; i8++) {
        uint saving = min(rate[i8 - 1] - rate[i8], 65535u);
        if (saving == 0)
            continue;
        Buckets.InterlockedAdd(BUCKET_TOTALS + 4 * (bucket[i8] * 16 + subdivision), saving, ignored);
        uint op = BUCKET_OPS + 8 * (block + bucket[i8] * c6);
        Buckets.Store2(op, uint2(i8, block | (saving << 16)));
    }
}

// ------------------------------------------------------ rate control: finalize
// Running total of the savings over buckets and subdivisions. One thread.

[numthreads(1, 1, 1)]
void FinalizeCS()
{
    uint sum = 0;
    for (uint i = 0; i < 128 * 16; i++) {
        sum += Buckets.Load(BUCKET_TOTALS + 4 * i);
        Buckets.Store(BUCKET_TOTALS + 4 * i, sum);
    }
}

// ------------------------------------------------------- rate control: resolve
// One thread per bucket x subdivision. A bucket applies its operations only
// for what the cheaper buckets before it could not save.
//   c0 target size in words   c1 blocks per subdivision

[numthreads(64, 1, 1)]
void ResolveCS(uint3 dtid : SV_DispatchThreadID)
{
    uint x = dtid.x;
    if (x >= 128 * 16)
        return;
    int required = (int)Buckets.Load(4) - (int)c0;
    uint total = Buckets.Load(BUCKET_TOTALS + 4 * x);
    if (x != 0) {
        uint previous = Buckets.Load(BUCKET_TOTALS + 4 * (x - 1));
        if (total == previous)
            return;
        required -= (int)previous;
    } else if (total == 0) {
        return;
    }
    if (required <= 0)
        return;

    int saved = 0;
    for (uint i = 0; i < c1 && saved < required; i++) {
        uint2 op = Buckets.Load2(BUCKET_OPS + 8 * (x * c1 + i));
        uint saving = op.y >> 16;
        if (saving == 0)
            continue;
        uint ignored;
        Quant.InterlockedMax(4 * (op.y & 0xffffu), op.x, ignored);
        saved += (int)saving;
    }
}

// -------------------------------------------------------------------- packing
// One thread per 32x32 block of a band: the block as it travels, built from
// the scratch planes minus the ones the rate control dropped.
//   c0 c1 band size in 32x32 blocks   c2 index of its first 32x32 block
//   c3 c4 band size in 8x8 blocks     c5 index of its first 8x8 block
//   c6 the band's quant code          c7 sequence counter (3 bits)

// A byte stream into Stream, a word at a time. Words it does not fully own
// (the first and the last) are merged into what is there. The state is in
// statics, one thread owning one stream. The four bytes of the current word
// are kept apart and joined with constant shifts: shifting by a variable 24
// gave 0 here (d3dcompiler + WARP, 05/10/2026, SelfTestCS).
static uint gAt;      // byte address of the next byte
static uint4 gBytes;  // the current word's bytes so far
static uint4 gOwned;  // 1 where the byte is ours

void writerFlush(uint wordAt)
{
    uint acc = gBytes.x | (gBytes.y << 8) | (gBytes.z << 16) | (gBytes.w << 24);
    uint mask = (gOwned.x * 0xffu) | ((gOwned.y * 0xffu) << 8) | ((gOwned.z * 0xffu) << 16) |
                ((gOwned.w * 0xffu) << 24);
    if (mask == 0xffffffffu) {
        Stream.Store(wordAt, acc);
    } else if (mask != 0) {
        uint old = Stream.Load(wordAt);
        Stream.Store(wordAt, (old & ~mask) | acc);
    }
    gBytes = uint4(0, 0, 0, 0);
    gOwned = uint4(0, 0, 0, 0);
}

void writeByte(uint b)
{
    uint lane = gAt & 3;
    b &= 0xffu;
    gBytes.x = lane == 0 ? b : gBytes.x;
    gBytes.y = lane == 1 ? b : gBytes.y;
    gBytes.z = lane == 2 ? b : gBytes.z;
    gBytes.w = lane == 3 ? b : gBytes.w;
    gOwned.x = lane == 0 ? 1 : gOwned.x;
    gOwned.y = lane == 1 ? 1 : gOwned.y;
    gOwned.z = lane == 2 ? 1 : gOwned.z;
    gOwned.w = lane == 3 ? 1 : gOwned.w;
    gAt++;
    if ((gAt & 3) == 0)
        writerFlush(gAt - 4);
}

void writerEnd()
{
    if (any(gOwned))
        writerFlush(gAt & ~3u);
}

void writerStart(uint at)
{
    gAt = at;
    gBytes = uint4(0, 0, 0, 0);
    gOwned = uint4(0, 0, 0, 0);
}

// The control word of an 8x8 block with `quant` least significant planes
// dropped: the shared q planes first, then the per-subblock 2-bit codes.
uint quantizeCodeWord(uint codeWord, int quant)
{
    if (quant == 0 || codeWord == 0)
        return codeWord;
    int qBits = (int)((codeWord >> 16) & 0xfu);
    int sub = min(qBits, quant);
    qBits -= sub;
    quant -= sub;
    if (quant != 0) {
        quant = min(quant, 3);
        uint plane0 = codeWord & 0x5555u;
        uint plane1 = (codeWord & 0xaaaau) >> 1;
        uint plane2 = plane0 & plane1;
        for (int i = 0; i < quant; i++) {
            plane0 = plane1;
            plane1 = plane2;
            plane2 = 0;
        }
        plane0 &= ~plane1;
        codeWord = (codeWord & 0xffff0000u) | plane0 | (plane1 << 1);
    }
    return (codeWord & ~(0xfu << 16)) | ((uint)qBits << 16);
}

uint planesOf(uint codeWord)
{
    uint lsbs = codeWord & 0x5555u;
    uint msbs = codeWord & 0xaaaau;
    msbs |= msbs >> 1;
    return countbits(lsbs) + countbits(msbs) + ((codeWord >> 16) & 0xfu) * 8;
}

uint scratchByte(uint slot, uint i)
{
    return byteOf(Scratch.Load(slot + (i & ~3u)), i & 3u);
}

[numthreads(64, 1, 1)]
void PackCS(uint3 dtid : SV_DispatchThreadID)
{
    uint k = dtid.x;
    if (k >= c0 * c1)
        return;
    uint x32 = k % c0;
    uint y32 = k / c0;
    uint block = c2 + k;
    int quant = (int)Quant.Load(4 * block);

    uint ballot = 0;
    uint totalBits = 0;
    for (uint i = 0; i < 16; i++) {
        uint bx = 4 * x32 + (i & 3);
        uint by = 4 * y32 + (i >> 2);
        if (bx >= c3 || by >= c4)
            continue;
        uint b8 = c5 + by * c3 + bx;
        uint at = b8 * STATS_STRIDE;
        uint bits = Stats.Load(at + 68 + 4 * min((uint)quant, Stats.Load(at)));
        if (bits != 0)
            totalBits += bits + 24;
        if ((quantizeCodeWord(Meta[b8], quant) & 0xffffu) != 0)
            ballot |= 1u << i;
    }
    uint words = (totalBits + 31) / 32;
    if (words == 0 || ballot == 0) {
        Packets.Store2(8 * block, uint2(0, 0));
        return;
    }
    words += 2;
    uint offset;
    Buckets.InterlockedAdd(0, words, offset);
    Packets.Store2(8 * block, uint2(offset, words));

    uint n = countbits(ballot);
    uint base = offset * 4;
    // The quant code's exponent falls by the planes dropped.
    uint e = (c6 >> 3) & 0x1fu;
    e = (uint)max((int)e - quant, 0);
    uint quantCode = (c6 & 7u) | (e << 3);
    Stream.Store(base, ballot | (words << 16) | (c7 << 28));
    Stream.Store(base + 4, quantCode | (block << 8));

    writerStart(base + 8);
    // Code words (u16), then q planes and quant scale (u8), active blocks only.
    for (uint i2 = 0; i2 < 16; i2++)
        if (ballot & (1u << i2)) {
            uint b8 = c5 + (4 * y32 + (i2 >> 2)) * c3 + 4 * x32 + (i2 & 3);
            uint cw = quantizeCodeWord(Meta[b8], quant);
            writeByte(cw);
            writeByte(cw >> 8);
        }
    for (uint i3 = 0; i3 < 16; i3++)
        if (ballot & (1u << i3)) {
            uint b8 = c5 + (4 * y32 + (i3 >> 2)) * c3 + 4 * x32 + (i3 & 3);
            writeByte(quantizeCodeWord(Meta[b8], quant) >> 16);
        }
    // Magnitude planes: the most significant ones each subblock keeps.
    for (uint i4 = 0; i4 < 16; i4++)
        if (ballot & (1u << i4)) {
            uint b8 = c5 + (4 * y32 + (i4 >> 2)) * c3 + 4 * x32 + (i4 & 3);
            uint cw = quantizeCodeWord(Meta[b8], quant);
            for (uint s = 0; s < 8; s++) {
                uint planes = ((cw >> (2 * s)) & 3u) + ((cw >> 16) & 0xfu);
                uint slot = (b8 * 8 + s) * 16;
                for (uint p = 0; p < planes; p++)
                    writeByte(scratchByte(slot, p + 1));
            }
        }
    // Signs of the values still non-zero, packed LSB first.
    uint signAcc = 0;
    uint signBits = 0;
    for (uint i5 = 0; i5 < 16; i5++)
        if (ballot & (1u << i5)) {
            uint b8 = c5 + (4 * y32 + (i5 >> 2)) * c3 + 4 * x32 + (i5 & 3);
            uint cw = quantizeCodeWord(Meta[b8], quant);
            for (uint s = 0; s < 8; s++) {
                uint planes = ((cw >> (2 * s)) & 3u) + ((cw >> 16) & 0xfu);
                if (planes == 0)
                    continue;
                uint slot = (b8 * 8 + s) * 16;
                uint significant = 0;
                for (uint p = 0; p < planes; p++)
                    significant |= scratchByte(slot, p + 1);
                uint signs = scratchByte(slot, 0);
                for (uint e2 = 0; e2 < 8; e2++)
                    if (significant & (1u << e2)) {
                        signAcc |= ((signs >> e2) & 1u) << signBits;
                        signBits++;
                        if (signBits == 8) {
                            writeByte(signAcc);
                            signAcc = 0;
                            signBits = 0;
                        }
                    }
            }
        }
    if (signBits != 0)
        writeByte(signAcc);
    writerEnd();
}

// ---------------------------------------------------------------- frame reset
// Zeroes the rate control's buckets and the per-block quant before a frame.
//   c0 bucket buffer size in words   c1 quant buffer size in words

[numthreads(64, 1, 1)]
void ClearCS(uint3 dtid : SV_DispatchThreadID)
{
    uint i = dtid.x;
    if (i < c0)
        Buckets.Store(4 * i, 0);
    if (i < c1)
        Quant.Store(4 * i, 0);
}

// ----------------------------------------------------------------- self test
// The byte writer alone: bytes 0xf0 | i, then 0x0f | (i << 4), from byte 0
// of Stream, so the host can read them back (lab only).

[numthreads(1, 1, 1)]
void SelfTestCS()
{
    writerStart(0);
    for (uint i = 0; i < 16; i++) {
        writeByte(0xf0u | i);
        writeByte(0x0fu | (i << 4));
    }
    writerEnd();
}
