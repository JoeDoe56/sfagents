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

#include "VulkanHevcEncoder.h"

#include "../../core/Log.h"
#include "../../platform/linux/vulkan/VulkanDevice.h"
#include "../HevcEncodeNegotiation.h"
#include "../RateControl.h"

#include <algorithm>
#include <cstring>

namespace mw::native::encode {

using vulkan::resultText;

namespace {

/// Pictures whose slice headers are read back with the driver's SPS and PPS:
/// the warm-up IDR and the pictures after it (VideoEncode12's rule).
constexpr int kGuardedPictures = 6;

/// Room for the parameter sets in front of the slices: a VPS, an SPS with its
/// VUI and a PPS come to about a hundred bytes.
constexpr VkDeviceSize kHeaderRoom = 4096;

uint32_t alignUp(uint32_t v, uint32_t a)
{
    return a > 1 ? (v + a - 1) / a * a : v;
}

VkDeviceSize alignUp(VkDeviceSize v, VkDeviceSize a)
{
    return a > 1 ? (v + a - 1) / a * a : v;
}

/// HEVC Main, 4:2:0, 8 bits, for a stream: the chain every call names. The
/// usage hints are the lab's (C13.1), with which the 780M coded right.
struct Profile
{
    VkVideoEncodeUsageInfoKHR usage = {};
    VkVideoEncodeH265ProfileInfoKHR h265 = {};
    VkVideoProfileInfoKHR info = {};
    VkVideoProfileListInfoKHR list = {};

    Profile()
    {
        usage.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_USAGE_INFO_KHR;
        usage.videoUsageHints = VK_VIDEO_ENCODE_USAGE_STREAMING_BIT_KHR;
        usage.videoContentHints =
            VK_VIDEO_ENCODE_CONTENT_DESKTOP_BIT_KHR | VK_VIDEO_ENCODE_CONTENT_RENDERED_BIT_KHR;
        usage.tuningMode = VK_VIDEO_ENCODE_TUNING_MODE_ULTRA_LOW_LATENCY_KHR;
        h265.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_PROFILE_INFO_KHR;
        h265.pNext = &usage;
        h265.stdProfileIdc = STD_VIDEO_H265_PROFILE_IDC_MAIN;
        info.sType = VK_STRUCTURE_TYPE_VIDEO_PROFILE_INFO_KHR;
        info.pNext = &h265;
        info.videoCodecOperation = VK_VIDEO_CODEC_OPERATION_ENCODE_H265_BIT_KHR;
        info.chromaSubsampling = VK_VIDEO_CHROMA_SUBSAMPLING_420_BIT_KHR;
        info.lumaBitDepth = VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR;
        info.chromaBitDepth = VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR;
        list.sType = VK_STRUCTURE_TYPE_VIDEO_PROFILE_LIST_INFO_KHR;
        list.profileCount = 1;
        list.pProfiles = &info;
    }
    Profile(const Profile&) = delete;
    Profile& operator=(const Profile&) = delete;
};

/// A rate control state: what a control command sets, and what every
/// vkCmdBeginVideoCodingKHR after it must say again. Built in place.
struct Rate
{
    VkVideoEncodeH265RateControlLayerInfoKHR h265Layer = {};
    VkVideoEncodeRateControlLayerInfoKHR layer = {};
    VkVideoEncodeH265RateControlInfoKHR h265 = {};
    VkVideoEncodeRateControlInfoKHR info = {};

    Rate() = default;
    Rate(const Rate&) = delete;
    Rate& operator=(const Rate&) = delete;

    void set(bool constantQp, uint32_t bitsPerSecond, int fps, int vbvFrames)
    {
        h265 = {};
        h265.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_RATE_CONTROL_INFO_KHR;
        // One IDR, then P for ever, one layer: no GOP to declare (VUID 08292
        // allows a reference pattern only with a regular one).
        h265.subLayerCount = 1;
        info = {};
        info.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_RATE_CONTROL_INFO_KHR;
        info.pNext = &h265;
        if (constantQp) {
            info.rateControlMode = VK_VIDEO_ENCODE_RATE_CONTROL_MODE_DISABLED_BIT_KHR;
            return;
        }
        h265Layer = {};
        h265Layer.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_RATE_CONTROL_LAYER_INFO_KHR;
        // The engine's QP range: 18, the floor every encoder here keeps, to 51.
        h265Layer.useMinQp = VK_TRUE;
        h265Layer.minQp = {18, 18, 18};
        h265Layer.useMaxQp = VK_TRUE;
        h265Layer.maxQp = {51, 51, 51};
        layer = {};
        layer.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_RATE_CONTROL_LAYER_INFO_KHR;
        layer.pNext = &h265Layer;
        layer.averageBitrate = bitsPerSecond;
        layer.maxBitrate = bitsPerSecond;
        layer.frameRateNumerator = static_cast<uint32_t>(fps);
        layer.frameRateDenominator = 1;
        info.rateControlMode = VK_VIDEO_ENCODE_RATE_CONTROL_MODE_CBR_BIT_KHR;
        info.layerCount = 1;
        info.pLayers = &layer;
        // The VBV every encoder here keeps (RateControl.h), in milliseconds.
        const uint64_t bits = vbvBits(bitsPerSecond, fps, vbvFrames);
        const uint64_t ms =
            (bits * 1000 + bitsPerSecond - 1) / std::max<uint32_t>(bitsPerSecond, 1);
        info.virtualBufferSizeInMs = static_cast<uint32_t>(std::max<uint64_t>(ms, 1));
        info.initialVirtualBufferSizeInMs = info.virtualBufferSizeInMs;
    }
};

/// The smallest level whose picture size holds @p lumaSamples: 5.1 below 4K,
/// what the VA-API sets say too (ParameterSets.h), 6.1 above.
int levelFor(uint64_t lumaSamples)
{
    return lumaSamples <= 8912896 ? 153 : 183;
}

StdVideoH265LevelIdc stdLevel(int levelIdc)
{
    return levelIdc <= 153 ? STD_VIDEO_H265_LEVEL_IDC_5_1 : STD_VIDEO_H265_LEVEL_IDC_6_1;
}

VkImageMemoryBarrier2 imageBarrier(VkImage image, VkImageLayout from, VkImageLayout to,
                                   VkPipelineStageFlags2 srcStage, VkAccessFlags2 srcAccess,
                                   VkPipelineStageFlags2 dstStage, VkAccessFlags2 dstAccess,
                                   uint32_t layers = 1)
{
    VkImageMemoryBarrier2 b = {};
    b.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
    b.srcStageMask = srcStage;
    b.srcAccessMask = srcAccess;
    b.dstStageMask = dstStage;
    b.dstAccessMask = dstAccess;
    b.oldLayout = from;
    b.newLayout = to;
    b.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.image = image;
    b.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, layers};
    return b;
}

/// The QP of the picture's first slice (SliceQpY), -1 if it does not read.
int firstSliceQp(const uint8_t* data, size_t size, const HevcSpsFields& sps,
                 const HevcPpsFields& pps)
{
    for (const HevcNalUnit& unit : hevcNalUnits(data, size)) {
        if (unit.type() > 31) continue; // an AUD or an SEI in front
        HevcSliceFields f;
        return parseHevcSliceHeader(unit.data, unit.size, sps, pps, f).empty() ? f.qp : -1;
    }
    return -1;
}

} // namespace

struct VulkanHevcEncoder::Impl
{
    std::shared_ptr<vulkan::VulkanDevice> device;
    const vulkan::DeviceFunctions* fn = nullptr;
    VkDevice dev = VK_NULL_HANDLE;
    Profile profile;

    VkVideoEncodeH265CapabilitiesKHR h265Caps = {};
    VkVideoEncodeCapabilitiesKHR encodeCaps = {};
    VkVideoCapabilitiesKHR caps = {};
    /// Intra refresh (C13.9): what the driver takes, and the way it was asked
    /// to split the picture — NONE without sweeps.
    VkVideoEncodeIntraRefreshCapabilitiesKHR refreshCaps = {};
    VkVideoEncodeIntraRefreshModeFlagBitsKHR refreshMode =
        VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_NONE_KHR;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    uint32_t allocWidth = 0;
    uint32_t allocHeight = 0;
    uint32_t log2Ctb = 6;
    uint32_t log2MinTb = 2;
    uint32_t log2MaxTb = 5;
    int levelIdc = 153;
    bool constantQp = false;

    // The input: NV12 at the coded size, written by the conversion's plane
    // views, read by the encoder through its own.
    VkImage input = VK_NULL_HANDLE;
    VkDeviceMemory inputMemory = VK_NULL_HANDLE;
    VkImageView inputView = VK_NULL_HANDLE;
    VkImageView lumaView = VK_NULL_HANDLE;
    VkImageView chromaView = VK_NULL_HANDLE;
    bool inputTouched = false;

    // The reconstructed pictures: HevcDpb's pool, one layer each.
    VkImage dpb = VK_NULL_HANDLE;
    VkDeviceMemory dpbMemory = VK_NULL_HANDLE;
    VkImageView dpbView = VK_NULL_HANDLE;
    uint32_t dpbLayers = 0;
    bool dpbTouched = false;

