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

#include "VulkanDevice.h"

#include "../ScopedCapability.h"

#include <dlfcn.h>
#include <linux/capability.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>

#include <cstring>
#include <mutex>
#include <vector>

namespace mw::native::vulkan {

std::string resultText(VkResult result)
{
    switch (result) {
    case VK_SUCCESS: return "VK_SUCCESS";
    case VK_NOT_READY: return "VK_NOT_READY";
    case VK_TIMEOUT: return "VK_TIMEOUT";
    case VK_ERROR_OUT_OF_HOST_MEMORY: return "VK_ERROR_OUT_OF_HOST_MEMORY";
    case VK_ERROR_OUT_OF_DEVICE_MEMORY: return "VK_ERROR_OUT_OF_DEVICE_MEMORY";
    case VK_ERROR_INITIALIZATION_FAILED: return "VK_ERROR_INITIALIZATION_FAILED";
    case VK_ERROR_DEVICE_LOST: return "VK_ERROR_DEVICE_LOST";
    case VK_ERROR_MEMORY_MAP_FAILED: return "VK_ERROR_MEMORY_MAP_FAILED";
    case VK_ERROR_EXTENSION_NOT_PRESENT: return "VK_ERROR_EXTENSION_NOT_PRESENT";
    case VK_ERROR_FEATURE_NOT_PRESENT: return "VK_ERROR_FEATURE_NOT_PRESENT";
    case VK_ERROR_INCOMPATIBLE_DRIVER: return "VK_ERROR_INCOMPATIBLE_DRIVER";
    case VK_ERROR_FORMAT_NOT_SUPPORTED: return "VK_ERROR_FORMAT_NOT_SUPPORTED";
    case VK_ERROR_INVALID_EXTERNAL_HANDLE: return "VK_ERROR_INVALID_EXTERNAL_HANDLE";
    case VK_ERROR_NOT_PERMITTED_KHR: return "VK_ERROR_NOT_PERMITTED";
    case VK_ERROR_INVALID_DRM_FORMAT_MODIFIER_PLANE_LAYOUT_EXT:
        return "VK_ERROR_INVALID_DRM_FORMAT_MODIFIER_PLANE_LAYOUT";
    default: return "VkResult " + std::to_string(static_cast<int>(result));
    }
}

// ── The loader and its instance, shared by every device of the process ────

#define MW_VULKAN_INSTANCE_FUNCTIONS(X)                                                            \
    X(vkDestroyInstance)                                                                           \
    X(vkEnumeratePhysicalDevices)                                                                  \
    X(vkGetPhysicalDeviceProperties2)                                                              \
    X(vkGetPhysicalDeviceFeatures2)                                                                \
    X(vkGetPhysicalDeviceMemoryProperties)                                                         \
    X(vkEnumerateDeviceExtensionProperties)                                                        \
    X(vkGetPhysicalDeviceQueueFamilyProperties2)                                                   \
    X(vkGetPhysicalDeviceFormatProperties2)                                                        \
    X(vkGetPhysicalDeviceExternalSemaphoreProperties)                                              \
    X(vkCreateDevice)                                                                              \
    X(vkGetDeviceProcAddr)

// VK_KHR_video_queue's: null where the loader has none.
#define MW_VULKAN_INSTANCE_OPTIONAL_FUNCTIONS(X)                                                   \
    X(vkGetPhysicalDeviceVideoCapabilitiesKHR)                                                     \
    X(vkGetPhysicalDeviceVideoFormatPropertiesKHR)

class Loader
{
public:
    /// The process's loader and instance, opened on first use and kept while
    /// a device holds them. Null, with the reason, when there is no loader or
    /// it creates no Vulkan 1.3 instance.
    static std::shared_ptr<Loader> get(std::string& error)
    {
        static std::mutex mutex;
        static std::weak_ptr<Loader> shared;
        std::lock_guard<std::mutex> lock(mutex);
        if (auto held = shared.lock()) return held;
        auto loader = std::shared_ptr<Loader>(new Loader());
        if (!loader->open(error)) return nullptr;
        shared = loader;
        return loader;
    }
    ~Loader()
    {
        if (m_Instance && vkDestroyInstance) vkDestroyInstance(m_Instance, nullptr);
        if (m_Library) dlclose(m_Library);
    }
    Loader(const Loader&) = delete;
    Loader& operator=(const Loader&) = delete;

    VkInstance instance() const { return m_Instance; }

    PFN_vkGetInstanceProcAddr vkGetInstanceProcAddr = nullptr;
    MW_VULKAN_INSTANCE_FUNCTIONS(MW_VULKAN_DECLARE)
    MW_VULKAN_INSTANCE_OPTIONAL_FUNCTIONS(MW_VULKAN_DECLARE)

private:
    Loader() = default;

