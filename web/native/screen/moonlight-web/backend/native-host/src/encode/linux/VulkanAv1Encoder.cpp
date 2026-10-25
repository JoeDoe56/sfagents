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

#include "VulkanAv1Encoder.h"

#include "../../core/Log.h"
#include "../../platform/linux/vulkan/VulkanDevice.h"
#include "../../core/Selector.h"
#include "../Av1EncodeNegotiation.h"
#include "../RateControl.h"

#include <algorithm>
#include <cstring>

namespace mw::native::encode {

using vulkan::resultText;

namespace {

/// Pictures whose frame headers are read back against what was asked: the
/// warm-up key frame and the pictures after it (the HEVC chain's rule).
constexpr int kGuardedPictures = 6;

/// Room in front of the driver's bytes for a temporal delimiter and the
/// sequence header: a few dozen bytes.
constexpr VkDeviceSize kHeaderRoom = 4096;

/// The engine's quantizer floor in AV1's qindex: HEVC's QP 18 × 255 / 51, the
/// D3D12 chain's (VideoEncodeCaps12.cpp) — below it a still picture spends
/// bits on noise the eye cannot see.
constexpr uint32_t kMinQIndex = 90;

/// An AV1 encoder's order hints: 8 bits, which a reach of 125 ms never wraps.
constexpr int kOrderHintBits = 8;

/// ⚠️ VBR with its peak at the target, never CBR. RADV's CBR asks the firmware
/// to pad every picture up to its budget (enabled_filler_data, which it sets
/// for every codec), and in AV1 the 780M's VCN 4.0.2 never comes back from
/// the first picture: the ring times out after 22 s and the kernel resets it
/// (Mesa 26.2.3, firmware ENC 1.24, Linux 7.0, 04/10/2026 — eight times out
/// of eight, with or without q-index bounds). The firmware's VBR with a peak equal
/// to the average is that same budget without the padding — which the HEVC
/// chain strips anyway (stripHevcFiller).
constexpr VkVideoEncodeRateControlModeFlagBitsKHR kRateMode =
    VK_VIDEO_ENCODE_RATE_CONTROL_MODE_VBR_BIT_KHR;

uint32_t alignUp(uint32_t v, uint32_t a)
{
    return a > 1 ? (v + a - 1) / a * a : v;
}

VkDeviceSize alignUp(VkDeviceSize v, VkDeviceSize a)
{
    return a > 1 ? (v + a - 1) / a * a : v;
}

/// AV1 Main, 4:2:0, 8 bits, for a stream: the chain every call names.
struct Profile
{
    VkVideoEncodeUsageInfoKHR usage = {};
    VkVideoEncodeAV1ProfileInfoKHR av1 = {};
    VkVideoProfileInfoKHR info = {};
    VkVideoProfileListInfoKHR list = {};