    // The bitstream: the parameter sets, then the slices from sliceOffset.
    VkBuffer bitstream = VK_NULL_HANDLE;
    VkDeviceMemory bitstreamMemory = VK_NULL_HANDLE;
    uint8_t* bitstreamCpu = nullptr;
    VkDeviceSize bitstreamSize = 0;
    VkDeviceSize sliceOffset = 0;
    std::vector<uint8_t> scratch; ///< an IDR whose slices do not start at the offset

    // Pictures from the CPU (upload()): NV12 at the coded size, black around.
    VkBuffer staging = VK_NULL_HANDLE;
    VkDeviceMemory stagingMemory = VK_NULL_HANDLE;
    uint8_t* stagingCpu = nullptr;

    VkVideoSessionKHR session = VK_NULL_HANDLE;
    std::vector<VkDeviceMemory> sessionMemory;
    VkVideoSessionParametersKHR parameters = VK_NULL_HANDLE;
    VkQueryPool feedback = VK_NULL_HANDLE;
    VkCommandPool encodePool = VK_NULL_HANDLE;
    VkCommandBuffer encodeCmd = VK_NULL_HANDLE;
    VkCommandPool uploadPool = VK_NULL_HANDLE;
    VkCommandBuffer uploadCmd = VK_NULL_HANDLE;

    Rate rate[2];
    int current = 0;

    VkResult allocate(const VkMemoryRequirements& req, VkMemoryPropertyFlags want,
                      VkMemoryPropertyFlags fallback, VkDeviceMemory& out)
    {
        uint32_t type = device->memoryType(req.memoryTypeBits, want);
        if (type == UINT32_MAX) type = device->memoryType(req.memoryTypeBits, fallback);
        if (type == UINT32_MAX) return VK_ERROR_OUT_OF_DEVICE_MEMORY;
        VkMemoryAllocateInfo mai = {};
        mai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        mai.allocationSize = req.size;
        mai.memoryTypeIndex = type;
        return fn->vkAllocateMemory(dev, &mai, nullptr, &out);
    }
};

VulkanHevcEncoder::VulkanHevcEncoder()
    : d(std::make_unique<Impl>())
{}

VulkanHevcEncoder::~VulkanHevcEncoder()
{
    stop();
}

bool VulkanHevcEncoder::init(const std::shared_ptr<vulkan::VulkanDevice>& device, Codec codec,
                             int width, int height, int fps, int bitrateKbps, bool intraRefresh,
                             const EncoderTuning& tuning, std::string& error,
                             const Witness& witness)
{
    stop();
    if (codec != Codec::Hevc) {
        error =
            std::string("the Vulkan Video encoder does ") + toString(codec) + " later: HEVC only";
        return false;
    }
    if (!device || !device->encodeQueue()) {
        error = "no Vulkan device with an encode queue";
        return false;
    }
    if (width <= 0 || height <= 0 || (width | height) & 1) {
        error =
            "4:2:0 wants an even size, not " + std::to_string(width) + "x" + std::to_string(height);
        return false;
    }
    d->device = device;
    d->fn = &device->fn();
    d->dev = device->device();
    m_Width = width;
    m_Height = height;
    m_Fps = fps > 0 ? fps : 60;
    m_BitrateKbps = std::max(bitrateKbps, 1);
    m_VbvFrames = tuning.vbvFrames;
    m_Witness = witness;
    d->constantQp = witness.constantQp >= 0;

    // ── What the driver takes ──
    d->h265Caps.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_CAPABILITIES_KHR;
    d->encodeCaps.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_CAPABILITIES_KHR;
    d->encodeCaps.pNext = &d->h265Caps;
    d->caps.sType = VK_STRUCTURE_TYPE_VIDEO_CAPABILITIES_KHR;
    d->caps.pNext = &d->encodeCaps;
    // Intra refresh's own, asked only of a device that enabled it: naming
    // the structure anywhere else is invalid usage.
    if (intraRefresh && device->encodesIntraRefresh()) {
        d->refreshCaps.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_INTRA_REFRESH_CAPABILITIES_KHR;
        d->h265Caps.pNext = &d->refreshCaps;
    }
    VkResult r = device->videoCapabilities(d->profile.info, d->caps);
    if (r != VK_SUCCESS) {
        error =
            device->name() + " encodes no HEVC Main through Vulkan Video (" + resultText(r) + ")";
        stop();
        return false;
    }
    const VkVideoEncodeRateControlModeFlagBitsKHR mode =
        d->constantQp ? VK_VIDEO_ENCODE_RATE_CONTROL_MODE_DISABLED_BIT_KHR
                      : VK_VIDEO_ENCODE_RATE_CONTROL_MODE_CBR_BIT_KHR;
    if (!(d->encodeCaps.rateControlModes & mode)) {
        error = std::string("the driver's Vulkan encoder has no ") +
                (d->constantQp ? "constant QP" : "CBR");
        stop();
        return false;
    }
    // The CTB: the largest the driver takes. The transform blocks: from the
    // smallest it takes to the largest, 4 to 32 at most.
    const VkVideoEncodeH265CtbSizeFlagsKHR ctbs = d->h265Caps.ctbSizes;
    d->log2Ctb = (ctbs & VK_VIDEO_ENCODE_H265_CTB_SIZE_64_BIT_KHR)   ? 6
                 : (ctbs & VK_VIDEO_ENCODE_H265_CTB_SIZE_32_BIT_KHR) ? 5
                                                                     : 4;
    const VkVideoEncodeH265TransformBlockSizeFlagsKHR tbs = d->h265Caps.transformBlockSizes;
    d->log2MinTb = (tbs & VK_VIDEO_ENCODE_H265_TRANSFORM_BLOCK_SIZE_4_BIT_KHR)    ? 2
                   : (tbs & VK_VIDEO_ENCODE_H265_TRANSFORM_BLOCK_SIZE_8_BIT_KHR)  ? 3
                   : (tbs & VK_VIDEO_ENCODE_H265_TRANSFORM_BLOCK_SIZE_16_BIT_KHR) ? 4
                                                                                  : 5;
    d->log2MaxTb = (tbs & VK_VIDEO_ENCODE_H265_TRANSFORM_BLOCK_SIZE_32_BIT_KHR)   ? 5
                   : (tbs & VK_VIDEO_ENCODE_H265_TRANSFORM_BLOCK_SIZE_16_BIT_KHR) ? 4
                   : (tbs & VK_VIDEO_ENCODE_H265_TRANSFORM_BLOCK_SIZE_8_BIT_KHR)  ? 3
                                                                                  : 2;
    d->log2MaxTb = std::min(std::max(d->log2MaxTb, d->log2MinTb), d->log2Ctb);
    // Whole CTBs, the D3D12 lesson (C5.3): a driver may code the last one
    // whatever the SPS says. The conformance window crops.
    const uint32_t ctb = 1u << d->log2Ctb;
    d->codedWidth = alignUp(static_cast<uint32_t>(width), ctb);
    d->codedHeight = alignUp(static_cast<uint32_t>(height), ctb);
    if (d->codedWidth < d->caps.minCodedExtent.width ||
        d->codedHeight < d->caps.minCodedExtent.height ||
        d->codedWidth > d->caps.maxCodedExtent.width ||
        d->codedHeight > d->caps.maxCodedExtent.height) {
        error = std::to_string(d->codedWidth) + "x" + std::to_string(d->codedHeight) +
                " is outside what the Vulkan encoder takes (" +
                std::to_string(d->caps.minCodedExtent.width) + "x" +
                std::to_string(d->caps.minCodedExtent.height) + " to " +
                std::to_string(d->caps.maxCodedExtent.width) + "x" +
                std::to_string(d->caps.maxCodedExtent.height) + ")";
        stop();
        return false;
    }
    d->allocWidth = alignUp(d->codedWidth, std::max(d->caps.pictureAccessGranularity.width, 1u));
    d->allocHeight = alignUp(d->codedHeight, std::max(d->caps.pictureAccessGranularity.height, 1u));
    if (d->caps.maxActiveReferencePictures < 1 || d->h265Caps.maxPPictureL0ReferenceCount < 1) {
        error = "the driver's Vulkan encoder predicts from no picture";
        stop();
        return false;
    }

    // Pictures kept: the default (4, NVENC's and VA-API's), within the
    // driver's slots — the one being coded needs its own — and the level's.
    const uint64_t luma = static_cast<uint64_t>(d->codedWidth) * d->codedHeight;
    d->levelIdc = levelFor(luma);
    const int wanted = tuning.dpbFrames > 0 ? tuning.dpbFrames : 4;
    const int slots = static_cast<int>(std::max<uint32_t>(d->caps.maxDpbSlots, 2)) - 1;
    const int levelDpb = hevcMaxDpbSize(d->levelIdc, luma) - 1;
    m_Dpb = HevcDpb(std::clamp(wanted, 1, std::max(1, std::min(slots, levelDpb))), m_Fps);
    d->dpbLayers = static_cast<uint32_t>(m_Dpb.textures());

    // ── Intra refresh (C13.9) ──
    //
    // Asked, not promised: a driver without it, or without a way of splitting
    // the picture this stream can use, encodes keyframes on demand and says
    // so. Columns first — a vertical scroll, the desktop's usual motion,
    // stays inside its band — then rows, then blocks. Two seconds of
    // pictures a sweep, every four periods (RateControl.h), within what the
    // driver takes; the proof's own witness sweeps a few pictures back to
    // back, to cover them in a dozen.
    m_Sweep = IntraRefreshSweep();
    std::string noRefresh;
    if (intraRefresh) {
        const VkVideoEncodeIntraRefreshModeFlagsKHR modes =
            device->encodesIntraRefresh() ? d->refreshCaps.intraRefreshModes : 0;
        d->refreshMode = (modes & VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_COLUMN_BASED_BIT_KHR)
                             ? VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_COLUMN_BASED_BIT_KHR
                         : (modes & VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_ROW_BASED_BIT_KHR)
                             ? VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_ROW_BASED_BIT_KHR
                         : (modes & VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_BASED_BIT_KHR)
                             ? VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_BASED_BIT_KHR
                             : VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_NONE_KHR;
        const int duration = std::min<int>(
            witness.sweepPictures > 0 ? witness.sweepPictures : intraRefreshPeriodFrames(m_Fps),
            static_cast<int>(
                std::min<uint32_t>(d->refreshCaps.maxIntraRefreshCycleDuration, 1u << 20)));
        const int distance = witness.sweepPictures > 0 || tuning.intraRefreshDist < 0 ? duration
                             : tuning.intraRefreshDist > 0 ? tuning.intraRefreshDist
                                                           : intraRefreshDistanceFrames(m_Fps);
        if (!device->encodesIntraRefresh())
            noRefresh = "the driver has no VK_KHR_video_encode_intra_refresh";
        else if (d->refreshMode == VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_NONE_KHR)
            noRefresh = "the driver sweeps by none of columns, rows or blocks";
        else if (d->refreshCaps.maxIntraRefreshActiveReferencePictures < 1)
            noRefresh = "the driver predicts from nothing during a sweep";
        else if (duration < 2)
            noRefresh = "the driver's sweeps last " + std::to_string(duration) + " picture";
        else
            m_Sweep = IntraRefreshSweep(duration, distance);
    }

    if (!createResources(error)) {
        stop();
        return false;
    }
    if (!createSession(error) && m_Sweep.enabled() && d->session == VK_NULL_HANDLE) {
        // The driver lists the sweeps and refuses a session with them: the
        // stream goes on with keyframes on demand, rather than not at all.
        noRefresh = "the driver refused a session with it (" + error + ")";
        m_Sweep = IntraRefreshSweep();
        d->refreshMode = VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_NONE_KHR;
        error.clear();
        createSession(error);
    }
    if (!d->session || !d->parameters || !readParameterSets(error)) {
        if (error.empty()) error = "the Vulkan video session did not come up";
        stop();
        return false;
    }

    // The first encode costs what the next ones do not, and its slices are
    // the guard's first reading: paid here, on a black picture, which also
    // blackens the rows and columns past the visible picture for good.
    m_FirstPicture = true;
    m_GuardLeft = kGuardedPictures;
    m_Step = IntraRefreshSweep::Step{};
    uint32_t offset = 0, bytes = 0;
    const HevcDpb::Plan warm = m_Dpb.plan(0, true);
    if (!upload(nullptr, error) || !submit(warm, offset, bytes, error) ||
        !guard(d->bitstreamCpu + d->sliceOffset + offset, bytes, warm, error)) {
        error = "the Vulkan encoder's first picture: " + error;
        stop();
        return false;
    }

    m_Input.image = d->input;
    m_Input.luma = d->lumaView;
    m_Input.chroma = d->chromaView;
    m_Input.width = m_Width;
    m_Input.height = m_Height;
    m_Input.codedWidth = static_cast<int>(d->codedWidth);
    m_Input.codedHeight = static_cast<int>(d->codedHeight);

    log::info("[native] Vulkan Video encoder ready on " + device->name() + ": HEVC Main " +
              std::to_string(width) + "x" + std::to_string(height) + " coded " +
              std::to_string(d->codedWidth) + "x" + std::to_string(d->codedHeight) + "@" +
              std::to_string(m_Fps) + ", " +
              (d->constantQp ? "constant QP " + std::to_string(witness.constantQp)
                             : "CBR " + std::to_string(m_BitrateKbps) + " kbps") +
              ", level " + std::to_string(d->levelIdc / 30) + "." +
              std::to_string(d->levelIdc % 30 / 3) + ", CTB " + std::to_string(ctb) +
              ", transform depth " + std::to_string(m_TransformDepth) + ", " +
              std::to_string(m_Dpb.capacity()) + " pictures kept (reach " +
              std::to_string(m_Dpb.reachFrames()) + " frames), " + refreshText(noRefresh) + ", " +
              std::to_string(m_Headers.size()) + " bytes of parameter sets from the driver");
    return true;
}