    bool open(std::string& error)
    {
        // The loader's soname: the one every distribution ships, with or
        // without the -dev package.
        m_Library = dlopen("libvulkan.so.1", RTLD_NOW | RTLD_LOCAL);
        if (!m_Library) {
            error = "no Vulkan loader (libvulkan.so.1)";
            return false;
        }
        vkGetInstanceProcAddr =
            reinterpret_cast<PFN_vkGetInstanceProcAddr>(dlsym(m_Library, "vkGetInstanceProcAddr"));
        if (!vkGetInstanceProcAddr) {
            error = "the Vulkan loader has no vkGetInstanceProcAddr";
            return false;
        }
        auto enumerateVersion = reinterpret_cast<PFN_vkEnumerateInstanceVersion>(
            vkGetInstanceProcAddr(VK_NULL_HANDLE, "vkEnumerateInstanceVersion"));
        auto createInstance = reinterpret_cast<PFN_vkCreateInstance>(
            vkGetInstanceProcAddr(VK_NULL_HANDLE, "vkCreateInstance"));
        uint32_t version = VK_API_VERSION_1_0;
        if (enumerateVersion) enumerateVersion(&version);
        if (!createInstance || version < VK_API_VERSION_1_3) {
            error = "the Vulkan loader is older than 1.3";
            return false;
        }
        VkApplicationInfo app = {};
        app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        app.pApplicationName = "MoonlightWeb";
        app.pEngineName = "mw-native-host";
        app.apiVersion = VK_API_VERSION_1_3;
        VkInstanceCreateInfo ici = {};
        ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        ici.pApplicationInfo = &app;
        const VkResult r = createInstance(&ici, nullptr, &m_Instance);
        if (r != VK_SUCCESS) {
            m_Instance = VK_NULL_HANDLE;
            error = "vkCreateInstance: " + resultText(r);
            return false;
        }
#define MW_VULKAN_LOAD_INSTANCE(name)                                                              \
    name = reinterpret_cast<PFN_##name>(vkGetInstanceProcAddr(m_Instance, #name));                 \
    if (!name) {                                                                                   \
        error = "the Vulkan instance has no " #name;                                               \
        return false;                                                                              \
    }
        MW_VULKAN_INSTANCE_FUNCTIONS(MW_VULKAN_LOAD_INSTANCE)
#undef MW_VULKAN_LOAD_INSTANCE
#define MW_VULKAN_LOAD_INSTANCE_OPTIONAL(name)                                                     \
    name = reinterpret_cast<PFN_##name>(vkGetInstanceProcAddr(m_Instance, #name));
        MW_VULKAN_INSTANCE_OPTIONAL_FUNCTIONS(MW_VULKAN_LOAD_INSTANCE_OPTIONAL)
#undef MW_VULKAN_LOAD_INSTANCE_OPTIONAL
        return true;
    }