    Profile()
    {
        usage.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_USAGE_INFO_KHR;
        usage.videoUsageHints = VK_VIDEO_ENCODE_USAGE_STREAMING_BIT_KHR;
        usage.videoContentHints =
            VK_VIDEO_ENCODE_CONTENT_DESKTOP_BIT_KHR | VK_VIDEO_ENCODE_CONTENT_RENDERED_BIT_KHR;
        usage.tuningMode = VK_VIDEO_ENCODE_TUNING_MODE_ULTRA_LOW_LATENCY_KHR;
        av1.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_PROFILE_INFO_KHR;
        av1.pNext = &usage;
        av1.stdProfile = STD_VIDEO_AV1_PROFILE_MAIN;
        info.sType = VK_STRUCTURE_TYPE_VIDEO_PROFILE_INFO_KHR;
        info.pNext = &av1;
        info.videoCodecOperation = VK_VIDEO_CODEC_OPERATION_ENCODE_AV1_BIT_KHR;
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

/// A rate control state, built in place: what a control command sets and
/// every vkCmdBeginVideoCodingKHR after it says again.
struct Rate
{
    VkVideoEncodeAV1RateControlLayerInfoKHR av1Layer = {};
    VkVideoEncodeRateControlLayerInfoKHR layer = {};
    VkVideoEncodeAV1RateControlInfoKHR av1 = {};
    VkVideoEncodeRateControlInfoKHR info = {};

    Rate() = default;
    Rate(const Rate&) = delete;
    Rate& operator=(const Rate&) = delete;

    void set(bool constantQp, uint32_t bitsPerSecond, int fps, int vbvFrames, uint32_t minQIndex,
             uint32_t maxQIndex)
    {
        av1 = {};
        av1.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_RATE_CONTROL_INFO_KHR;
        // One key frame, then inter frames for ever, one layer: no GOP.
        av1.temporalLayerCount = 1;
        info = {};
        info.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_RATE_CONTROL_INFO_KHR;
        info.pNext = &av1;
        if (constantQp) {
            info.rateControlMode = VK_VIDEO_ENCODE_RATE_CONTROL_MODE_DISABLED_BIT_KHR;
            return;
        }
        av1Layer = {};
        av1Layer.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_RATE_CONTROL_LAYER_INFO_KHR;
        av1Layer.useMinQIndex = VK_TRUE;
        av1Layer.minQIndex = {minQIndex, minQIndex, minQIndex};
        av1Layer.useMaxQIndex = VK_TRUE;
        av1Layer.maxQIndex = {maxQIndex, maxQIndex, maxQIndex};
        // No maxFrameSize: RADV hands the firmware bytes where it reads bits
        // (a cap of one VBV in bytes held a 1080p key frame to an eighth of
        // it, 04/10/2026).
        layer = {};
        layer.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_RATE_CONTROL_LAYER_INFO_KHR;
        layer.pNext = &av1Layer;
        layer.averageBitrate = bitsPerSecond;
        layer.maxBitrate = bitsPerSecond;
        layer.frameRateNumerator = static_cast<uint32_t>(fps);
        layer.frameRateDenominator = 1;
        info.rateControlMode = kRateMode;
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

/// The number of bits for @p value, at least one: frame_width_bits_minus_1 + 1.
uint8_t bitsFor(uint32_t value)
{
    uint8_t n = 1;
    while (n < 32 && (value >> n) != 0)
        ++n;
    return n;
}

} // namespace

struct VulkanAv1Encoder::Impl
{
    std::shared_ptr<vulkan::VulkanDevice> device;
    const vulkan::DeviceFunctions* fn = nullptr;
    VkDevice dev = VK_NULL_HANDLE;
    Profile profile;

    VkVideoEncodeAV1CapabilitiesKHR av1Caps = {};
    VkVideoEncodeCapabilitiesKHR encodeCaps = {};
    VkVideoCapabilitiesKHR caps = {};
    VkVideoEncodeIntraRefreshCapabilitiesKHR refreshCaps = {};
    VkVideoEncodeIntraRefreshModeFlagBitsKHR refreshMode =
        VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_NONE_KHR;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    uint32_t allocWidth = 0;
    uint32_t allocHeight = 0;
    bool sb128 = false;
    int levelIdx = 8;
    uint32_t minQIndex = kMinQIndex;
    uint32_t maxQIndex = 255;
    bool constantQp = false;
    /// The reference name single-reference prediction goes through: LAST
    /// where the driver takes it.
    int referenceName = 0;

    VkImage input = VK_NULL_HANDLE;
    VkDeviceMemory inputMemory = VK_NULL_HANDLE;
    VkImageView inputView = VK_NULL_HANDLE;
    VkImageView lumaView = VK_NULL_HANDLE;
    VkImageView chromaView = VK_NULL_HANDLE;
    bool inputTouched = false;

    VkImage dpb = VK_NULL_HANDLE;
    VkDeviceMemory dpbMemory = VK_NULL_HANDLE;
    VkImageView dpbView = VK_NULL_HANDLE;
    uint32_t dpbLayers = 0;
    bool dpbTouched = false;

    // The bitstream: room for the headers, then the driver's bytes from
    // dataOffset.
    VkBuffer bitstream = VK_NULL_HANDLE;
    VkDeviceMemory bitstreamMemory = VK_NULL_HANDLE;
    uint8_t* bitstreamCpu = nullptr;
    VkDeviceSize bitstreamSize = 0;
    VkDeviceSize dataOffset = 0;

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

VulkanAv1Encoder::VulkanAv1Encoder()
    : d(std::make_unique<Impl>())
{}

VulkanAv1Encoder::~VulkanAv1Encoder()
{
    stop();
}

bool VulkanAv1Encoder::init(const std::shared_ptr<vulkan::VulkanDevice>& device, Codec codec,
                            int width, int height, int fps, int bitrateKbps, bool intraRefresh,
                            const EncoderTuning& tuning, std::string& error, const Witness& witness)
{
    stop();
    if (codec != Codec::Av1) {
        error = std::string("the Vulkan AV1 encoder does not encode ") + toString(codec);
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
    d->av1Caps.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_CAPABILITIES_KHR;
    d->encodeCaps.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_CAPABILITIES_KHR;
    d->encodeCaps.pNext = &d->av1Caps;
    d->caps.sType = VK_STRUCTURE_TYPE_VIDEO_CAPABILITIES_KHR;
    d->caps.pNext = &d->encodeCaps;
    if (intraRefresh && device->encodesIntraRefresh()) {
        d->refreshCaps.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_INTRA_REFRESH_CAPABILITIES_KHR;
        d->av1Caps.pNext = &d->refreshCaps;
    }
    VkResult r = device->videoCapabilities(d->profile.info, d->caps);
    if (r != VK_SUCCESS) {
        error =
            device->name() + " encodes no AV1 Main through Vulkan Video (" + resultText(r) + ")";
        stop();
        return false;
    }
    const VkVideoEncodeRateControlModeFlagBitsKHR mode =
        d->constantQp ? VK_VIDEO_ENCODE_RATE_CONTROL_MODE_DISABLED_BIT_KHR : kRateMode;
    if (!(d->encodeCaps.rateControlModes & mode)) {
        error = std::string("the driver's Vulkan AV1 encoder has no ") +
                (d->constantQp ? "constant quantizer" : "VBR");
        stop();
        return false;
    }
    if (d->caps.maxActiveReferencePictures < 1 || d->av1Caps.maxSingleReferenceCount < 1 ||
        d->av1Caps.singleReferenceNameMask == 0) {
        error = "the driver's Vulkan AV1 encoder predicts from no picture";
        stop();
        return false;
    }
    // LAST, or the first name the driver lets a single reference go through.
    d->referenceName = 0;
    while (d->referenceName < av1::kRefsPerFrame &&
           !(d->av1Caps.singleReferenceNameMask & (1u << d->referenceName)))
        ++d->referenceName;
    // The superblock: 64, the smaller, where the driver has it — one tile
    // holds 4K either way.
    d->sb128 = !(d->av1Caps.superblockSizes & VK_VIDEO_ENCODE_AV1_SUPERBLOCK_SIZE_64_BIT_KHR);
    // ⚠️ The picture on the driver's grid, the same shape, never a frame
    // padded past it: a padded frame says the picture in AV1's render size,
    // and Chrome — software and hardware decoders alike — shows the whole
    // frame, padding included (1920x1088 for 1080p on the 780M, 05/10/2026).
    // The conversion scales to the size kept here; the session says it.
    // A viewer that cuts the frame to that size (setClientCrops) is sent the
    // padded frame instead, the picture whole at its own size.
    if (m_ClientCrops) {
        d->codedWidth = alignUp(static_cast<uint32_t>(width),
                                std::max(d->av1Caps.codedPictureAlignment.width, 1u));
        d->codedHeight = alignUp(static_cast<uint32_t>(height),
                                 std::max(d->av1Caps.codedPictureAlignment.height, 1u));
        d->codedWidth += d->codedWidth & 1;
        d->codedHeight += d->codedHeight & 1;
    } else {
        const int gw = static_cast<int>(std::max(d->av1Caps.codedPictureAlignment.width, 2u));
        const int gh = static_cast<int>(std::max(d->av1Caps.codedPictureAlignment.height, 2u));
        const FrameSize grid = alignedToGrid(FrameSize{width, height}, gw, gh);
        if (grid.width != width || grid.height != height)
            log::info("[native] Vulkan Video AV1: " + std::to_string(width) + "x" +
                      std::to_string(height) + " is off the driver's " + std::to_string(gw) + "x" +
                      std::to_string(gh) + " grid — encoding " + std::to_string(grid.width) + "x" +
                      std::to_string(grid.height) +
                      ", the same shape (a browser shows an AV1 frame whole, never its render "
                      "size)");
        m_Width = width = grid.width & ~1;
        m_Height = height = grid.height & ~1;
        d->codedWidth = static_cast<uint32_t>(width);
        d->codedHeight = static_cast<uint32_t>(height);
    }
    if (d->codedWidth < d->caps.minCodedExtent.width ||
        d->codedHeight < d->caps.minCodedExtent.height ||
        d->codedWidth > d->caps.maxCodedExtent.width ||
        d->codedHeight > d->caps.maxCodedExtent.height) {
        error = std::to_string(d->codedWidth) + "x" + std::to_string(d->codedHeight) +
                " is outside what the Vulkan AV1 encoder takes (" +
                std::to_string(d->caps.minCodedExtent.width) + "x" +
                std::to_string(d->caps.minCodedExtent.height) + " to " +
                std::to_string(d->caps.maxCodedExtent.width) + "x" +
                std::to_string(d->caps.maxCodedExtent.height) + ")";
        stop();
        return false;
    }
    d->allocWidth = alignUp(d->codedWidth, std::max(d->caps.pictureAccessGranularity.width, 1u));
    d->allocHeight = alignUp(d->codedHeight, std::max(d->caps.pictureAccessGranularity.height, 1u));
    d->levelIdx = std::min(av1LevelIdx(d->codedWidth, d->codedHeight, m_Fps),
                           static_cast<int>(d->av1Caps.maxLevel));
    d->minQIndex = std::clamp(kMinQIndex, d->av1Caps.minQIndex, d->av1Caps.maxQIndex);
    d->maxQIndex = std::max(d->minQIndex, std::min<uint32_t>(255, d->av1Caps.maxQIndex));

    // Pictures kept: the default (4), within the driver's slots — the one
    // being coded needs its own — and AV1's eight reference slots, which a
    // picture of the pool maps onto one to one.
    const int wanted = tuning.dpbFrames > 0 ? tuning.dpbFrames : 4;
    const int slots = static_cast<int>(std::max<uint32_t>(d->caps.maxDpbSlots, 2)) - 1;
    m_Dpb =
        HevcDpb(std::clamp(wanted, 1, std::max(1, std::min(slots, av1::kNumRefFrames - 1))), m_Fps);
    d->dpbLayers = static_cast<uint32_t>(m_Dpb.textures());

    // ── Intra refresh, as in HEVC (C13.9) ──
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
            noRefresh = "the driver sweeps AV1 by none of columns, rows or blocks";
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
        noRefresh = "the driver refused a session with it (" + error + ")";
        m_Sweep = IntraRefreshSweep();
        d->refreshMode = VK_VIDEO_ENCODE_INTRA_REFRESH_MODE_NONE_KHR;
        error.clear();
        createSession(error);
    }
    if (!d->session || !d->parameters || !readSequenceHeader(error)) {
        if (error.empty()) error = "the Vulkan video session did not come up";
        stop();
        return false;
    }

    // The first encode, on a black picture: paid here, read by the guard,
    // and the rows and columns past the visible picture blackened for good.
    m_FirstPicture = true;
    m_GuardLeft = kGuardedPictures;
    m_Step = IntraRefreshSweep::Step{};
    EncoderOutput warm;
    if (!upload(nullptr, error) || !encode(true, 0, warm, error)) {
        error = "the Vulkan AV1 encoder's first picture: " + error;
        stop();
        return false;
    }
    m_OutputHeld = false;
    // The stream's own first picture is a key frame again: the bookkeeping
    // starts over, the warm-up having filled nothing a receiver saw.
    m_Dpb.reset();

    m_Input.image = d->input;
    m_Input.luma = d->lumaView;
    m_Input.chroma = d->chromaView;
    m_Input.width = m_Width;
    m_Input.height = m_Height;
    m_Input.codedWidth = static_cast<int>(d->codedWidth);
    m_Input.codedHeight = static_cast<int>(d->codedHeight);

    log::info("[native] Vulkan Video encoder ready on " + device->name() + ": AV1 Main " +
              std::to_string(width) + "x" + std::to_string(height) + " coded " +
              std::to_string(d->codedWidth) + "x" + std::to_string(d->codedHeight) + "@" +
              std::to_string(m_Fps) + ", " +
              (d->constantQp ? "constant qindex " + std::to_string(witness.constantQp)
                             : "VBR peaking at its " + std::to_string(m_BitrateKbps) +
                                   " kbps (no padding), qindex " + std::to_string(d->minQIndex) +
                                   "-" + std::to_string(d->maxQIndex)) +
              ", level " + std::to_string(2 + m_Sequence.levelIdx / 4) + "." +
              std::to_string(m_Sequence.levelIdx % 4) + ", superblock " +
              (m_Sequence.sb128 ? "128" : "64") + (m_Sequence.cdef ? ", CDEF" : "") +
              (m_Sequence.restoration ? ", loop restoration" : "") + ", " +
              std::to_string(m_Dpb.capacity()) + " pictures kept (reach " +
              std::to_string(m_Dpb.reachFrames()) + " frames), " + refreshText(noRefresh) + ", " +
              std::to_string(m_SequenceObu.size()) + " bytes of sequence header from the driver");
    return true;
}

std::string VulkanAv1Encoder::refreshText(const std::string& noRefresh) const
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

bool VulkanAv1Encoder::createResources(std::string& error)
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
            error = "the Vulkan AV1 encoder's input cannot be written by a compute shader here (" +
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
        error = "the Vulkan AV1 encoder's input picture: " + resultText(r);
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
        error = "the Vulkan AV1 encoder's input views: " + resultText(r);
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
        error = "the Vulkan AV1 encoder's reconstructed pictures: " + resultText(r);
        return false;
    }

    // ── The bitstream, read in place by the CPU: cached memory if there is ──
    const VkMemoryPropertyFlags visible =
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    d->dataOffset =
        alignUp(kHeaderRoom, std::max<VkDeviceSize>(d->caps.minBitstreamBufferOffsetAlignment, 1));
    const VkDeviceSize worst =
        static_cast<VkDeviceSize>(d->codedWidth) * d->codedHeight * 3 / 2 + 65536;
    d->bitstreamSize = alignUp(d->dataOffset + worst,
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
        error = "the Vulkan AV1 encoder's bitstream buffer: " + resultText(r);
        return false;
    }

    // ── The CPU's pictures (upload()) ──
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
        error = "the Vulkan AV1 encoder's upload buffer: " + resultText(r);
        return false;
    }
    const size_t lumaBytes = static_cast<size_t>(d->codedWidth) * d->codedHeight;
    std::memset(d->stagingCpu, 16, lumaBytes);
    std::memset(d->stagingCpu + lumaBytes, 128, lumaBytes / 2);

    // ── Commands, and the feedback that says where the picture landed ──
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
        error = "the Vulkan AV1 encoder's commands: " + resultText(r);
        return false;
    }
    return true;
}

bool VulkanAv1Encoder::createSession(std::string& error)
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
    // The level the stream needs, said to the session.
    VkVideoEncodeAV1SessionCreateInfoKHR av1 = {};
    av1.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_SESSION_CREATE_INFO_KHR;
    av1.useMaxLevel = VK_TRUE;
    av1.maxLevel = static_cast<StdVideoAV1Level>(d->levelIdx);
    sci.pNext = &av1;
    VkVideoEncodeSessionIntraRefreshCreateInfoKHR refresh = {};
    if (m_Sweep.enabled()) {
        refresh.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_SESSION_INTRA_REFRESH_CREATE_INFO_KHR;
        refresh.intraRefreshMode = d->refreshMode;
        av1.pNext = &refresh;
    }
    VkResult r = fn.vkCreateVideoSessionKHR(dev, &sci, nullptr, &d->session);
    if (r != VK_SUCCESS) {
        d->session = VK_NULL_HANDLE;
        error = "the Vulkan AV1 video session: " + resultText(r);
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
            error = "the Vulkan AV1 video session's memory: " + resultText(r);
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

    // ── Our sequence header, as a StdVideo structure ──
    // What Av1Obu.h reads and the browsers decode: order hints, CDEF, no
    // screen content tools, no frame ids, no timing, BT.709 limited.
    StdVideoAV1ColorConfig color = {};
    color.flags.color_description_present_flag = 1;
    color.BitDepth = 8;
    color.subsampling_x = 1;
    color.subsampling_y = 1;
    color.color_primaries = STD_VIDEO_AV1_COLOR_PRIMARIES_BT_709;
    color.transfer_characteristics = STD_VIDEO_AV1_TRANSFER_CHARACTERISTICS_BT_709;
    color.matrix_coefficients = STD_VIDEO_AV1_MATRIX_COEFFICIENTS_BT_709;
    color.chroma_sample_position = STD_VIDEO_AV1_CHROMA_SAMPLE_POSITION_UNKNOWN;
    StdVideoAV1SequenceHeader seq = {};
    seq.flags.use_128x128_superblock = d->sb128 ? 1 : 0;
    seq.flags.enable_order_hint = 1;
    seq.flags.enable_cdef = 1;
    seq.seq_profile = STD_VIDEO_AV1_PROFILE_MAIN;
    seq.frame_width_bits_minus_1 = static_cast<uint8_t>(bitsFor(d->codedWidth - 1) - 1);
    seq.frame_height_bits_minus_1 = static_cast<uint8_t>(bitsFor(d->codedHeight - 1) - 1);
    seq.max_frame_width_minus_1 = static_cast<uint16_t>(d->codedWidth - 1);
    seq.max_frame_height_minus_1 = static_cast<uint16_t>(d->codedHeight - 1);
    seq.order_hint_bits_minus_1 = kOrderHintBits - 1;
    seq.seq_force_integer_mv = STD_VIDEO_AV1_SELECT_INTEGER_MV;
    seq.seq_force_screen_content_tools = 0;
    seq.pColorConfig = &color;
    StdVideoEncodeAV1OperatingPointInfo point = {};
    point.seq_level_idx = static_cast<uint8_t>(d->levelIdx);
    VkVideoEncodeQualityLevelInfoKHR quality = {};
    quality.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_QUALITY_LEVEL_INFO_KHR;
    quality.qualityLevel = 0;
    VkVideoEncodeAV1SessionParametersCreateInfoKHR av1p = {};
    av1p.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_SESSION_PARAMETERS_CREATE_INFO_KHR;
    av1p.pNext = &quality;
    av1p.pStdSequenceHeader = &seq;
    av1p.stdOperatingPointCount = 1;
    av1p.pStdOperatingPoints = &point;
    VkVideoSessionParametersCreateInfoKHR pci = {};
    pci.sType = VK_STRUCTURE_TYPE_VIDEO_SESSION_PARAMETERS_CREATE_INFO_KHR;
    pci.pNext = &av1p;
    pci.videoSession = d->session;
    r = fn.vkCreateVideoSessionParametersKHR(dev, &pci, nullptr, &d->parameters);
    if (r != VK_SUCCESS) {
        d->parameters = VK_NULL_HANDLE;
        error = "the driver refuses our AV1 sequence header: " + resultText(r);
        return false;
    }
    const uint32_t bitsPerSecond = static_cast<uint32_t>(m_BitrateKbps) * 1000u;
    d->rate[0].set(d->constantQp, bitsPerSecond, m_Fps, m_VbvFrames, d->minQIndex, d->maxQIndex);
    d->current = 0;
    return true;
}

bool VulkanAv1Encoder::readSequenceHeader(std::string& error)
{
    const vulkan::DeviceFunctions& fn = *d->fn;
    VkVideoEncodeSessionParametersGetInfoKHR get = {};
    get.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_SESSION_PARAMETERS_GET_INFO_KHR;
    get.videoSessionParameters = d->parameters;
    VkVideoEncodeSessionParametersFeedbackInfoKHR feedback = {};
    feedback.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_SESSION_PARAMETERS_FEEDBACK_INFO_KHR;
    size_t size = 0;
    VkResult r = fn.vkGetEncodedVideoSessionParametersKHR(d->dev, &get, &feedback, &size, nullptr);
    if (r == VK_SUCCESS && size > 0) {
        m_SequenceObu.resize(size);
        r = fn.vkGetEncodedVideoSessionParametersKHR(d->dev, &get, &feedback, &size,
                                                     m_SequenceObu.data());
        m_SequenceObu.resize(size);
    }
    if (r != VK_SUCCESS || m_SequenceObu.empty() || m_SequenceObu.size() + 16 > kHeaderRoom) {
        error =
            "the driver writes no AV1 sequence header (" +
            (r == VK_SUCCESS ? std::to_string(m_SequenceObu.size()) + " bytes" : resultText(r)) +
            ")";
        return false;
    }
    // Read back: the frames are judged with what the driver stands by.
    const std::vector<av1::Obu> units = av1::obus(m_SequenceObu.data(), m_SequenceObu.size());
    if (units.size() != 1 || units[0].type != av1::ObuType::SequenceHeader) {
        error = "the driver's AV1 parameters are not one sequence header OBU (" +
                std::to_string(units.size()) + " OBUs in " + std::to_string(m_SequenceObu.size()) +
                " bytes)";
        return false;
    }
    const std::string unread =
        av1::parseSequenceHeader(units[0].payload, units[0].size, m_Sequence);
    if (!unread.empty()) {
        error = "the driver's AV1 sequence header does not read here: " + unread;
        return false;
    }
    if (m_Sequence.width != d->codedWidth || m_Sequence.height != d->codedHeight ||
        m_Sequence.orderHintBits != kOrderHintBits) {
        error = "the driver's AV1 sequence header says " + std::to_string(m_Sequence.width) + "x" +
                std::to_string(m_Sequence.height) + " with " +
                std::to_string(m_Sequence.orderHintBits) + "-bit order hints, not " +
                std::to_string(d->codedWidth) + "x" + std::to_string(d->codedHeight) + " with " +
                std::to_string(kOrderHintBits);
        return false;
    }
    if (feedback.hasOverrides)
        log::info("[native] Vulkan Video: the driver rewrites our AV1 sequence header, and it is "
                  "what goes out");
    return true;
}

bool VulkanAv1Encoder::upload(const uint8_t* nv12, std::string& error)
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
    const VkSemaphoreSubmitInfo wait = d->device->afterLast(VK_PIPELINE_STAGE_2_COPY_BIT);
    std::string why;
    if (!d->device->run(cmd, wait.semaphore ? &wait : nullptr, wait.semaphore ? 1u : 0u, why)) {
        m_Failed = true;
        error = "the picture did not reach the Vulkan AV1 encoder: " + why;
        return false;
    }
    d->inputTouched = true;
    return true;
}

bool VulkanAv1Encoder::submit(const HevcDpb::Plan& plan, uint32_t& offset, uint32_t& bytes,
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

    // Every picture kept, the used one first; then the layer this picture is
    // reconstructed into, not yet a reference.
    const size_t kept = plan.idr ? 0 : plan.references.size();
    std::vector<VkVideoPictureResourceInfoKHR> resources(d->dpbLayers);
    for (uint32_t s = 0; s < d->dpbLayers; ++s) {
        resources[s] = {};
        resources[s].sType = VK_STRUCTURE_TYPE_VIDEO_PICTURE_RESOURCE_INFO_KHR;
        resources[s].codedExtent = {d->codedWidth, d->codedHeight};
        resources[s].baseArrayLayer = s;
        resources[s].imageViewBinding = d->dpbView;
    }
    std::vector<StdVideoEncodeAV1ReferenceInfo> refStd(kept);
    std::vector<VkVideoEncodeAV1DpbSlotInfoKHR> refDpb(kept);
    std::vector<VkVideoReferenceSlotInfoKHR> beginSlots;
    for (size_t k = 0; k < kept; ++k) {
        const HevcDpb::Reference& ref = plan.references[k];
        refStd[k] = {};
        refStd[k].frame_type =
            ref.poc == 0 ? STD_VIDEO_AV1_FRAME_TYPE_KEY : STD_VIDEO_AV1_FRAME_TYPE_INTER;
        refStd[k].OrderHint = static_cast<uint8_t>(ref.poc);
        refDpb[k] = {};
        refDpb[k].sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_DPB_SLOT_INFO_KHR;
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

    // ── The frame ──
    // A key frame refreshes the eight slots; an inter frame the slot of its
    // texture, and all seven names point at the picture it predicts from.
    const int used = plan.idr ? -1 : plan.references[0].texture;
    StdVideoAV1Quantization quantization = {};
    quantization.base_q_idx =
        static_cast<uint8_t>(d->constantQp ? std::clamp(m_Witness.constantQp, 1, 255) : 128);
    StdVideoEncodeAV1PictureInfo picture = {};
    picture.flags.error_resilient_mode = plan.idr ? 1 : 0;
    picture.flags.show_frame = 1;
    picture.flags.is_filter_switchable = 1;
    picture.flags.render_and_frame_size_different =
        d->codedWidth != static_cast<uint32_t>(m_Width) ||
        d->codedHeight != static_cast<uint32_t>(m_Height);
    picture.frame_type = plan.idr ? STD_VIDEO_AV1_FRAME_TYPE_KEY : STD_VIDEO_AV1_FRAME_TYPE_INTER;
    picture.order_hint = static_cast<uint8_t>(plan.poc);
    picture.primary_ref_frame =
        plan.idr ? STD_VIDEO_AV1_PRIMARY_REF_NONE : static_cast<uint8_t>(d->referenceName);
    picture.refresh_frame_flags = plan.idr ? 0xFF : static_cast<uint8_t>(1u << plan.texture);
    picture.render_width_minus_1 = static_cast<uint16_t>(m_Width - 1);
    picture.render_height_minus_1 = static_cast<uint16_t>(m_Height - 1);
    picture.interpolation_filter = STD_VIDEO_AV1_INTERPOLATION_FILTER_SWITCHABLE;
    picture.TxMode = STD_VIDEO_AV1_TX_MODE_SELECT;
    for (int i = 0; i < av1::kNumRefFrames; ++i)
        picture.ref_order_hint[i] = plan.idr ? 0 : m_SlotHint[static_cast<size_t>(i)];
    for (int i = 0; i < av1::kRefsPerFrame; ++i)
        picture.ref_frame_idx[i] = static_cast<int8_t>(plan.idr ? 0 : used);
    picture.pQuantization = &quantization;
    VkVideoEncodeAV1PictureInfoKHR av1Picture = {};
    av1Picture.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_PICTURE_INFO_KHR;
    av1Picture.predictionMode = plan.idr ? VK_VIDEO_ENCODE_AV1_PREDICTION_MODE_INTRA_ONLY_KHR
                                         : VK_VIDEO_ENCODE_AV1_PREDICTION_MODE_SINGLE_REFERENCE_KHR;
    av1Picture.rateControlGroup = plan.idr ? VK_VIDEO_ENCODE_AV1_RATE_CONTROL_GROUP_INTRA_KHR
                                           : VK_VIDEO_ENCODE_AV1_RATE_CONTROL_GROUP_PREDICTIVE_KHR;
    av1Picture.constantQIndex =
        d->constantQp ? static_cast<uint32_t>(std::clamp(m_Witness.constantQp, 1, 255)) : 0;
    av1Picture.pStdPictureInfo = &picture;
    for (uint32_t i = 0; i < VK_MAX_VIDEO_AV1_REFERENCES_PER_FRAME_KHR; ++i)
        av1Picture.referenceNameSlotIndices[i] = -1;
    if (!plan.idr) av1Picture.referenceNameSlotIndices[d->referenceName] = used;

    StdVideoEncodeAV1ReferenceInfo setupStd = {};
    setupStd.frame_type = picture.frame_type;
    setupStd.OrderHint = picture.order_hint;
    VkVideoEncodeAV1DpbSlotInfoKHR setupDpb = {};
    setupDpb.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_DPB_SLOT_INFO_KHR;
    setupDpb.pStdReferenceInfo = &setupStd;
    VkVideoReferenceSlotInfoKHR setupSlot = {};
    setupSlot.sType = VK_STRUCTURE_TYPE_VIDEO_REFERENCE_SLOT_INFO_KHR;
    setupSlot.pNext = &setupDpb;
    setupSlot.slotIndex = plan.texture;
    setupSlot.pPictureResource = &resources[static_cast<size_t>(plan.texture)];

    VkVideoEncodeInfoKHR info = {};
    info.sType = VK_STRUCTURE_TYPE_VIDEO_ENCODE_INFO_KHR;
    info.pNext = &av1Picture;
    info.dstBuffer = d->bitstream;
    info.dstBufferOffset = d->dataOffset;
    info.dstBufferRange = d->bitstreamSize - d->dataOffset;
    info.srcPictureResource.sType = VK_STRUCTURE_TYPE_VIDEO_PICTURE_RESOURCE_INFO_KHR;
    info.srcPictureResource.codedExtent = {d->codedWidth, d->codedHeight};
    info.srcPictureResource.imageViewBinding = d->inputView;
    info.pSetupReferenceSlot = &setupSlot;
    info.referenceSlotCount = plan.idr ? 0 : 1;
    info.pReferenceSlots = plan.idr ? nullptr : &beginSlots[0];
    // A picture of a sweep (C13.9), told as in HEVC.
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

    const VkSemaphoreSubmitInfo wait =
        d->device->afterLast(VK_PIPELINE_STAGE_2_VIDEO_ENCODE_BIT_KHR);
    std::string why;
    if (!d->device->runOn(d->device->encodeQueue(), cmd, wait.semaphore ? &wait : nullptr,
                          wait.semaphore ? 1u : 0u, why)) {
        m_Failed = true;
        error = "the Vulkan AV1 encode failed: " + why;
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
    const VkDeviceSize room = d->bitstreamSize - d->dataOffset;
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

bool VulkanAv1Encoder::check(const av1::FrameHeader& header, const HevcDpb::Plan& plan,
                             std::string& error) const
{
    const av1::FrameStart& f = header.start;
    if ((f.frameType == 0) != plan.idr) {
        error = std::string("the driver coded ") + (f.frameType == 0 ? "a key" : "an inter") +
                " frame where " + (plan.idr ? "a key" : "an inter") + " frame was asked";
        return false;
    }
    if (f.orderHint != (plan.poc & ((1u << m_Sequence.orderHintBits) - 1u))) {
        error = "the driver numbered picture " + std::to_string(plan.poc) + " as " +
                std::to_string(f.orderHint);
        return false;
    }
    // What a browser shows: the render size, the frame's own when none is said.
    const uint32_t shownWidth = header.renderWidth ? header.renderWidth : m_Sequence.width;
    const uint32_t shownHeight = header.renderHeight ? header.renderHeight : m_Sequence.height;
    if (shownWidth != static_cast<uint32_t>(m_Width) ||
        shownHeight != static_cast<uint32_t>(m_Height)) {
        error = "the driver's frame shows " + std::to_string(shownWidth) + "x" +
                std::to_string(shownHeight) + ", not " + std::to_string(m_Width) + "x" +
                std::to_string(m_Height);
        return false;
    }
    if (plan.idr) return true;
    const int used = plan.references[0].texture;
    if (f.refreshFrameFlags != (1u << plan.texture)) {
        error = "the driver's frame refreshes slots " + std::to_string(f.refreshFrameFlags) +
                ", not slot " + std::to_string(plan.texture);
        return false;
    }
    if (f.refFrameIdx[static_cast<size_t>(d->referenceName)] != used) {
        error = "the driver's frame predicts from slot " +
                std::to_string(f.refFrameIdx[static_cast<size_t>(d->referenceName)]) +
                ", not slot " + std::to_string(used);
        return false;
    }
    // Every name read at all must point at a picture the receiver holds: the
    // one asked for, the only one this encoder is sure of after a loss.
    for (int i = 0; i < av1::kRefsPerFrame; ++i)
        if (f.refFrameIdx[static_cast<size_t>(i)] != used) {
            error = "the driver's frame names slot " +
                    std::to_string(f.refFrameIdx[static_cast<size_t>(i)]) + " as reference " +
                    std::to_string(i) + ", which may be stale at the receiver";
            return false;
        }
    return true;
}

bool VulkanAv1Encoder::encode(bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                              std::string& error)
{
    if (!d->session) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_Failed) {
        error = "the Vulkan AV1 encoder was given up";
        return false;
    }
    if (m_OutputHeld) {
        error = "the previous frame was not released";
        return false;
    }
    const HevcDpb::Plan plan = m_Dpb.plan(frameNumber, forceKeyframe);
    const bool followsPrevious =
        !plan.idr && !plan.references.empty() && plan.references[0].poc + 1 == plan.poc;
    m_Step = m_Sweep.next(plan.idr, followsPrevious);
    uint32_t offset = 0, bytes = 0;
    if (!submit(plan, offset, bytes, error)) return false;
    uint8_t* data = d->bitstreamCpu + d->dataOffset + offset;

    // What the driver wrote: its OBUs, a temporal delimiter of its own or
    // not, the frame, and maybe padding its rate control adds at the end.
    std::vector<av1::Obu> units = av1::obus(data, bytes);
    size_t lead = 0;
    if (!units.empty() && units.front().type == av1::ObuType::TemporalDelimiter) {
        lead = static_cast<size_t>(units.front().payload + units.front().size - data);
        units.erase(units.begin());
    }
    // OBUs lie end to end: a trailing padding OBU starts where the one before
    // it ends.
    size_t end = bytes;
    while (!units.empty() && static_cast<uint8_t>(units.back().type) == 15) { // OBU_PADDING
        units.pop_back();
        end = units.empty() ? lead
                            : static_cast<size_t>(units.back().payload + units.back().size - data);
    }
    const av1::Obu* frame = nullptr;
    bool driverSequence = false;
    for (const av1::Obu& u : units) {
        if (u.type == av1::ObuType::SequenceHeader) driverSequence = true;
        if (!frame && (u.type == av1::ObuType::Frame || u.type == av1::ObuType::FrameHeader))
            frame = &u;
    }
    av1::FrameHeader header;
    const std::string unread =
        frame ? av1::parseFrameHeader(frame->payload, frame->size, m_Sequence, header)
              : std::string("no frame OBU in the driver's ") + std::to_string(bytes) + " bytes";
    if (m_GuardLeft > 0) {
        if (!unread.empty()) {
            m_Failed = true;
            error = "the driver's AV1 frame does not read with its own sequence header: " + unread;
            return false;
        }
        if (!check(header, plan, error)) {
            m_Failed = true;
            return false;
        }
        --m_GuardLeft;
    }
    m_Dpb.encoded(plan);
    if (plan.idr)
        m_SlotHint.fill(0);
    else
        m_SlotHint[static_cast<size_t>(plan.texture)] = static_cast<uint8_t>(plan.poc);
    if (end != bytes) {
        if (m_PaddingPictures == 0)
            log::info("[native] Vulkan Video: the driver pads its AV1 pictures, stripped before "
                      "the link (" +
                      std::to_string(bytes - end) + " of the first one's " + std::to_string(bytes) +
                      " bytes)");
        m_PaddingBytes += bytes - end;
        ++m_PaddingPictures;
    }

    // A temporal delimiter, the sequence header in front of a key frame, then
    // the driver's OBUs: laid in front of them, one run.
    std::vector<uint8_t> prefix = av1::temporalDelimiter();
    if (plan.idr && !driverSequence)
        prefix.insert(prefix.end(), m_SequenceObu.begin(), m_SequenceObu.end());
    uint8_t* body = data + lead;
    uint8_t* start = body - prefix.size();
    std::memcpy(start, prefix.data(), prefix.size());

    out = EncoderOutput{};
    out.data = start;
    out.size = prefix.size() + (end - lead);
    out.keyframe = plan.idr;
    // The quantizer, where the header says it: base_q_idx is only a starting
    // point once the superblocks carry deltas, as RADV's rate control writes
    // them — then nothing here knows the picture's, and nothing is claimed.
    out.avgQp = d->constantQp ? m_Witness.constantQp
                : unread.empty() && header.deltaQKnown && !header.deltaQPresent ? header.baseQIdx
                                                                                : -1;
    m_OutputHeld = true;
    return true;
}

bool VulkanAv1Encoder::invalidateReference(uint32_t frameNumber, std::string& error)
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

bool VulkanAv1Encoder::setBitrate(int bitrateKbps, std::string& error)
{
    if (!d->session) {
        error = "the encoder is not initialized";
        return false;
    }
    if (d->constantQp) return true;
    m_BitrateKbps = std::max(bitrateKbps, 1);
    d->rate[1 - d->current].set(false, static_cast<uint32_t>(m_BitrateKbps) * 1000u, m_Fps,
                                m_VbvFrames, d->minQIndex, d->maxQIndex);
    m_RateChanged = true;
    return true;
}

std::string VulkanAv1Encoder::describe() const
{
    return std::string("Vulkan Video (AV1, superblock ") + (m_Sequence.sb128 ? "128" : "64") + ")";
}

void VulkanAv1Encoder::stop()
{
    if (m_PaddingPictures > 0)
        log::info("[native] Vulkan Video: " + std::to_string(m_PaddingBytes / 1024) +
                  " KB of AV1 padding stripped from " + std::to_string(m_PaddingPictures) +
                  " pictures");
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
    m_SlotHint.fill(0);
    m_SequenceObu.clear();
    m_Sequence = av1::Sequence{};
    m_GuardLeft = 0;
    m_RateChanged = false;
    m_FirstPicture = true;
    m_OutputHeld = false;
    m_Failed = false;
    m_PaddingBytes = 0;
    m_PaddingPictures = 0;
}

} // namespace mw::native::encode