std::string VulkanHevcEncoder::refreshText(const std::string& noRefresh) const
{
    if (!m_Sweep.enabled())
        return "keyframes on demand" +
               (noRefresh.empty() ? "" : " (intra refresh: " + noRefresh + ")");
    const char* mode =
        d->refreshMode == VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_COLUMN_BASED_BIT_KHR ? "columns"
        : d->refreshMode == VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_BLOCK_ROW_BASED_BIT_KHR  ? "rows"
                                                                                        : "blocks";
    return std::string("intra refresh by ") + mode + " over " + std::to_string(m_Sweep.duration()) +
           " pictures" +
           (m_Sweep.distance() > m_Sweep.duration() ? " every " + std::to_string(m_Sweep.distance())
                                                    : std::string(", back to back"));
}

bool VulkanHevcEncoder::createResources(std::string& error)
{
    const vulkan::DeviceFunctions& fn = *d->fn;
    VkDevice dev = d->dev;
    vulkan::VulkanDevice& device = *d->device;
    const uint32_t families[2] = {device.family(), device.encodeFamily()};
    const bool shared = families[0] != families[1];

    // ── The input: the conversion writes it as storage, the encoder reads it ──
    const VkImageUsageFlags inputUsage = VK_IMAGE_USAGE_VIDEO_ENCODE_SRC_BIT_KHR |
                                         VK_IMAGE_USAGE_STORAGE_BIT |
                                         VK_IMAGE_USAGE_TRANSFER_DST_BIT;
    const VkImageCreateFlags inputFlags =
        VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT | VK_IMAGE_CREATE_EXTENDED_USAGE_BIT;
    {
        VkPhysicalDeviceVideoFormatInfoKHR info = {};
        info.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VIDEO_FORMAT_INFO_KHR;
        info.pNext = &d->profile.list;
        info.imageUsage = inputUsage;
        std::vector<VkVideoFormatPropertiesKHR> formats;
        const VkResult r = device.videoFormats(info, formats);
        const bool found =
            r == VK_SUCCESS && std::any_of(formats.begin(), formats.end(), [&](const auto& f) {
                return f.format == VK_FORMAT_G8_B8R8_2PLANE_420_UNORM &&
                       f.imageTiling == VK_IMAGE_TILING_OPTIMAL &&
                       (f.imageCreateFlags & inputFlags) == inputFlags;
            });
        if (!found) {
            error = "the Vulkan encoder's input cannot be written by a compute shader here (" +
                    (r == VK_SUCCESS ? std::string("no NV12 storage input") : resultText(r)) + ")";
            return false;
        }
    }
    VkImageCreateInfo ici = {};
    ici.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    ici.pNext = &d->profile.list;
    ici.flags = inputFlags;
    ici.imageType = VK_IMAGE_TYPE_2D;
    ici.format = VK_FORMAT_G8_B8R8_2PLANE_420_UNORM;
    ici.extent = {d->allocWidth, d->allocHeight, 1};
    ici.mipLevels = 1;
    ici.arrayLayers = 1;
    ici.samples = VK_SAMPLE_COUNT_1_BIT;
    ici.tiling = VK_IMAGE_TILING_OPTIMAL;
    ici.usage = inputUsage;
    ici.sharingMode = shared ? VK_SHARING_MODE_CONCURRENT : VK_SHARING_MODE_EXCLUSIVE;
    ici.queueFamilyIndexCount = shared ? 2 : 0;
    ici.pQueueFamilyIndices = shared ? families : nullptr;
    ici.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    VkResult r = fn.vkCreateImage(dev, &ici, nullptr, &d->input);
    VkMemoryRequirements req = {};
    if (r == VK_SUCCESS) {
        fn.vkGetImageMemoryRequirements(dev, d->input, &req);
        r = d->allocate(req, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0, d->inputMemory);
    }
    if (r == VK_SUCCESS) r = fn.vkBindImageMemory(dev, d->input, d->inputMemory, 0);
    if (r != VK_SUCCESS) {
        error = "the Vulkan encoder's input picture: " + resultText(r);
        return false;
    }
    auto view = [&](VkImage image, VkImageViewType type, VkFormat format, VkImageAspectFlags aspect,
                    VkImageUsageFlags usage, uint32_t layers, VkImageView& out) {
        VkImageViewUsageCreateInfo vu = {};
        vu.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_USAGE_CREATE_INFO;
        vu.usage = usage;
        VkImageViewCreateInfo vci = {};
        vci.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
        vci.pNext = &vu;
        vci.image = image;
        vci.viewType = type;
        vci.format = format;
        vci.subresourceRange = {aspect, 0, 1, 0, layers};
        return fn.vkCreateImageView(dev, &vci, nullptr, &out);
    };
    r = view(d->input, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_G8_B8R8_2PLANE_420_UNORM,
             VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_USAGE_VIDEO_ENCODE_SRC_BIT_KHR, 1, d->inputView);
    if (r == VK_SUCCESS)
        r = view(d->input, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R8_UNORM, VK_IMAGE_ASPECT_PLANE_0_BIT,
                 VK_IMAGE_USAGE_STORAGE_BIT, 1, d->lumaView);
    if (r == VK_SUCCESS)
        r = view(d->input, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R8G8_UNORM, VK_IMAGE_ASPECT_PLANE_1_BIT,
                 VK_IMAGE_USAGE_STORAGE_BIT, 1, d->chromaView);
    if (r != VK_SUCCESS) {
        error = "the Vulkan encoder's input views: " + resultText(r);
        return false;
    }

    // ── The reconstructed pictures: one image, a layer each ──
    ici.flags = 0;
    ici.usage = VK_IMAGE_USAGE_VIDEO_ENCODE_DPB_BIT_KHR;
    ici.arrayLayers = d->dpbLayers;
    ici.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    ici.queueFamilyIndexCount = 0;
    ici.pQueueFamilyIndices = nullptr;
    r = fn.vkCreateImage(dev, &ici, nullptr, &d->dpb);
    if (r == VK_SUCCESS) {
        fn.vkGetImageMemoryRequirements(dev, d->dpb, &req);
        r = d->allocate(req, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0, d->dpbMemory);
    }
    if (r == VK_SUCCESS) r = fn.vkBindImageMemory(dev, d->dpb, d->dpbMemory, 0);
    if (r == VK_SUCCESS)
        r = view(d->dpb, VK_IMAGE_VIEW_TYPE_2D_ARRAY, VK_FORMAT_G8_B8R8_2PLANE_420_UNORM,
                 VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_USAGE_VIDEO_ENCODE_DPB_BIT_KHR, d->dpbLayers,
                 d->dpbView);
    if (r != VK_SUCCESS) {
        error = "the Vulkan encoder's reconstructed pictures: " + resultText(r);
        return false;
    }

    // ── The bitstream, read in place by the CPU: cached memory if there is ──
    const VkMemoryPropertyFlags visible =
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    d->sliceOffset =
        alignUp(kHeaderRoom, std::max<VkDeviceSize>(d->caps.minBitstreamBufferOffsetAlignment, 1));
    // The worst picture: a raw one and some, as the D3D12 chain sizes it.
    const VkDeviceSize worst =
        static_cast<VkDeviceSize>(d->codedWidth) * d->codedHeight * 3 / 2 + 65536;
    d->bitstreamSize = alignUp(d->sliceOffset + worst,
                               std::max<VkDeviceSize>(d->caps.minBitstreamBufferSizeAlignment, 1));
    VkBufferCreateInfo bci = {};
    bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bci.pNext = &d->profile.list;
    bci.size = d->bitstreamSize;
    bci.usage = VK_BUFFER_USAGE_VIDEO_ENCODE_DST_BIT_KHR;
    bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    r = fn.vkCreateBuffer(dev, &bci, nullptr, &d->bitstream);
    if (r == VK_SUCCESS) {
        fn.vkGetBufferMemoryRequirements(dev, d->bitstream, &req);
        r = d->allocate(req, visible | VK_MEMORY_PROPERTY_HOST_CACHED_BIT, visible,
                        d->bitstreamMemory);
    }
    if (r == VK_SUCCESS) r = fn.vkBindBufferMemory(dev, d->bitstream, d->bitstreamMemory, 0);
    if (r == VK_SUCCESS)
        r = fn.vkMapMemory(dev, d->bitstreamMemory, 0, VK_WHOLE_SIZE, 0,
                           reinterpret_cast<void**>(&d->bitstreamCpu));
    if (r != VK_SUCCESS) {
        error = "the Vulkan encoder's bitstream buffer: " + resultText(r);
        return false;
    }

    // ── The CPU's pictures (upload()): black, the picture written over it ──
    const VkDeviceSize picture = static_cast<VkDeviceSize>(d->codedWidth) * d->codedHeight * 3 / 2;
    bci.pNext = nullptr;
    bci.size = picture;
    bci.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
    r = fn.vkCreateBuffer(dev, &bci, nullptr, &d->staging);
    if (r == VK_SUCCESS) {
        fn.vkGetBufferMemoryRequirements(dev, d->staging, &req);
        r = d->allocate(req, visible, visible, d->stagingMemory);
    }
    if (r == VK_SUCCESS) r = fn.vkBindBufferMemory(dev, d->staging, d->stagingMemory, 0);
    if (r == VK_SUCCESS)
        r = fn.vkMapMemory(dev, d->stagingMemory, 0, VK_WHOLE_SIZE, 0,
                           reinterpret_cast<void**>(&d->stagingCpu));
    if (r != VK_SUCCESS) {
        error = "the Vulkan encoder's upload buffer: " + resultText(r);
        return false;
    }
    const size_t lumaBytes = static_cast<size_t>(d->codedWidth) * d->codedHeight;
    std::memset(d->stagingCpu, 16, lumaBytes);
    std::memset(d->stagingCpu + lumaBytes, 128, lumaBytes / 2);

    // ── Commands, and the feedback that says where the slices landed ──
    for (int q = 0; q < 2; ++q) {
        VkCommandPoolCreateInfo pci = {};
        pci.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
        pci.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
        pci.queueFamilyIndex = q == 0 ? device.encodeFamily() : device.family();
        VkCommandPool& pool = q == 0 ? d->encodePool : d->uploadPool;
        r = fn.vkCreateCommandPool(dev, &pci, nullptr, &pool);
        if (r != VK_SUCCESS) break;
        VkCommandBufferAllocateInfo cai = {};
        cai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
        cai.commandPool = pool;
        cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cai.commandBufferCount = 1;
        r = fn.vkAllocateCommandBuffers(dev, &cai, q == 0 ? &d->encodeCmd : &d->uploadCmd);
        if (r != VK_SUCCESS) break;
    }
    if (r == VK_SUCCESS) {
        VkQueryPoolVideoEncodeFeedbackCreateInfoKHR fci = {};
        fci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_VIDEO_ENCODE_FEEDBACK_CREATE_INFO_KHR;
        fci.pNext = &d->profile.info;
        fci.encodeFeedbackFlags = VK_VIDEO_ENCODE_FEEDBACK_BITSTREAM_BUFFER_OFFSET_BIT_KHR |
                                  VK_VIDEO_ENCODE_FEEDBACK_BITSTREAM_BYTES_WRITTEN_BIT_KHR;
        VkQueryPoolCreateInfo qci = {};
        qci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
        qci.pNext = &fci;
        qci.queryType = VK_QUERY_TYPE_VIDEO_ENCODE_FEEDBACK_KHR;
        qci.queryCount = 1;
        r = fn.vkCreateQueryPool(dev, &qci, nullptr, &d->feedback);
    }
    if (r != VK_SUCCESS) {
        error = "the Vulkan encoder's commands: " + resultText(r);
        return false;
    }
    return true;
}

