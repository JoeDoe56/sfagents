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

#include "mw/native/VirtualDisplay.h"

#include "../../core/Log.h"

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

// macOS: a virtual display from CoreGraphics itself.
//
// CoreGraphics has carried, since 10.14 or so, four private classes —
// CGVirtualDisplayDescriptor, CGVirtualDisplaySettings, CGVirtualDisplayMode
// and CGVirtualDisplay — that let a process register a display the window
// server treats exactly like a monitor: it is in CGGetOnlineDisplayList, the
// desktop extends to it, ScreenCaptureKit captures it, and a headless Mac mini
// gets a screen to stream. BetterDisplay and DeskPad (MIT) are built on them.
// No entitlement is involved; only the Mac App Store would object, and this
// app is not sold there.
//
// Private means unannounced: nothing here names those classes at link time.
// They are looked up by name when first needed, the selectors are checked, and
// an OS where any of it is gone answers "not supported" with the reason,
// rather than aborting on an unrecognised selector. That is also why this file
// is compiled WITHOUT ARC (see CMakeLists.txt): the calls go through
// objc_msgSend casts and key-value coding, and the one object that must
// outlive this function — the display — is retained by hand, in plain sight.
//
// The display exists while `g_display` is alive. Releasing it is how the OS
// takes the display down: there is no "remove" call.