    void* m_Library = nullptr;
    VkInstance m_Instance = VK_NULL_HANDLE;
};

namespace {

std::vector<std::string> extensionsOf(const Loader& loader, VkPhysicalDevice device)
{
    uint32_t count = 0;
    loader.vkEnumerateDeviceExtensionProperties(device, nullptr, &count, nullptr);
    std::vector<VkExtensionProperties> props(count);
    loader.vkEnumerateDeviceExtensionProperties(device, nullptr, &count, props.data());
    std::vector<std::string> names;
    for (const auto& p : props)
        names.emplace_back(p.extensionName);
    return names;
}

bool has(const std::vector<std::string>& names, const char* name)
{
    for (const std::string& n : names)
        if (n == name) return true;
    return false;
}

/// The physical device behind the render node @p node, matched by its DRM
/// numbers (VK_EXT_physical_device_drm), with its properties, its name for
/// the log and its extensions. Null, with the reason, when none is or it is
/// older than Vulkan 1.3.
VkPhysicalDevice physicalFor(const Loader& loader, const std::string& renderNode,
                             const struct stat& node, VkPhysicalDeviceProperties& properties,
                             std::string& name, std::vector<std::string>& extensions,
                             std::string& error)
{
    uint32_t count = 0;
    loader.vkEnumeratePhysicalDevices(loader.instance(), &count, nullptr);
    std::vector<VkPhysicalDevice> physicals(count);
    loader.vkEnumeratePhysicalDevices(loader.instance(), &count, physicals.data());
    for (VkPhysicalDevice candidate : physicals) {
        std::vector<std::string> ext = extensionsOf(loader, candidate);
        if (!has(ext, VK_EXT_PHYSICAL_DEVICE_DRM_EXTENSION_NAME)) continue;
        VkPhysicalDeviceDrmPropertiesEXT drm = {};
        drm.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRM_PROPERTIES_EXT;
        VkPhysicalDeviceDriverProperties driver = {};
        driver.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES;
        driver.pNext = &drm;
        VkPhysicalDeviceProperties2 p2 = {};
        p2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
        p2.pNext = &driver;
        loader.vkGetPhysicalDeviceProperties2(candidate, &p2);
        if (!drm.hasRender || drm.renderMajor != static_cast<int64_t>(major(node.st_rdev)) ||
            drm.renderMinor != static_cast<int64_t>(minor(node.st_rdev)))
            continue;
        if (p2.properties.apiVersion < VK_API_VERSION_1_3) {
            error = std::string(p2.properties.deviceName) + " offers Vulkan " +
                    std::to_string(VK_API_VERSION_MAJOR(p2.properties.apiVersion)) + "." +
                    std::to_string(VK_API_VERSION_MINOR(p2.properties.apiVersion)) +
                    ", the engine needs 1.3";
            return VK_NULL_HANDLE;
        }
        properties = p2.properties;
        name = std::string(p2.properties.deviceName) + ", " + driver.driverName + " " +
               driver.driverInfo;
        extensions = std::move(ext);
        return candidate;
    }
    error = "no Vulkan device for " + renderNode;
    return VK_NULL_HANDLE;
}

} // namespace

// ── The device ──────────────────────────────────────────────────────────────

VulkanDevice::~VulkanDevice()
{
    destroy();
}

void VulkanDevice::destroy()
{
    if (!m_Device) return;
    // A device that is lost answers the idle wait at once: the teardown never
    // hangs on a GPU that went away.
    if (m_Fn.vkDeviceWaitIdle) m_Fn.vkDeviceWaitIdle(m_Device);
    if (m_Timeline && m_Fn.vkDestroySemaphore)
        m_Fn.vkDestroySemaphore(m_Device, m_Timeline, nullptr);
    m_Timeline = VK_NULL_HANDLE;
    if (m_Fn.vkDestroyDevice) m_Fn.vkDestroyDevice(m_Device, nullptr);
    m_Device = VK_NULL_HANDLE;
    m_Queue = VK_NULL_HANDLE;
    m_EncodeQueue = VK_NULL_HANDLE;
    m_DecodeQueue = VK_NULL_HANDLE;
    m_Fn = DeviceFunctions{};
    m_Submitted = 0;
}

bool VulkanDevice::identify(const std::string& renderNode, DeviceIdentity& out, std::string& error)
{
    struct stat node = {};
    if (::stat(renderNode.c_str(), &node) != 0 || !S_ISCHR(node.st_mode)) {
        error = "no render node " + renderNode;
        return false;
    }
    const std::shared_ptr<Loader> loader = Loader::get(error);
    if (!loader) return false;
    VkPhysicalDeviceProperties properties = {};
    std::vector<std::string> extensions;
    DeviceIdentity id;
    const VkPhysicalDevice physical =
        physicalFor(*loader, renderNode, node, properties, id.name, extensions, error);
    if (!physical) return false;
    id.vendorId = properties.vendorID;
    id.driverVersion = properties.driverVersion;
    VkPhysicalDeviceIDProperties ids = {};
    ids.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES;
    VkPhysicalDeviceProperties2 p2 = {};
    p2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
    p2.pNext = &ids;
    loader->vkGetPhysicalDeviceProperties2(physical, &p2);
    std::memcpy(id.uuid, ids.deviceUUID, VK_UUID_SIZE);
    id.encodesHevc = has(extensions, VK_KHR_VIDEO_ENCODE_QUEUE_EXTENSION_NAME) &&
                     has(extensions, VK_KHR_VIDEO_ENCODE_H265_EXTENSION_NAME);
    id.decodesHevc = has(extensions, VK_KHR_VIDEO_DECODE_QUEUE_EXTENSION_NAME) &&
                     has(extensions, VK_KHR_VIDEO_DECODE_H265_EXTENSION_NAME);
    id.encodesAv1 = has(extensions, VK_KHR_VIDEO_ENCODE_QUEUE_EXTENSION_NAME) &&
                    has(extensions, VK_KHR_VIDEO_ENCODE_AV1_EXTENSION_NAME);
    id.importsHostMemory = has(extensions, VK_EXT_EXTERNAL_MEMORY_HOST_EXTENSION_NAME);
    out = id;
    return true;
}

std::unique_ptr<VulkanDevice> VulkanDevice::open(const std::string& renderNode, bool wantHigh,
                                                 std::string& error)
{
    DeviceOptions options;
    options.wantHigh = wantHigh;
    return open(renderNode, options, error);
}

std::unique_ptr<VulkanDevice> VulkanDevice::open(const std::string& renderNode,
                                                 const DeviceOptions& options, std::string& error)
{
    const bool wantHigh = options.wantHigh;
    struct stat node = {};
    if (::stat(renderNode.c_str(), &node) != 0 || !S_ISCHR(node.st_mode)) {
        error = "no render node " + renderNode;
        return nullptr;
    }
    std::unique_ptr<VulkanDevice> device(new VulkanDevice());
    device->m_Loader = Loader::get(error);
    if (!device->m_Loader) return nullptr;
    const Loader& loader = *device->m_Loader;

    std::vector<std::string> extensions;
    VkPhysicalDeviceProperties properties = {};
    device->m_Physical =
        physicalFor(loader, renderNode, node, properties, device->m_Name, extensions, error);
    if (!device->m_Physical) return nullptr;
    for (const char* name :
         {VK_EXT_IMAGE_DRM_FORMAT_MODIFIER_EXTENSION_NAME,
          VK_EXT_EXTERNAL_MEMORY_DMA_BUF_EXTENSION_NAME, VK_KHR_EXTERNAL_MEMORY_FD_EXTENSION_NAME,
          VK_EXT_QUEUE_FAMILY_FOREIGN_EXTENSION_NAME}) {
        if (!has(extensions, name)) {
            error = device->m_Name + " lacks " + name;
            return nullptr;
        }
    }
    VkPhysicalDeviceFeatures2 features = {};
    features.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
    loader.vkGetPhysicalDeviceFeatures2(device->m_Physical, &features);
    if (!features.features.shaderStorageImageExtendedFormats) {
        error = device->m_Name + " cannot write R8/RG8 storage images (extended formats)";
        return nullptr;
    }
    loader.vkGetPhysicalDeviceMemoryProperties(device->m_Physical, &device->m_Memory);
    device->m_TimestampPeriod = properties.limits.timestampPeriod;
    device->m_Options = options;
    device->m_VendorId = properties.vendorID;
    device->m_DriverVersion = properties.driverVersion;
    {
        VkPhysicalDeviceIDProperties id = {};
        id.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES;
        // What a host pointer must be aligned to, where the driver imports
        // one (C13.10): asked only then, a structure of an extension the
        // device lacks being invalid in the chain.
        VkPhysicalDeviceExternalMemoryHostPropertiesEXT host = {};
        host.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_MEMORY_HOST_PROPERTIES_EXT;
        device->m_HostMemory = has(extensions, VK_EXT_EXTERNAL_MEMORY_HOST_EXTENSION_NAME);
        if (device->m_HostMemory) id.pNext = &host;
        VkPhysicalDeviceProperties2 p2 = {};
        p2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
        p2.pNext = &id;
        loader.vkGetPhysicalDeviceProperties2(device->m_Physical, &p2);
        std::memcpy(device->m_DeviceUuid, id.deviceUUID, VK_UUID_SIZE);
        if (device->m_HostMemory && host.minImportedHostPointerAlignment > 0)
            device->m_HostAlignment = host.minImportedHostPointerAlignment;
    }

    // The queue: compute without graphics where the GPU has one — the queue
    // that runs beside a game rather than behind it (§8o.1) — and the
    // graphics one otherwise.
    uint32_t familyCount = 0;
    loader.vkGetPhysicalDeviceQueueFamilyProperties2(device->m_Physical, &familyCount, nullptr);
    std::vector<VkQueueFamilyProperties2> families(familyCount);
    std::vector<VkQueueFamilyVideoPropertiesKHR> videoFamilies(familyCount);
    const bool videoQueries = has(extensions, VK_KHR_VIDEO_QUEUE_EXTENSION_NAME);
    for (uint32_t i = 0; i < familyCount; ++i) {
        videoFamilies[i] = {};
        videoFamilies[i].sType = VK_STRUCTURE_TYPE_QUEUE_FAMILY_VIDEO_PROPERTIES_KHR;
        families[i] = {};
        families[i].sType = VK_STRUCTURE_TYPE_QUEUE_FAMILY_PROPERTIES_2;
        families[i].pNext = videoQueries ? &videoFamilies[i] : nullptr;
    }
    loader.vkGetPhysicalDeviceQueueFamilyProperties2(device->m_Physical, &familyCount,
                                                     families.data());

    // The video queues asked for: a family that says it takes HEVC, and the
    // extensions that drive it. A driver that hides its encoder (RADV below
    // VCN firmware ENC 1.22, §8o.0) has neither: refused here, by name.
    auto videoFamily = [&](VkQueueFlags flag, VkVideoCodecOperationFlagsKHR operation) {
        for (uint32_t i = 0; i < familyCount; ++i)
            if ((families[i].queueFamilyProperties.queueFlags & flag) &&
                (videoFamilies[i].videoCodecOperations & operation))
                return i;
        return UINT32_MAX;
    };
    if (options.encodeHevc || options.encodeAv1) {
        std::vector<const char*> needed = {VK_KHR_VIDEO_QUEUE_EXTENSION_NAME,
                                           VK_KHR_VIDEO_ENCODE_QUEUE_EXTENSION_NAME};
        if (options.encodeHevc) needed.push_back(VK_KHR_VIDEO_ENCODE_H265_EXTENSION_NAME);
        if (options.encodeAv1) needed.push_back(VK_KHR_VIDEO_ENCODE_AV1_EXTENSION_NAME);
        for (const char* name : needed) {
            if (!has(extensions, name)) {
                error = device->m_Name + " offers no Vulkan Video encoder (" + name + ")";
                return nullptr;
            }
        }
        // One queue for whatever is asked: a family that takes every codec.
        const VkVideoCodecOperationFlagsKHR operations =
            (options.encodeHevc ? VK_VIDEO_CODEC_OPERATION_ENCODE_H265_BIT_KHR : 0) |
            (options.encodeAv1 ? VK_VIDEO_CODEC_OPERATION_ENCODE_AV1_BIT_KHR : 0);
        for (uint32_t i = 0; i < familyCount && device->m_EncodeFamily == UINT32_MAX; ++i)
            if ((families[i].queueFamilyProperties.queueFlags & VK_QUEUE_VIDEO_ENCODE_BIT_KHR) &&
                (videoFamilies[i].videoCodecOperations & operations) == operations)
                device->m_EncodeFamily = i;
        if (device->m_EncodeFamily == UINT32_MAX) {
            error = device->m_Name + " has no queue that encodes " +
                    (options.encodeAv1 && options.encodeHevc ? "HEVC and AV1"
                     : options.encodeAv1                     ? "AV1"
                                                             : "HEVC");
            return nullptr;
        }
        // The AV1 encoder is a feature as well as an extension: both, or none.
        if (options.encodeAv1) {
            VkPhysicalDeviceVideoEncodeAV1FeaturesKHR av1 = {};
            av1.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VIDEO_ENCODE_AV1_FEATURES_KHR;
            VkPhysicalDeviceFeatures2 asked = {};
            asked.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
            asked.pNext = &av1;
            loader.vkGetPhysicalDeviceFeatures2(device->m_Physical, &asked);
            if (av1.videoEncodeAV1 != VK_TRUE) {
                error = device->m_Name + " lists VK_KHR_video_encode_av1 without its feature";
                return nullptr;
            }
        }
        if (!loader.vkGetPhysicalDeviceVideoCapabilitiesKHR ||
            !loader.vkGetPhysicalDeviceVideoFormatPropertiesKHR) {
            error = "the Vulkan loader has no VK_KHR_video_queue queries";
            return nullptr;
        }
        // Sweeps instead of keyframes where the driver has them: the
        // extension and its feature, both, or the encoder keeps keyframes.
        if (has(extensions, VK_KHR_VIDEO_ENCODE_INTRA_REFRESH_EXTENSION_NAME)) {
            VkPhysicalDeviceVideoEncodeIntraRefreshFeaturesKHR refresh = {};
            refresh.sType =
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VIDEO_ENCODE_INTRA_REFRESH_FEATURES_KHR;
            VkPhysicalDeviceFeatures2 asked = {};
            asked.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
            asked.pNext = &refresh;
            loader.vkGetPhysicalDeviceFeatures2(device->m_Physical, &asked);
            device->m_EncodeIntraRefresh = refresh.videoEncodeIntraRefresh == VK_TRUE;
        }
    }
    if (options.decodeHevc) {
        for (const char* name :
             {VK_KHR_VIDEO_QUEUE_EXTENSION_NAME, VK_KHR_VIDEO_DECODE_QUEUE_EXTENSION_NAME,
              VK_KHR_VIDEO_DECODE_H265_EXTENSION_NAME}) {
            if (!has(extensions, name)) {
                error = device->m_Name + " offers no Vulkan Video decoder (" + name + ")";
                return nullptr;
            }
        }
        device->m_DecodeFamily = videoFamily(VK_QUEUE_VIDEO_DECODE_BIT_KHR,
                                             VK_VIDEO_CODEC_OPERATION_DECODE_H265_BIT_KHR);
        if (device->m_DecodeFamily == UINT32_MAX) {
            error = device->m_Name + " has no queue that decodes HEVC";
            return nullptr;
        }
        if (!loader.vkGetPhysicalDeviceVideoCapabilitiesKHR ||
            !loader.vkGetPhysicalDeviceVideoFormatPropertiesKHR) {
            error = "the Vulkan loader has no VK_KHR_video_queue queries";
            return nullptr;
        }
    }
    for (uint32_t pass = 0; pass < 2 && device->m_Family == UINT32_MAX; ++pass) {
        for (uint32_t i = 0; i < familyCount; ++i) {
            const VkQueueFlags flags = families[i].queueFamilyProperties.queueFlags;
            const bool compute = flags & VK_QUEUE_COMPUTE_BIT;
            const bool graphics = flags & VK_QUEUE_GRAPHICS_BIT;
            if (compute && (pass == 1 || !graphics)) {
                device->m_Family = i;
                device->m_AsyncCompute = !graphics;
                break;
            }
        }
    }
    if (device->m_Family == UINT32_MAX) {
        error = device->m_Name + " has no compute queue";
        return nullptr;
    }
    device->m_Timestamps =
        families[device->m_Family].queueFamilyProperties.timestampValidBits > 0 &&
        properties.limits.timestampPeriod > 0.0f;

    device->m_PriorityExtension =
        has(extensions, "VK_KHR_global_priority") || has(extensions, "VK_EXT_global_priority");
    const bool syncFdExtension = has(extensions, VK_KHR_EXTERNAL_SEMAPHORE_FD_EXTENSION_NAME);
    if (syncFdExtension) {
        VkPhysicalDeviceExternalSemaphoreInfo info = {};
        info.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_SEMAPHORE_INFO;
        info.handleType = VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT;
        VkExternalSemaphoreProperties props = {};
        props.sType = VK_STRUCTURE_TYPE_EXTERNAL_SEMAPHORE_PROPERTIES;
        loader.vkGetPhysicalDeviceExternalSemaphoreProperties(device->m_Physical, &info, &props);
        device->m_SyncFile =
            props.externalSemaphoreFeatures & VK_EXTERNAL_SEMAPHORE_FEATURE_IMPORTABLE_BIT;
    }

    // HIGH, proven by a submission, then the default. A process without
    // CAP_SYS_NICE is not refused HIGH by asking: it is not asked at all.
    const bool mayRaise = platform::ScopedCapability::permitted(CAP_SYS_NICE);
    std::string why;
    if (wantHigh && device->m_PriorityExtension && mayRaise) {
        if (device->create(true, why)) {
            device->m_QueueDescription = std::string(device->m_AsyncCompute ? "a compute queue"
                                                                            : "the graphics "
                                                                              "queue") +
                                         ", priority high (CAP_SYS_NICE)";
            return device;
        }
        device->destroy();
    }
    if (!device->create(false, error)) return nullptr;
    const char* normal = !wantHigh                      ? "normal (asked for)"
                         : !device->m_PriorityExtension ? "normal (no global priority here)"
                         : !mayRaise ? "normal (no CAP_SYS_NICE: the package's launcher hands it "
                                       "over)"
                                     : nullptr;
    device->m_QueueDescription =
        std::string(device->m_AsyncCompute ? "a compute queue" : "the graphics queue") +
        ", priority " + (normal ? normal : "normal (HIGH refused: " + why + ")");
    return device;
}

bool VulkanDevice::create(bool high, std::string& error)
{
    const Loader& loader = *m_Loader;
    std::vector<const char*> enable = {VK_EXT_IMAGE_DRM_FORMAT_MODIFIER_EXTENSION_NAME,
                                       VK_EXT_EXTERNAL_MEMORY_DMA_BUF_EXTENSION_NAME,
                                       VK_KHR_EXTERNAL_MEMORY_FD_EXTENSION_NAME,
                                       VK_EXT_QUEUE_FAMILY_FOREIGN_EXTENSION_NAME};
    const std::vector<std::string> extensions = extensionsOf(loader, m_Physical);
    if (m_SyncFile) enable.push_back(VK_KHR_EXTERNAL_SEMAPHORE_FD_EXTENSION_NAME);
    if (m_HostMemory) enable.push_back(VK_EXT_EXTERNAL_MEMORY_HOST_EXTENSION_NAME);
    if (high) {
        enable.push_back(has(extensions, "VK_KHR_global_priority") ? "VK_KHR_global_priority"
                                                                   : "VK_EXT_global_priority");
    }
    const bool encode = m_Options.encodeHevc || m_Options.encodeAv1;
    const bool video = encode || m_Options.decodeHevc;
    if (video) enable.push_back(VK_KHR_VIDEO_QUEUE_EXTENSION_NAME);
    if (encode) {
        enable.push_back(VK_KHR_VIDEO_ENCODE_QUEUE_EXTENSION_NAME);
        if (m_Options.encodeHevc) enable.push_back(VK_KHR_VIDEO_ENCODE_H265_EXTENSION_NAME);
        if (m_Options.encodeAv1) enable.push_back(VK_KHR_VIDEO_ENCODE_AV1_EXTENSION_NAME);
        if (m_EncodeIntraRefresh)
            enable.push_back(VK_KHR_VIDEO_ENCODE_INTRA_REFRESH_EXTENSION_NAME);
    }
    if (m_Options.decodeHevc) {
        enable.push_back(VK_KHR_VIDEO_DECODE_QUEUE_EXTENSION_NAME);
        enable.push_back(VK_KHR_VIDEO_DECODE_H265_EXTENSION_NAME);
    }

    // One queue per family asked for. Only the conversion's carries a
    // priority: an encode queue at HIGH is created and then refused at its
    // first submission on the 780M (§8o.3), so the video queues keep the
    // default — the encode is a few milliseconds on a block no game uses.
    const float one = 1.0f;
    VkDeviceQueueGlobalPriorityCreateInfoKHR priority = {};
    priority.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_GLOBAL_PRIORITY_CREATE_INFO_KHR;
    priority.globalPriority = VK_QUEUE_GLOBAL_PRIORITY_HIGH_KHR;
    std::vector<VkDeviceQueueCreateInfo> queues;
    for (uint32_t family : {m_Family, m_EncodeFamily, m_DecodeFamily}) {
        if (family == UINT32_MAX) continue;
        bool seen = false;
        for (const auto& q : queues)
            seen = seen || q.queueFamilyIndex == family;
        if (seen) continue;
        VkDeviceQueueCreateInfo queue = {};
        queue.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
        queue.pNext = high && family == m_Family ? &priority : nullptr;
        queue.queueFamilyIndex = family;
        queue.queueCount = 1;
        queue.pQueuePriorities = &one;
        queues.push_back(queue);
    }
    VkPhysicalDeviceVideoEncodeIntraRefreshFeaturesKHR refresh = {};
    refresh.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VIDEO_ENCODE_INTRA_REFRESH_FEATURES_KHR;
    refresh.videoEncodeIntraRefresh = VK_TRUE;
    VkPhysicalDeviceVideoEncodeAV1FeaturesKHR av1 = {};
    av1.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VIDEO_ENCODE_AV1_FEATURES_KHR;
    av1.videoEncodeAV1 = VK_TRUE;
    // The chain: the AV1 encoder's feature, then the sweeps', each where asked.
    void* videoFeatures = nullptr;
    if (encode && m_EncodeIntraRefresh) {
        refresh.pNext = videoFeatures;
        videoFeatures = &refresh;
    }
    if (m_Options.encodeAv1) {
        av1.pNext = videoFeatures;
        videoFeatures = &av1;
    }
    VkPhysicalDeviceVulkan13Features f13 = {};
    f13.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES;
    f13.pNext = videoFeatures;
    f13.synchronization2 = VK_TRUE;
    VkPhysicalDeviceVulkan12Features f12 = {};
    f12.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES;
    f12.pNext = &f13;
    f12.timelineSemaphore = VK_TRUE;
    VkPhysicalDeviceFeatures2 features = {};
    features.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
    features.pNext = &f12;
    features.features.shaderStorageImageExtendedFormats = VK_TRUE;
    VkDeviceCreateInfo dci = {};
    dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.pNext = &features;
    dci.queueCreateInfoCount = static_cast<uint32_t>(queues.size());
    dci.pQueueCreateInfos = queues.data();
    dci.enabledExtensionCount = static_cast<uint32_t>(enable.size());
    dci.ppEnabledExtensionNames = enable.data();
    VkResult r;
    if (high) {
        // The priority is the context's, fixed at creation: the capability is
        // needed for this call only, and held for no other.
        platform::ScopedCapability nice(CAP_SYS_NICE);
        r = loader.vkCreateDevice(m_Physical, &dci, nullptr, &m_Device);
    } else {
        r = loader.vkCreateDevice(m_Physical, &dci, nullptr, &m_Device);
    }
    if (r != VK_SUCCESS) {
        m_Device = VK_NULL_HANDLE;
        error = "vkCreateDevice: " + resultText(r);
        return false;
    }

#define MW_VULKAN_LOAD_DEVICE(name)                                                                \
    m_Fn.name = reinterpret_cast<PFN_##name>(loader.vkGetDeviceProcAddr(m_Device, #name));         \
    if (!m_Fn.name) {                                                                              \
        error = "the Vulkan device has no " #name;                                                 \
        return false;                                                                              \
    }
    MW_VULKAN_DEVICE_FUNCTIONS(MW_VULKAN_LOAD_DEVICE)
#undef MW_VULKAN_LOAD_DEVICE
#define MW_VULKAN_LOAD_OPTIONAL(name)                                                              \
    m_Fn.name = reinterpret_cast<PFN_##name>(loader.vkGetDeviceProcAddr(m_Device, #name));
    MW_VULKAN_OPTIONAL_DEVICE_FUNCTIONS(MW_VULKAN_LOAD_OPTIONAL)
#undef MW_VULKAN_LOAD_OPTIONAL
    if (!m_Fn.vkImportSemaphoreFdKHR) m_SyncFile = false;
#define MW_VULKAN_LOAD_DEVICE(name)                                                                \
    m_Fn.name = reinterpret_cast<PFN_##name>(loader.vkGetDeviceProcAddr(m_Device, #name));         \
    if (!m_Fn.name) {                                                                              \
        error = "the Vulkan device has no " #name;                                                 \
        return false;                                                                              \
    }
    if (video) {
        MW_VULKAN_VIDEO_FUNCTIONS(MW_VULKAN_LOAD_DEVICE)
    }
    if (encode) {
        MW_VULKAN_VIDEO_ENCODE_FUNCTIONS(MW_VULKAN_LOAD_DEVICE)
    }
    if (m_Options.decodeHevc) {
        MW_VULKAN_VIDEO_DECODE_FUNCTIONS(MW_VULKAN_LOAD_DEVICE)
    }
#undef MW_VULKAN_LOAD_DEVICE
    m_Fn.vkGetDeviceQueue(m_Device, m_Family, 0, &m_Queue);
    if (m_EncodeFamily != UINT32_MAX)
        m_Fn.vkGetDeviceQueue(m_Device, m_EncodeFamily, 0, &m_EncodeQueue);
    if (m_DecodeFamily != UINT32_MAX)
        m_Fn.vkGetDeviceQueue(m_Device, m_DecodeFamily, 0, &m_DecodeQueue);

    VkSemaphoreTypeCreateInfo kind = {};
    kind.sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO;
    kind.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
    VkSemaphoreCreateInfo sci = {};
    sci.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    sci.pNext = &kind;
    r = m_Fn.vkCreateSemaphore(m_Device, &sci, nullptr, &m_Timeline);
    if (r != VK_SUCCESS) {
        m_Timeline = VK_NULL_HANDLE;
        error = "timeline semaphore: " + resultText(r);
        return false;
    }
    m_High = high;
    m_Lost = false;

    // The proof: an empty command buffer through the queue and back. A queue
    // the kernel will not run at this priority says so here, not in the
    // middle of a stream.
    VkCommandPool pool = VK_NULL_HANDLE;
    VkCommandPoolCreateInfo pci = {};
    pci.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    pci.queueFamilyIndex = m_Family;
    r = m_Fn.vkCreateCommandPool(m_Device, &pci, nullptr, &pool);
    if (r != VK_SUCCESS) {
        error = "command pool: " + resultText(r);
        return false;
    }
    VkCommandBuffer cmd = VK_NULL_HANDLE;
    VkCommandBufferAllocateInfo cai = {};
    cai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    cai.commandPool = pool;
    cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cai.commandBufferCount = 1;
    bool proven = m_Fn.vkAllocateCommandBuffers(m_Device, &cai, &cmd) == VK_SUCCESS;
    if (proven) {
        VkCommandBufferBeginInfo cbi = {};
        cbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        proven = m_Fn.vkBeginCommandBuffer(cmd, &cbi) == VK_SUCCESS &&
                 m_Fn.vkEndCommandBuffer(cmd) == VK_SUCCESS && run(cmd, nullptr, 0, error);
    }
    m_Fn.vkDestroyCommandPool(m_Device, pool, nullptr);
    if (!proven) {
        if (error.empty()) error = "the queue does not take a submission";
        return false;
    }
    return true;
}

uint32_t VulkanDevice::memoryType(uint32_t bits, VkMemoryPropertyFlags want) const
{
    for (uint32_t i = 0; i < m_Memory.memoryTypeCount; ++i)
        if ((bits & (1u << i)) && (m_Memory.memoryTypes[i].propertyFlags & want) == want) return i;
    return UINT32_MAX;
}

bool VulkanDevice::modifierFeatures(VkFormat format, uint64_t modifier,
                                    VkFormatFeatureFlags2& features, uint32_t& planes) const
{
    VkDrmFormatModifierPropertiesList2EXT list = {};
    list.sType = VK_STRUCTURE_TYPE_DRM_FORMAT_MODIFIER_PROPERTIES_LIST_2_EXT;
    VkFormatProperties2 props = {};
    props.sType = VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_2;
    props.pNext = &list;
    m_Loader->vkGetPhysicalDeviceFormatProperties2(m_Physical, format, &props);
    std::vector<VkDrmFormatModifierProperties2EXT> mods(list.drmFormatModifierCount);
    list.pDrmFormatModifierProperties = mods.data();
    m_Loader->vkGetPhysicalDeviceFormatProperties2(m_Physical, format, &props);
    for (const auto& m : mods) {
        if (m.drmFormatModifier != modifier) continue;
        features = m.drmFormatModifierTilingFeatures;
        planes = m.drmFormatModifierPlaneCount;
        return true;
    }
    return false;
}

VkResult VulkanDevice::videoCapabilities(const VkVideoProfileInfoKHR& profile,
                                         VkVideoCapabilitiesKHR& capabilities) const
{
    if (!m_Loader->vkGetPhysicalDeviceVideoCapabilitiesKHR) return VK_ERROR_EXTENSION_NOT_PRESENT;
    return m_Loader->vkGetPhysicalDeviceVideoCapabilitiesKHR(m_Physical, &profile, &capabilities);
}

VkResult VulkanDevice::videoFormats(const VkPhysicalDeviceVideoFormatInfoKHR& info,
                                    std::vector<VkVideoFormatPropertiesKHR>& formats) const
{
    formats.clear();
    if (!m_Loader->vkGetPhysicalDeviceVideoFormatPropertiesKHR)
        return VK_ERROR_EXTENSION_NOT_PRESENT;
    uint32_t count = 0;
    VkResult r =
        m_Loader->vkGetPhysicalDeviceVideoFormatPropertiesKHR(m_Physical, &info, &count, nullptr);
    if (r != VK_SUCCESS) return r;
    formats.resize(count);
    for (auto& f : formats) {
        f = {};
        f.sType = VK_STRUCTURE_TYPE_VIDEO_FORMAT_PROPERTIES_KHR;
    }
    r = m_Loader->vkGetPhysicalDeviceVideoFormatPropertiesKHR(m_Physical, &info, &count,
                                                              formats.data());
    formats.resize(count);
    return r;
}

bool VulkanDevice::run(VkCommandBuffer cmd, const VkSemaphoreSubmitInfo* waits, uint32_t waitCount,
                       std::string& error)
{
    return runOn(m_Queue, cmd, waits, waitCount, error);
}

VkSemaphoreSubmitInfo VulkanDevice::afterLast(VkPipelineStageFlags2 stage) const
{
    VkSemaphoreSubmitInfo wait = {};
    wait.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO;
    if (m_Submitted == 0) return wait;
    wait.semaphore = m_Timeline;
    wait.value = m_Submitted;
    wait.stageMask = stage;
    return wait;
}

bool VulkanDevice::runOn(VkQueue queue, VkCommandBuffer cmd, const VkSemaphoreSubmitInfo* waits,
                         uint32_t waitCount, std::string& error)
{
    if (m_Lost) {
        error = "the Vulkan device is lost";
        return false;
    }
    VkCommandBufferSubmitInfo cmdInfo = {};
    cmdInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_SUBMIT_INFO;
    cmdInfo.commandBuffer = cmd;
    VkSemaphoreSubmitInfo signal = {};
    signal.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO;
    signal.semaphore = m_Timeline;
    signal.value = m_Submitted + 1;
    signal.stageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
    VkSubmitInfo2 submit = {};
    submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO_2;
    submit.waitSemaphoreInfoCount = waitCount;
    submit.pWaitSemaphoreInfos = waits;
    submit.commandBufferInfoCount = 1;
    submit.pCommandBufferInfos = &cmdInfo;
    submit.signalSemaphoreInfoCount = 1;
    submit.pSignalSemaphoreInfos = &signal;
    VkResult r = m_Fn.vkQueueSubmit2(queue, 1, &submit, VK_NULL_HANDLE);
    if (r != VK_SUCCESS) {
        m_Lost = true;
        error = "vkQueueSubmit2: " + resultText(r);
        return false;
    }
    ++m_Submitted;
    VkSemaphoreWaitInfo wait = {};
    wait.sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO;
    wait.semaphoreCount = 1;
    wait.pSemaphores = &m_Timeline;
    wait.pValues = &m_Submitted;
    r = m_Fn.vkWaitSemaphores(m_Device, &wait, kGpuGoneMs * 1000000ull);
    if (r != VK_SUCCESS) {
        m_Lost = true;
        error = r == VK_TIMEOUT
                    ? "the GPU did not come back in " + std::to_string(kGpuGoneMs) + " ms"
                    : "vkWaitSemaphores: " + resultText(r);
        return false;
    }
    return true;
}

} // namespace mw::native::vulkan