bool VulkanHevcEncoder::createSession(std::string& error)
{
    const vulkan::DeviceFunctions& fn = *d->fn;
    VkDevice dev = d->dev;
    VkVideoSessionCreateInfoKHR sci = {};
    sci.sType = VK_STRUCTURE_TYPE_VIDEO_SESSION_CREATE_INFO_KHR;
    sci.queueFamilyIndex = d->device->encodeFamily();
    sci.pVideoProfile = &d->profile.info;
    sci.pictureFormat = VK_FORMAT_G8_B8R8_2PLANE_420_UNORM;
    sci.maxCodedExtent = {d->codedWidth, d->codedHeight};
    sci.referencePictureFormat = VK_FORMAT_G8_B8R8_2PLANE_420_UNORM;
    sci.maxDpbSlots = d->dpbLayers;
    sci.maxActiveReferencePictures = 1;
    sci.pStdHeaderVersion = &d->caps.stdHeaderVersion;
    // The sweeps are the session's to allow, at its creation (C13.9).
    VkVideoEncodeSessionIntraRefreshCreateInfoKHR refresh = {};
    if (m_Sweep.enabled()) {
        refresh.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_SESSION_INTRA_REFRESH_CREATE_INFO_KHR;
        refresh.intraRefreshMode = d->refreshMode;
        sci.pNext = &refresh;
    }
    VkResult r = fn.vkCreateVideoSessionKHR(dev, &sci, nullptr, &d->session);
    if (r != VK_SUCCESS) {
        d->session = VK_NULL_HANDLE;
        error = "the Vulkan video session: " + resultText(r);
        return false;
    }
    uint32_t n = 0;
    fn.vkGetVideoSessionMemoryRequirementsKHR(dev, d->session, &n, nullptr);
    std::vector<VkVideoSessionMemoryRequirementsKHR> reqs(n);
    for (auto& q : reqs) {
        q = {};
        q.sType = VK_STRUCTURE_TYPE_VIDEO_SESSION_MEMORY_REQUIREMENTS_KHR;
    }
    fn.vkGetVideoSessionMemoryRequirementsKHR(dev, d->session, &n, reqs.data());
    std::vector<VkBindVideoSessionMemoryInfoKHR> binds(n);
    for (uint32_t i = 0; i < n; ++i) {
        VkDeviceMemory memory = VK_NULL_HANDLE;
        r = d->allocate(reqs[i].memoryRequirements, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0, memory);
        if (r != VK_SUCCESS) {
            error = "the Vulkan video session's memory: " + resultText(r);
            return false;
        }
        d->sessionMemory.push_back(memory);
        binds[i] = {};
        binds[i].sType = VK_STRUCTURE_TYPE_BIND_VIDEO_SESSION_MEMORY_INFO_KHR;
        binds[i].memoryBindIndex = reqs[i].memoryBindIndex;
        binds[i].memory = memory;
        binds[i].memorySize = reqs[i].memoryRequirements.size;
    }
    r = fn.vkBindVideoSessionMemoryKHR(dev, d->session, n, binds.data());
    if (r != VK_SUCCESS) {
        error = "vkBindVideoSessionMemoryKHR: " + resultText(r);
        return false;
    }

    // ── Our parameter sets, as StdVideo structures ──
    StdVideoH265ProfileTierLevel ptl = {};
    ptl.flags.general_progressive_source_flag = 1;
    ptl.flags.general_frame_only_constraint_flag = 1;
    ptl.general_profile_idc = STD_VIDEO_H265_PROFILE_IDC_MAIN;
    ptl.general_level_idc = stdLevel(d->levelIdc);
    StdVideoH265DecPicBufMgr dpbMgr = {};
    dpbMgr.max_dec_pic_buffering_minus1[0] = static_cast<uint8_t>(m_Dpb.capacity());
    StdVideoH265VideoParameterSet vps = {};
    vps.flags.vps_temporal_id_nesting_flag = 1;
    vps.flags.vps_sub_layer_ordering_info_present_flag = 1;
    vps.pDecPicBufMgr = &dpbMgr;
    vps.pProfileTierLevel = &ptl;
    // BT.709, limited range: what the conversion writes.
    StdVideoH265SequenceParameterSetVui vui = {};
    vui.flags.video_signal_type_present_flag = 1;
    vui.flags.colour_description_present_flag = 1;
    vui.video_format = 5;     // unspecified
    vui.colour_primaries = 1; // BT.709
    vui.transfer_characteristics = 1;
    vui.matrix_coeffs = 1;
    StdVideoH265SequenceParameterSet sps = {};
    sps.flags.sps_temporal_id_nesting_flag = 1;
    sps.flags.sps_sub_layer_ordering_info_present_flag = 1;
    sps.flags.conformance_window_flag = d->codedWidth != static_cast<uint32_t>(m_Width) ||
                                        d->codedHeight != static_cast<uint32_t>(m_Height);
    // AMP and strong intra smoothing, as the VA-API sets have them
    // (ParameterSets.h); both coded right on the 780M (§8o.3).
    sps.flags.amp_enabled_flag = 1;
    sps.flags.strong_intra_smoothing_enabled_flag = 1;
    sps.flags.vui_parameters_present_flag = 1;
    sps.chroma_format_idc = STD_VIDEO_H265_CHROMA_FORMAT_IDC_420;
    sps.pic_width_in_luma_samples = d->codedWidth;
    sps.pic_height_in_luma_samples = d->codedHeight;
    sps.log2_max_pic_order_cnt_lsb_minus4 = 12;
    sps.log2_min_luma_coding_block_size_minus3 = 0;
    sps.log2_diff_max_min_luma_coding_block_size = static_cast<uint8_t>(d->log2Ctb - 3);
    sps.log2_min_luma_transform_block_size_minus2 = static_cast<uint8_t>(d->log2MinTb - 2);
    sps.log2_diff_max_min_luma_transform_block_size =
        static_cast<uint8_t>(d->log2MaxTb - d->log2MinTb);
    // The full depth, CtbLog2SizeY − MinTbLog2SizeY: what AMD's firmware
    // codes whatever the SPS says (see the header).
    const int fullDepth = static_cast<int>(d->log2Ctb - d->log2MinTb);
    const int depth =
        m_Witness.transformDepth >= 0 ? std::min(m_Witness.transformDepth, fullDepth) : fullDepth;
    sps.max_transform_hierarchy_depth_inter = static_cast<uint8_t>(depth);
    sps.max_transform_hierarchy_depth_intra = static_cast<uint8_t>(depth);
    sps.conf_win_right_offset = (d->codedWidth - static_cast<uint32_t>(m_Width)) / 2;
    sps.conf_win_bottom_offset = (d->codedHeight - static_cast<uint32_t>(m_Height)) / 2;
    sps.pProfileTierLevel = &ptl;
    sps.pDecPicBufMgr = &dpbMgr;
    sps.pSequenceParameterSetVui = &vui;
    StdVideoH265PictureParameterSet pps = {};
    pps.flags.cu_qp_delta_enabled_flag = 1;

    VkVideoEncodeH265SessionParametersAddInfoKHR add = {};
    add.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_SESSION_PARAMETERS_ADD_INFO_KHR;
    add.stdVPSCount = 1;
    add.pStdVPSs = &vps;
    add.stdSPSCount = 1;
    add.pStdSPSs = &sps;
    add.stdPPSCount = 1;
    add.pStdPPSs = &pps;
    VkVideoEncodeQualityLevelInfoKHR quality = {};
    quality.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_QUALITY_LEVEL_INFO_KHR;
    quality.qualityLevel = 0;
    VkVideoEncodeH265SessionParametersCreateInfoKHR h265p = {};
    h265p.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_SESSION_PARAMETERS_CREATE_INFO_KHR;
    h265p.pNext = &quality;
    h265p.maxStdVPSCount = 1;
    h265p.maxStdSPSCount = 1;
    h265p.maxStdPPSCount = 1;
    h265p.pParametersAddInfo = &add;
    VkVideoSessionParametersCreateInfoKHR pci = {};
    pci.sType = VK_STRUCTURE_TYPE_VIDEO_SESSION_PARAMETERS_CREATE_INFO_KHR;
    pci.pNext = &h265p;
    pci.videoSession = d->session;
    r = fn.vkCreateVideoSessionParametersKHR(dev, &pci, nullptr, &d->parameters);
    if (r != VK_SUCCESS) {
        d->parameters = VK_NULL_HANDLE;
        error = "the driver refuses our HEVC parameter sets: " + resultText(r);
        return false;
    }
    const uint32_t bitsPerSecond = static_cast<uint32_t>(m_BitrateKbps) * 1000u;
    d->rate[0].set(d->constantQp, bitsPerSecond, m_Fps, m_VbvFrames);
    d->current = 0;
    return true;
}