namespace mw::native::vdisplay {

namespace {

// USB-style vendor/product/serial the OS shows for the display, and what
// MacProbe turns into the display's stable key (vendor-model-serial) — so the
// card art and the pairing of a stream to "the virtual one" survive a restart.
constexpr uint32_t kVendorId = 0x4D57;  // "MW"
constexpr uint32_t kProductId = 0x5644; // "VD"
constexpr uint32_t kSerial = 1;

id g_display = nil;       // the CGVirtualDisplay, retained (+1) while it exists
uint32_t g_displayId = 0; // its CGDirectDisplayID

struct Classes
{
    Class descriptor = nil;
    Class settings = nil;
    Class mode = nil;
    Class display = nil;
    std::string missing;
};

const Classes& classes()
{
    static Classes c = [] {
        Classes out;
        out.descriptor = objc_getClass("CGVirtualDisplayDescriptor");
        out.settings = objc_getClass("CGVirtualDisplaySettings");
        out.mode = objc_getClass("CGVirtualDisplayMode");
        out.display = objc_getClass("CGVirtualDisplay");
        const struct
        {
            Class cls;
            const char* what;
            const char* selector; // nullptr: the class itself
        } needed[] = {
            {out.descriptor, "CGVirtualDisplayDescriptor", nullptr},
            {out.settings, "CGVirtualDisplaySettings", nullptr},
            {out.mode, "CGVirtualDisplayMode", nullptr},
            {out.display, "CGVirtualDisplay", nullptr},
            {out.mode, "-[CGVirtualDisplayMode initWithWidth:height:refreshRate:]",
             "initWithWidth:height:refreshRate:"},
            {out.display, "-[CGVirtualDisplay initWithDescriptor:]", "initWithDescriptor:"},
            {out.display, "-[CGVirtualDisplay applySettings:]", "applySettings:"},
            {out.display, "-[CGVirtualDisplay displayID]", "displayID"},
        };
        for (const auto& n : needed) {
            const bool ok =
                n.cls &&
                (!n.selector || [n.cls instancesRespondToSelector:sel_registerName(n.selector)]);
            if (!ok) {
                out.missing = n.what;
                break;
            }
        }
        return out;
    }();
    return c;
}

// The private setters are ordinary properties: key-value coding reaches every
// one of them, boxing the scalars itself, without a cast per type.
void setKey(id object, const char* key, id value)
{
    [object setValue:value forKey:[NSString stringWithUTF8String:key]];
}

} // namespace

bool isSupported()
{
    return classes().missing.empty();
}

std::string unsupportedReason()
{
    const Classes& c = classes();
    if (c.missing.empty()) return std::string();
    return "this macOS has no " + c.missing + " (the virtual display API changed)";
}

bool create(const Spec& spec, std::string* error)
{
    if (!isSupported()) {
        if (error) *error = unsupportedReason();
        return false;
    }
    if (spec.width <= 0 || spec.height <= 0 || spec.refreshHz <= 0) {
        if (error) *error = "invalid mode";
        return false;
    }
    destroy();

    const Classes& c = classes();
    @autoreleasepool {
        id descriptor = [[[c.descriptor alloc] init] autorelease];
        if (!descriptor) {
            if (error) *error = "CGVirtualDisplayDescriptor could not be created";
            return false;
        }
        setKey(descriptor, "name", [NSString stringWithUTF8String:spec.name.c_str()]);
        setKey(descriptor, "maxPixelsWide", @(static_cast<uint32_t>(spec.width)));
        setKey(descriptor, "maxPixelsHigh", @(static_cast<uint32_t>(spec.height)));
        // A physical size that makes the density about 96 dpi — a monitor,
        // not a phone — so the desktop is legible at 1:1 (no HiDPI: the mode's
        // pixels are the pixels streamed, which is what the admin chose).
        const CGSize mm = CGSizeMake(spec.width * 25.4 / 96.0, spec.height * 25.4 / 96.0);
        setKey(descriptor, "sizeInMillimeters", [NSValue valueWithSize:NSSizeFromCGSize(mm)]);
        setKey(descriptor, "productID", @(kProductId));
        setKey(descriptor, "vendorID", @(kVendorId));
        setKey(descriptor, "serialNum", @(kSerial));
        if (spec.hdr) {
            // BT.2020 primaries, D65 white: without them the HDR mode below
            // takes the display down (a crash in the probe on mw-mac).
            setKey(descriptor, "redPrimary", [NSValue valueWithPoint:NSMakePoint(0.708, 0.292)]);
            setKey(descriptor, "greenPrimary", [NSValue valueWithPoint:NSMakePoint(0.170, 0.797)]);
            setKey(descriptor, "bluePrimary", [NSValue valueWithPoint:NSMakePoint(0.131, 0.046)]);
            setKey(descriptor, "whitePoint", [NSValue valueWithPoint:NSMakePoint(0.3127, 0.3290)]);
        }
        // The queue the descriptor's callbacks (termination) are delivered on.
        // Private selectors are named, never written as a selector literal:
        // the compiler has no declaration for them and would (rightly) warn.
        const SEL setDispatchQueue = sel_registerName("setDispatchQueue:");
        if ([descriptor respondsToSelector:setDispatchQueue]) {
            [descriptor performSelector:setDispatchQueue withObject:(id)dispatch_get_main_queue()];
        }

        using InitWithDescriptor = id (*)(id, SEL, id);
        id display = reinterpret_cast<InitWithDescriptor>(objc_msgSend)(
            [c.display alloc], sel_registerName("initWithDescriptor:"), descriptor);
        if (!display) {
            if (error) *error = "CGVirtualDisplay refused the descriptor";
            return false;
        }

        // Transfer function 1 is the one that gives the display EDR headroom
        // (Spec::hdr). An OS without the four-argument initialiser gets the
        // SDR display it always had.
        const SEL initHdr = sel_registerName("initWithWidth:height:refreshRate:transferFunction:");
        id mode = nil;
        if (spec.hdr && [c.mode instancesRespondToSelector:initHdr]) {
            using InitModeTf = id (*)(id, SEL, uint32_t, uint32_t, double, uint32_t);
            mode = reinterpret_cast<InitModeTf>(objc_msgSend)(
                [c.mode alloc], initHdr, static_cast<uint32_t>(spec.width),
                static_cast<uint32_t>(spec.height), static_cast<double>(spec.refreshHz), 1u);
        } else {
            if (spec.hdr)
                log::info("[native] virtual display: this macOS has no HDR display mode — SDR");
            using InitMode = id (*)(id, SEL, uint32_t, uint32_t, double);
            mode = reinterpret_cast<InitMode>(objc_msgSend)(
                [c.mode alloc], sel_registerName("initWithWidth:height:refreshRate:"),
                static_cast<uint32_t>(spec.width), static_cast<uint32_t>(spec.height),
                static_cast<double>(spec.refreshHz));
        }
        [mode autorelease];
        id settings = [[[c.settings alloc] init] autorelease];
        setKey(settings, "hiDPI", @0u);
        setKey(settings, "modes", @[ mode ]);

        using ApplySettings = BOOL (*)(id, SEL, id);
        const BOOL applied = reinterpret_cast<ApplySettings>(objc_msgSend)(
            display, sel_registerName("applySettings:"), settings);
        if (!applied) {
            [display release];
            if (error) *error = "CGVirtualDisplay rejected the mode";
            return false;
        }

        g_display = display; // +1 from init: this is the retain that keeps it alive
        g_displayId = [[display valueForKey:@"displayID"] unsignedIntValue];
        log::info("[native] virtual display created: id " + std::to_string(g_displayId) + ", " +
                  std::to_string(spec.width) + "x" + std::to_string(spec.height) + " @ " +
                  std::to_string(spec.refreshHz) + " Hz" + (spec.hdr ? ", HDR (EDR)" : ""));
    }
    return true;
}

void destroy()
{
    if (!g_display) return;
    log::info("[native] virtual display released: id " + std::to_string(g_displayId));
    [g_display release];
    g_display = nil;
    g_displayId = 0;
}

bool isActive()
{
    return g_display != nil;
}

bool isOnline()
{
    if (!g_display) return false;
    CGDirectDisplayID ids[32];
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(32, ids, &count) != kCGErrorSuccess) return false;
    for (uint32_t i = 0; i < count; ++i)
        if (ids[i] == g_displayId) return true;
    return false;
}

