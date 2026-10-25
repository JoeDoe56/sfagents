# vulkan-headers

The Khronos **Vulkan** API headers — the interface to Vulkan Video, the
encoder a Vulkan chain would give the Linux host, and to the lab that measures
it before any of it is built (`tools/vk-lab`).

## Provenance

From [KhronosGroup/Vulkan-Headers](https://github.com/KhronosGroup/Vulkan-Headers),
tag **`v1.4.364`** (archive SHA-256
`37e00e30611375938a9437477de793e355e55d486c25ab3dfd7a1a11ab0f8f07`):

- `include/vulkan/`: `vulkan.h`, `vulkan_core.h`, `vk_platform.h` only — the
  window-system headers and the C++ bindings are not needed;
- `include/vk_video/`: all of it, the codec definitions `vulkan_core.h` pulls in;
- `LICENSE.md` and `LICENSES/`, as published.

Only the headers are vendored. The runtime is the system's Vulkan loader,
`libvulkan.so.1`, opened with `dlopen` at run time — nothing is linked, and
the drivers (Mesa's RADV and ANV, NVIDIA's) are the user's.

## Licence

**Apache-2.0 OR MIT**, per the `SPDX-License-Identifier` at the head of every
file and `LICENSE.md` alongside them:

> Copyright 2015-2026 The Khronos Group Inc.

| | |
|---|---|
| Open-source impact | none — no copyleft |
| Commercial use | permitted, including in a proprietary build |
| Redistribution | permitted; the notice must travel with the files |

The loader these headers talk to is Apache-2.0 as well, and it is the system's:
nothing of it is redistributed with MoonlightWeb.

## Why the newest

Unlike NVENC's header (`../nvenc-headers/README.md`), a newer Vulkan header
asks nothing more of the driver. Every extension is looked up at run time
(`vkEnumerateDeviceExtensionProperties`), its structures carry their own
`sType`, and the API version a program asks for is the one it passes to
`vkCreateInstance`, not the header's. A newer header only names more of what a
driver may answer — the video encode extensions keep arriving
(`VK_KHR_video_encode_intra_refresh`, `VK_KHR_video_encode_quantization_map`),
and a lab that cannot name them cannot ask for them.

## Why vendored rather than the system's

The distributions the host targets carry old headers: Ubuntu 22.04 has 1.3.204,
from before the video encode extensions were final (1.3.274). A build must not
depend on which Vulkan SDK the build machine happens to have, nor need the
network.

## Updating

Copy the same files from a newer tag, keeping the notices intact, and record
the tag and the archive's hash above. Nothing here is generated or patched.