bool VulkanHevcEncoder::readParameterSets(std::string& error)
{
    const vulkan::DeviceFunctions& fn = *d->fn;
    VkVideoEncodeH265SessionParametersGetInfoKHR g265 = {};
    g265.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_SESSION_PARAMETERS_GET_INFO_KHR;
    g265.writeStdVPS = VK_TRUE;
    g265.writeStdSPS = VK_TRUE;
    g265.writeStdPPS = VK_TRUE;
    VkVideoEncodeSessionParametersGetInfoKHR get = {};
    get.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_SESSION_PARAMETERS_GET_INFO_KHR;
    get.pNext = &g265;
    get.videoSessionParameters = d->parameters;
    VkVideoEncodeH265SessionParametersFeedbackInfoKHR f265 = {};
    f265.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_SESSION_PARAMETERS_FEEDBACK_INFO_KHR;
    VkVideoEncodeSessionParametersFeedbackInfoKHR feedback = {};
    feedback.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_SESSION_PARAMETERS_FEEDBACK_INFO_KHR;
    feedback.pNext = &f265;
    size_t size = 0;
    VkResult r = fn.vkGetEncodedVideoSessionParametersKHR(d->dev, &get, &feedback, &size, nullptr);
    if (r == VK_SUCCESS && size > 0) {
        m_Headers.resize(size);
        r = fn.vkGetEncodedVideoSessionParametersKHR(d->dev, &get, &feedback, &size,
                                                     m_Headers.data());
        m_Headers.resize(size);
    }
    if (r != VK_SUCCESS || m_Headers.empty() ||
        m_Headers.size() > static_cast<size_t>(d->sliceOffset)) {
        error = "the driver writes no HEVC parameter sets (" +
                (r == VK_SUCCESS ? std::to_string(m_Headers.size()) + " bytes" : resultText(r)) +
                ")";
        return false;
    }
    // Read back: the slices are judged with what the driver stands by, not
    // with what we asked for (it may override, and says so).
    bool haveSps = false, havePps = false;
    std::string unread;
    for (const HevcNalUnit& u : hevcNalUnits(m_Headers.data(), m_Headers.size())) {
        if (u.type() == 33) {
            unread += parseHevcSps(u.data, u.size, m_SpsFields);
            haveSps = true;
        } else if (u.type() == 34) {
            unread += parseHevcPps(u.data, u.size, m_PpsFields);
            havePps = true;
        }
    }
    if (!haveSps || !havePps || !unread.empty()) {
        error = "the driver's parameter sets do not read: " +
                (unread.empty() ? std::string("no SPS or no PPS") : unread);
        return false;
    }
    m_TransformDepth = static_cast<int>(m_SpsFields.maxTransformHierarchyDepthInter);
    if (feedback.hasOverrides)
        log::info(std::string("[native] Vulkan Video: the driver rewrites our parameter sets (") +
                  (f265.hasStdVPSOverrides ? "VPS " : "") +
                  (f265.hasStdSPSOverrides ? "SPS " : "") + (f265.hasStdPPSOverrides ? "PPS" : "") +
                  "), and they are what goes out");
    // Laid right in front of the slices: an IDR goes out as one run.
    std::memcpy(d->bitstreamCpu + d->sliceOffset - m_Headers.size(), m_Headers.data(),
                m_Headers.size());
    return true;
}