uint32_t displayId()
{
    return g_displayId;
}

uint32_t mainDisplay()
{
    return CGMainDisplayID();
}

bool setMain(uint32_t displayId, std::string* error)
{
    // The main display is the one whose origin is (0,0). Asking for that
    // origin alone is not enough — the current main keeps (0,0) and wins —
    // so every online display is moved by the same offset in one transaction,
    // which lands ours on (0,0) and keeps the layout's shape (BetterDisplay's
    // recipe). Scoped to the session: a crash leaves nothing in the OS'
    // preferences, and the caller restores the previous main itself.
    if (CGDisplayIsMain(displayId)) return true;
    CGDirectDisplayID ids[32];
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(32, ids, &count) != kCGErrorSuccess) {
        if (error) *error = "CGGetOnlineDisplayList failed";
        return false;
    }
    const CGRect target = CGDisplayBounds(displayId);
    CGDisplayConfigRef config = nullptr;
    CGError err = CGBeginDisplayConfiguration(&config);
    if (err != kCGErrorSuccess) {
        if (error) *error = "CGBeginDisplayConfiguration failed: " + std::to_string(err);
        return false;
    }
    for (uint32_t i = 0; i < count; ++i) {
        const CGRect b = CGDisplayBounds(ids[i]);
        err = CGConfigureDisplayOrigin(config, ids[i],
                                       static_cast<int32_t>(b.origin.x - target.origin.x),
                                       static_cast<int32_t>(b.origin.y - target.origin.y));
        if (err != kCGErrorSuccess) {
            CGCancelDisplayConfiguration(config);
            if (error)
                *error = "CGConfigureDisplayOrigin(" + std::to_string(ids[i]) +
                         ") failed: " + std::to_string(err);
            return false;
        }
    }
    err = CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
    if (err != kCGErrorSuccess) {
        if (error) *error = "CGCompleteDisplayConfiguration failed: " + std::to_string(err);
        return false;
    }
    if (!CGDisplayIsMain(displayId)) {
        if (error) *error = "the OS kept its main display";
        return false;
    }
    log::info("[native] display " + std::to_string(displayId) + " is now the main display");
    return true;
}

} // namespace mw::native::vdisplay