bool VulkanHevcEncoder::upload(const uint8_t* nv12, std::string& error)
{
    if (!d->input) {
        error = "the encoder is not initialized";
        return false;
    }
    const vulkan::DeviceFunctions& fn = *d->fn;
    const size_t w = static_cast<size_t>(m_Width), h = static_cast<size_t>(m_Height);
    const size_t cw = d->codedWidth, ch = d->codedHeight;
    uint8_t* luma = d->stagingCpu;
    uint8_t* chroma = d->stagingCpu + cw * ch;
    if (nv12) {
        for (size_t row = 0; row < h; ++row)
            std::memcpy(luma + row * cw, nv12 + row * w, w);
        for (size_t row = 0; row < h / 2; ++row)
            std::memcpy(chroma + row * cw, nv12 + w * h + row * w, w);
    } else {
        std::memset(luma, 16, cw * ch);
        std::memset(chroma, 128, cw * ch / 2);
    }

    VkCommandBuffer cmd = d->uploadCmd;
    fn.vkResetCommandBuffer(cmd, 0);
    VkCommandBufferBeginInfo cbi = {};
    cbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    fn.vkBeginCommandBuffer(cmd, &cbi);
    VkDependencyInfo dep = {};
    dep.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
    dep.imageMemoryBarrierCount = 1;
    // From the copy stage, the one the submission's wait holds back: the
    // layout changes after the encode that read the input is done.
    VkImageMemoryBarrier2 toCopy = imageBarrier(
        d->input,
        d->inputTouched ? VK_IMAGE_LAYOUT_VIDEO_ENCODE_SRC_KHR : VK_IMAGE_LAYOUT_UNDEFINED,
        VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_NONE,
        VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT);
    dep.pImageMemoryBarriers = &toCopy;
    fn.vkCmdPipelineBarrier2(cmd, &dep);
    VkBufferImageCopy regions[2] = {};
    regions[0].imageSubresource = {VK_IMAGE_ASPECT_PLANE_0_BIT, 0, 0, 1};
    regions[0].imageExtent = {d->codedWidth, d->codedHeight, 1};
    regions[1].bufferOffset = cw * ch;
    regions[1].imageSubresource = {VK_IMAGE_ASPECT_PLANE_1_BIT, 0, 0, 1};
    regions[1].imageExtent = {d->codedWidth / 2, d->codedHeight / 2, 1};
    fn.vkCmdCopyBufferToImage(cmd, d->staging, d->input, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 2,
                              regions);
    VkImageMemoryBarrier2 toEncode = imageBarrier(
        d->input, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_VIDEO_ENCODE_SRC_KHR,
        VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT,
        VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, VK_ACCESS_2_NONE);
    dep.pImageMemoryBarriers = &toEncode;
    fn.vkCmdPipelineBarrier2(cmd, &dep);
    fn.vkEndCommandBuffer(cmd);
    // After the encode that read the input last, on the GPU.
    const VkSemaphoreSubmitInfo wait = d->device->afterLast(VK_PIPELINE_STAGE_2_COPY_BIT);
    std::string why;
    if (!d->device->run(cmd, wait.semaphore ? &wait : nullptr, wait.semaphore ? 1u : 0u, why)) {
        m_Failed = true;
        error = "the picture did not reach the Vulkan encoder: " + why;
        return false;
    }
    d->inputTouched = true;
    return true;
}

bool VulkanHevcEncoder::submit(const HevcDpb::Plan& plan, uint32_t& offset, uint32_t& bytes,
                               std::string& error)
{
    const vulkan::DeviceFunctions& fn = *d->fn;
    VkCommandBuffer cmd = d->encodeCmd;
    fn.vkResetCommandBuffer(cmd, 0);
    VkCommandBufferBeginInfo cbi = {};
    cbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    fn.vkBeginCommandBuffer(cmd, &cbi);
    fn.vkCmdResetQueryPool(cmd, d->feedback, 0, 1);

    // The reconstructed pictures: what the last picture wrote, read and
    // written by this one.
    VkImageMemoryBarrier2 dpbBarrier = imageBarrier(
        d->dpb, d->dpbTouched ? VK_IMAGE_LAYOUT_VIDEO_ENCODE_DPB_KHR : VK_IMAGE_LAYOUT_UNDEFINED,
        VK_IMAGE_LAYOUT_VIDEO_ENCODE_DPB_KHR,
        d->dpbTouched ? VK_PIPELINE_STAGE_2_VIDEO_ENCODE_BIT_KHR : VK_PIPELINE_STAGE_2_NONE,
        d->dpbTouched ? VK_ACCESS_2_VIDEO_ENCODE_WRITE_BIT_KHR : VK_ACCESS_2_NONE,
        VK_PIPELINE_STAGE_2_VIDEO_ENCODE_BIT_KHR,
        VK_ACCESS_2_VIDEO_ENCODE_READ_BIT_KHR | VK_ACCESS_2_VIDEO_ENCODE_WRITE_BIT_KHR,
        d->dpbLayers);
    VkDependencyInfo dep = {};
    dep.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
    dep.imageMemoryBarrierCount = 1;
    dep.pImageMemoryBarriers = &dpbBarrier;
    fn.vkCmdPipelineBarrier2(cmd, &dep);

    // Every picture kept, the used one first, each in its layer; then the
    // layer this picture is reconstructed into, not yet a reference.
    const size_t kept = plan.idr ? 0 : plan.references.size();
    std::vector<VkVideoPictureResourceInfoKHR> resources(d->dpbLayers);
    for (uint32_t s = 0; s < d->dpbLayers; ++s) {
        resources[s] = {};
        resources[s].sType = VK_STRUCTURE_TYPE_VIDEO_PICTURE_RESOURCE_INFO_KHR;
        resources[s].codedExtent = {d->codedWidth, d->codedHeight};
        resources[s].baseArrayLayer = s;
        resources[s].imageViewBinding = d->dpbView;
    }
    std::vector<StdVideoEncodeH265ReferenceInfo> refStd(kept);
    std::vector<VkVideoEncodeH265DpbSlotInfoKHR> refDpb(kept);
    std::vector<VkVideoReferenceSlotInfoKHR> beginSlots;
    for (size_t k = 0; k < kept; ++k) {
        const HevcDpb::Reference& ref = plan.references[k];
        refStd[k] = {};
        refStd[k].pic_type =
            ref.poc == 0 ? STD_VIDEO_H265_PICTURE_TYPE_IDR : STD_VIDEO_H265_PICTURE_TYPE_P;
        refStd[k].PicOrderCntVal = static_cast<int32_t>(ref.poc);
        refDpb[k] = {};
        refDpb[k].sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_DPB_SLOT_INFO_KHR;
        refDpb[k].pStdReferenceInfo = &refStd[k];
        VkVideoReferenceSlotInfoKHR slot = {};
        slot.sType = VK_STRUCTURE_TYPE_VIDEO_REFERENCE_SLOT_INFO_KHR;
        slot.pNext = &refDpb[k];
        slot.slotIndex = ref.texture;
        slot.pPictureResource = &resources[static_cast<size_t>(ref.texture)];
        beginSlots.push_back(slot);
    }
    {
        VkVideoReferenceSlotInfoKHR slot = {};
        slot.sType = VK_STRUCTURE_TYPE_VIDEO_REFERENCE_SLOT_INFO_KHR;
        slot.slotIndex = -1;
        slot.pPictureResource = &resources[static_cast<size_t>(plan.texture)];
        beginSlots.push_back(slot);
    }
    VkVideoBeginCodingInfoKHR begin = {};
    begin.sType = VK_STRUCTURE_TYPE_VIDEO_BEGIN_CODING_INFO_KHR;
    // The state the last control set; none before the first.
    begin.pNext = m_FirstPicture ? nullptr : &d->rate[d->current].info;
    begin.videoSession = d->session;
    begin.videoSessionParameters = d->parameters;
    begin.referenceSlotCount = static_cast<uint32_t>(beginSlots.size());
    begin.pReferenceSlots = beginSlots.data();
    fn.vkCmdBeginVideoCodingKHR(cmd, &begin);
    if (m_FirstPicture) {
        VkVideoEncodeQualityLevelInfoKHR quality = {};
        quality.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_QUALITY_LEVEL_INFO_KHR;
        quality.pNext = &d->rate[d->current].info;
        quality.qualityLevel = 0;
        VkVideoCodingControlInfoKHR control = {};
        control.sType = VK_STRUCTURE_TYPE_VIDEO_CODING_CONTROL_INFO_KHR;
        control.pNext = &quality;
        control.flags = VK_VIDEO_CODING_CONTROL_RESET_BIT_KHR |
                        VK_VIDEO_CODING_CONTROL_ENCODE_RATE_CONTROL_BIT_KHR |
                        VK_VIDEO_CODING_CONTROL_ENCODE_QUALITY_LEVEL_BIT_KHR;
        fn.vkCmdControlVideoCodingKHR(cmd, &control);
    } else if (m_RateChanged) {
        VkVideoCodingControlInfoKHR control = {};
        control.sType = VK_STRUCTURE_TYPE_VIDEO_CODING_CONTROL_INFO_KHR;
        control.pNext = &d->rate[1 - d->current].info;
        control.flags = VK_VIDEO_CODING_CONTROL_ENCODE_RATE_CONTROL_BIT_KHR;
        fn.vkCmdControlVideoCodingKHR(cmd, &control);
    }

    // The reference set: every picture kept, newest first, the first one used.
    StdVideoH265ShortTermRefPicSet rps = {};
    StdVideoEncodeH265ReferenceListsInfo lists = {};
    std::memset(lists.RefPicList0, STD_VIDEO_H265_NO_REFERENCE_PICTURE, sizeof(lists.RefPicList0));
    std::memset(lists.RefPicList1, STD_VIDEO_H265_NO_REFERENCE_PICTURE, sizeof(lists.RefPicList1));
    if (!plan.idr) {
        rps.num_negative_pics = static_cast<uint8_t>(kept);
        int32_t previous = static_cast<int32_t>(plan.poc);
        for (size_t k = 0; k < kept; ++k) {
            const int32_t poc = static_cast<int32_t>(plan.references[k].poc);
            rps.delta_poc_s0_minus1[k] = static_cast<uint16_t>(previous - poc - 1);
            previous = poc;
            if (plan.references[k].used) rps.used_by_curr_pic_s0_flag |= 1u << k;
        }
        lists.num_ref_idx_l0_active_minus1 = 0;
        lists.RefPicList0[0] = static_cast<uint8_t>(plan.references[0].texture);
    }
    StdVideoEncodeH265PictureInfo picture = {};
    picture.flags.is_reference = 1;
    picture.flags.IrapPicFlag = plan.idr ? 1 : 0;
    picture.flags.pic_output_flag = 1;
    picture.pic_type = plan.idr ? STD_VIDEO_H265_PICTURE_TYPE_IDR : STD_VIDEO_H265_PICTURE_TYPE_P;
    picture.PicOrderCntVal = static_cast<int32_t>(plan.poc);
    picture.pRefLists = &lists;
    picture.pShortTermRefPicSet = &rps;
    StdVideoEncodeH265SliceSegmentHeader slice = {};
    slice.flags.first_slice_segment_in_pic_flag = 1;
    slice.slice_type = plan.idr ? STD_VIDEO_H265_SLICE_TYPE_I : STD_VIDEO_H265_SLICE_TYPE_P;
    slice.MaxNumMergeCand = 5;
    VkVideoEncodeH265NaluSliceSegmentInfoKHR nalu = {};
    nalu.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_NALU_SLICE_SEGMENT_INFO_KHR;
    nalu.constantQp = d->constantQp ? m_Witness.constantQp : 0;
    nalu.pStdSliceSegmentHeader = &slice;
    VkVideoEncodeH265PictureInfoKHR h265Picture = {};
    h265Picture.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_PICTURE_INFO_KHR;
    h265Picture.naluSliceSegmentEntryCount = 1;
    h265Picture.pNaluSliceSegmentEntries = &nalu;
    h265Picture.pStdPictureInfo = &picture;

    StdVideoEncodeH265ReferenceInfo setupStd = {};
    setupStd.pic_type = picture.pic_type;
    setupStd.PicOrderCntVal = picture.PicOrderCntVal;
    VkVideoEncodeH265DpbSlotInfoKHR setupDpb = {};
    setupDpb.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_H265_DPB_SLOT_INFO_KHR;
    setupDpb.pStdReferenceInfo = &setupStd;
    VkVideoReferenceSlotInfoKHR setupSlot = {};
    setupSlot.sType = VK_STRUCTURE_TYPE_VIDEO_REFERENCE_SLOT_INFO_KHR;
    setupSlot.pNext = &setupDpb;
    setupSlot.slotIndex = plan.texture;
    setupSlot.pPictureResource = &resources[static_cast<size_t>(plan.texture)];

    VkVideoEncodeInfoKHR info = {};
    info.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_INFO_KHR;
    info.pNext = &h265Picture;
    info.dstBuffer = d->bitstream;
    info.dstBufferOffset = d->sliceOffset;
    info.dstBufferRange = d->bitstreamSize - d->sliceOffset;
    info.srcPictureResource.sType = VK_STRUCTURE_TYPE_VIDEO_PICTURE_RESOURCE_INFO_KHR;
    info.srcPictureResource.codedExtent = {d->codedWidth, d->codedHeight};
    info.srcPictureResource.imageViewBinding = d->inputView;
    info.pSetupReferenceSlot = &setupSlot;
    info.referenceSlotCount = plan.idr ? 0 : 1;
    info.pReferenceSlots = plan.idr ? nullptr : &beginSlots[0];
    // A picture of a sweep (C13.9): its index in it, and — on the reference
    // it predicts from, the previous picture or a wholly dirty one — how many
    // regions of that reference are still to be refreshed.
    VkVideoEncodeIntraRefreshInfoKHR refresh = {};
    VkVideoReferenceIntraRefreshInfoKHR dirty = {};
    VkVideoReferenceSlotInfoKHR refreshSlot = {};
    if (m_Step.refresh) {
        refresh.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_INTRA_REFRESH_INFO_KHR;
        refresh.pNext = info.pNext;
        refresh.intraRefreshCycleDuration = m_Step.duration;
        refresh.intraRefreshIndex = m_Step.index;
        info.pNext = &refresh;
        info.flags |= VK_VIDEO_ENCODE_INTRA_REFRESH_BIT_KHR;
        if (!plan.idr) {
            dirty.sType = VK_STRUCTURE_TYPE_VIDEO_REFERENCE_INTRA_REFRESH_INFO_KHR;
            dirty.pNext = beginSlots[0].pNext;
            dirty.dirtyIntraRefreshRegions = m_Step.referenceDirty;
            refreshSlot = beginSlots[0];
            refreshSlot.pNext = &dirty;
            info.pReferenceSlots = &refreshSlot;
        }
    }
    fn.vkCmdBeginQuery(cmd, d->feedback, 0, 0);
    fn.vkCmdEncodeVideoKHR(cmd, &info);
    fn.vkCmdEndQuery(cmd, d->feedback, 0);
    VkVideoEndCodingInfoKHR end = {};
    end.sType = VK_STRUCTURE_TYPE_VIDEO_END_CODING_INFO_KHR;
    fn.vkCmdEndVideoCodingKHR(cmd, &end);
    // The slices, for the CPU that reads them in place.
    VkBufferMemoryBarrier2 toHost = {};
    toHost.sType = VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER_2;
    toHost.srcStageMask = VK_PIPELINE_STAGE_2_VIDEO_ENCODE_BIT_KHR;
    toHost.srcAccessMask = VK_ACCESS_2_VIDEO_ENCODE_WRITE_BIT_KHR;
    toHost.dstStageMask = VK_PIPELINE_STAGE_2_HOST_BIT;
    toHost.dstAccessMask = VK_ACCESS_2_HOST_READ_BIT;
    toHost.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    toHost.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    toHost.buffer = d->bitstream;
    toHost.size = VK_WHOLE_SIZE;
    VkDependencyInfo hostDep = {};
    hostDep.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
    hostDep.bufferMemoryBarrierCount = 1;
    hostDep.pBufferMemoryBarriers = &toHost;
    fn.vkCmdPipelineBarrier2(cmd, &hostDep);
    fn.vkEndCommandBuffer(cmd);

    // After whatever wrote the input last — the conversion, or upload() — on
    // the GPU: its semaphore is what makes those writes visible here.
    const VkSemaphoreSubmitInfo wait =
        d->device->afterLast(VK_PIPELINE_STAGE_2_VIDEO_ENCODE_BIT_KHR);
    std::string why;
    if (!d->device->runOn(d->device->encodeQueue(), cmd, wait.semaphore ? &wait : nullptr,
                          wait.semaphore ? 1u : 0u, why)) {
        m_Failed = true;
        error = "the Vulkan encode failed: " + why;
        return false;
    }
    d->dpbTouched = true;
    if (m_FirstPicture) {
        m_FirstPicture = false;
    } else if (m_RateChanged) {
        d->current = 1 - d->current;
        m_RateChanged = false;
    }

    struct
    {
        uint32_t offset;
        uint32_t bytes;
    } result = {};
    const VkResult r = fn.vkGetQueryPoolResults(d->dev, d->feedback, 0, 1, sizeof(result), &result,
                                                sizeof(result), VK_QUERY_RESULT_WAIT_BIT);
    const VkDeviceSize room = d->bitstreamSize - d->sliceOffset;
    if (r != VK_SUCCESS || result.bytes == 0 ||
        static_cast<VkDeviceSize>(result.offset) + result.bytes > room) {
        m_Failed = true;
        error = r != VK_SUCCESS ? "the encode's feedback: " + resultText(r)
                                : "the driver says it wrote " + std::to_string(result.bytes) +
                                      " bytes at " + std::to_string(result.offset);
        return false;
    }
    offset = result.offset;
    bytes = result.bytes;
    return true;
}

bool VulkanHevcEncoder::guard(const uint8_t* data, size_t size, const HevcDpb::Plan& plan,
                              std::string& error)
{
    int slices = 0;
    for (const HevcNalUnit& unit : hevcNalUnits(data, size)) {
        if (unit.type() > 31) continue; // not a slice: an AUD or an SEI the driver adds
        HevcSliceFields f;
        const std::string wrong =
            parseHevcSliceHeader(unit.data, unit.size, m_SpsFields, m_PpsFields, f);
        if (!wrong.empty()) {
            error = "the driver's slices do not read with its own parameter sets: " + wrong;
            return false;
        }
        const uint32_t pocMask = (1u << m_SpsFields.log2MaxPocLsb) - 1u;
        if (!plan.idr && f.pocLsb != (plan.poc & pocMask)) {
            error = "the driver numbered picture " + std::to_string(plan.poc) + " as " +
                    std::to_string(f.pocLsb);
            return false;
        }
        if (!plan.idr && !plan.references.empty()) {
            const int32_t wanted =
                static_cast<int32_t>(plan.references[0].poc) - static_cast<int32_t>(plan.poc);
            const bool found = std::any_of(f.shortTerm.begin(), f.shortTerm.end(),
                                           [&](const HevcSliceFields::Reference& ref) {
                                               return ref.used && ref.deltaPoc == wanted;
                                           });
            if (!found) {
                error = "the driver's slice does not predict from the picture asked (POC delta " +
                        std::to_string(wanted) + ")";
                return false;
            }
            if (f.shortTerm.size() != plan.references.size()) {
                error = "the driver's slice keeps " + std::to_string(f.shortTerm.size()) +
                        " pictures, not " + std::to_string(plan.references.size());
                return false;
            }
        }
        ++slices;
    }
    if (slices == 0) {
        error = "no slice in the driver's output";
        return false;
    }
    return true;
}

int VulkanHevcEncoder::reportedQp(const uint8_t* slices, size_t size)
{
    // The slice's QP counts once it has left the PPS's: until then the
    // driver may simply not say it there (VideoEncode12's rule).
    const int qp = firstSliceQp(slices, size, m_SpsFields, m_PpsFields);
    if (qp >= 0 && qp != m_PpsFields.initQp) m_SliceQpMoves = true;
    return m_SliceQpMoves ? qp : -1;
}

bool VulkanHevcEncoder::encode(bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                               std::string& error)
{
    if (!d->session) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_Failed) {
        error = "the Vulkan encoder was given up";
        return false;
    }
    if (m_OutputHeld) {
        error = "the previous frame was not released";
        return false;
    }
    const HevcDpb::Plan plan = m_Dpb.plan(frameNumber, forceKeyframe);
    // Its step in a sweep: from the previous picture a sweep goes on, from an
    // older one (a repair) it starts over — IntraRefreshSweep.
    const bool followsPrevious =
        !plan.idr && !plan.references.empty() && plan.references[0].poc + 1 == plan.poc;
    m_Step = m_Sweep.next(plan.idr, followsPrevious);
    uint32_t offset = 0, bytes = 0;
    if (!submit(plan, offset, bytes, error)) return false;
    uint8_t* slices = d->bitstreamCpu + d->sliceOffset + offset;
    if (m_GuardLeft > 0) {
        if (!guard(slices, bytes, plan, error)) {
            m_Failed = true;
            return false;
        }
        --m_GuardLeft;
    }
    m_Dpb.encoded(plan);

    // RADV's CBR pads a short picture up to its budget with filler units,
    // after the slices: bytes for nothing on the link, taken out while the
    // buffer is still ours (stripHevcFiller).
    const size_t kept = stripHevcFiller(slices, bytes);
    if (kept != bytes) {
        if (m_FillerPictures == 0)
            log::info("[native] Vulkan Video: the driver pads its pictures with filler data, "
                      "stripped before the link (" +
                      std::to_string(bytes - kept) + " of the first one's " +
                      std::to_string(bytes) + " bytes)");
        m_FillerBytes += bytes - kept;
        ++m_FillerPictures;
        bytes = static_cast<uint32_t>(kept);
    }

    out = EncoderOutput{};
    if (plan.idr && offset == 0) {
        out.data = slices - m_Headers.size();
        out.size = bytes + m_Headers.size();
    } else if (plan.idr) {
        d->scratch.assign(m_Headers.begin(), m_Headers.end());
        d->scratch.insert(d->scratch.end(), slices, slices + bytes);
        out.data = d->scratch.data();
        out.size = d->scratch.size();
    } else {
        out.data = slices;
        out.size = bytes;
    }
    out.keyframe = plan.idr;
    out.avgQp = d->constantQp ? m_Witness.constantQp : reportedQp(slices, bytes);
    m_OutputHeld = true;
    return true;
}

bool VulkanHevcEncoder::invalidateReference(uint32_t frameNumber, std::string& error)
{
    if (!d->session) {
        error = "the encoder is not initialized";
        return false;
    }
    if (!m_Dpb.invalidate(frameNumber)) {
        error = "no picture from before frame " + std::to_string(frameNumber) +
                " is kept: a keyframe is the only repair";
        return false;
    }
    return true;
}

bool VulkanHevcEncoder::setBitrate(int bitrateKbps, std::string& error)
{
    if (!d->session) {
        error = "the encoder is not initialized";
        return false;
    }
    if (d->constantQp) return true;
    m_BitrateKbps = std::max(bitrateKbps, 1);
    // The state the next picture's control sets; the one in force stays
    // what every begin says until that control has run.
    d->rate[1 - d->current].set(false, static_cast<uint32_t>(m_BitrateKbps) * 1000u, m_Fps,
                                m_VbvFrames);
    m_RateChanged = true;
    return true;
}

std::string VulkanHevcEncoder::describe() const
{
    return "Vulkan Video (HEVC, transform depth " + std::to_string(m_TransformDepth) + ")";
}

void VulkanHevcEncoder::stop()
{
    if (m_FillerPictures > 0)
        log::info("[native] Vulkan Video: " + std::to_string(m_FillerBytes / 1024) +
                  " KB of filler stripped from " + std::to_string(m_FillerPictures) + " pictures");
    if (d && d->device) {
        const vulkan::DeviceFunctions& fn = *d->fn;
        VkDevice dev = d->dev;
        if (fn.vkDeviceWaitIdle) fn.vkDeviceWaitIdle(dev);
        if (d->feedback) fn.vkDestroyQueryPool(dev, d->feedback, nullptr);
        if (d->encodePool) fn.vkDestroyCommandPool(dev, d->encodePool, nullptr);
        if (d->uploadPool) fn.vkDestroyCommandPool(dev, d->uploadPool, nullptr);
        if (d->parameters) fn.vkDestroyVideoSessionParametersKHR(dev, d->parameters, nullptr);
        if (d->session) fn.vkDestroyVideoSessionKHR(dev, d->session, nullptr);
        for (VkDeviceMemory m : d->sessionMemory)
            fn.vkFreeMemory(dev, m, nullptr);
        for (VkImageView v : {d->inputView, d->lumaView, d->chromaView, d->dpbView})
            if (v) fn.vkDestroyImageView(dev, v, nullptr);
        for (VkImage i : {d->input, d->dpb})
            if (i) fn.vkDestroyImage(dev, i, nullptr);
        for (VkBuffer b : {d->bitstream, d->staging})
            if (b) fn.vkDestroyBuffer(dev, b, nullptr);
        for (VkDeviceMemory m :
             {d->inputMemory, d->dpbMemory, d->bitstreamMemory, d->stagingMemory})
            if (m) fn.vkFreeMemory(dev, m, nullptr);
    }
    d = std::make_unique<Impl>();
    m_Input = VulkanPicture{};
    m_Dpb.reset();
    m_Sweep = IntraRefreshSweep();
    m_Step = IntraRefreshSweep::Step{};
    m_Headers.clear();
    m_SpsFields = HevcSpsFields{};
    m_PpsFields = HevcPpsFields{};
    m_GuardLeft = 0;
    m_SliceQpMoves = false;
    m_RateChanged = false;
    m_FirstPicture = true;
    m_OutputHeld = false;
    m_Failed = false;
    m_TransformDepth = 0;
    m_FillerBytes = 0;
    m_FillerPictures = 0;
}

} // namespace mw::native::encode
