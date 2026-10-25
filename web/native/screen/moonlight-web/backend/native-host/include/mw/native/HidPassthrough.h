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

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

/// The HID passthrough (docs/design/hid-passthrough-study.md, plan P2): a game
/// device the browser reads through WebHID is recreated on this host, same
/// vendor and product, same reports, so a game sees the real wheel or radio
/// rather than an Xbox pad.
///
/// The page sends the device's `collections` (WebHID's description of its
/// report descriptor, which the browser never shows) and then its input
/// reports. The relay reads the collections into the structures below;
/// HidPassthrough rebuilds the descriptor, checks it and creates the device.

namespace mw::native::input::hid {

/// HID unit systems, as the low nibble of the Unit item.
enum class UnitSystem : uint8_t
{
    None = 0x0,
    SiLinear = 0x1,
    SiRotation = 0x2,
    EnglishLinear = 0x3,
    EnglishRotation = 0x4,
    Vendor = 0xF,
};

/// One main item of a report, as WebHID's HIDReportItem shows it. Usages are
/// extended: usage page in the high 16 bits, usage id in the low 16.
struct ReportItem
{
    bool isAbsolute = true;
    bool isArray = false;
    bool isBufferedBytes = false;
    bool isConstant = false;
    bool isLinear = true;
    bool isRange = false;
    bool isVolatile = false;
    bool hasNull = false;
    bool hasPreferredState = true;
    bool wrap = false;
    std::vector<uint32_t> usages;
    uint32_t usageMinimum = 0;
    uint32_t usageMaximum = 0;
    uint16_t reportSize = 0;
    uint16_t reportCount = 0;
    int8_t unitExponent = 0;
    UnitSystem unitSystem = UnitSystem::None;
    /// Length, mass, time, temperature, current, luminous intensity.
    int8_t unitFactors[6] = {0, 0, 0, 0, 0, 0};
    int32_t logicalMinimum = 0;
    int32_t logicalMaximum = 0;
    int32_t physicalMinimum = 0;
    int32_t physicalMaximum = 0;
};

struct Report
{
    uint8_t reportId = 0;
    std::vector<ReportItem> items;
};

/// HID collection types (Collection item data).
enum CollectionType : uint8_t
{
    Physical = 0x00,
    Application = 0x01,
    Logical = 0x02,
};

/// WebHID's HIDCollectionInfo: the items directly inside the collection, by
/// report and kind, then its child collections.
struct Collection
{
    uint16_t usagePage = 0;
    uint16_t usage = 0;
    uint8_t type = Application;
    std::vector<Collection> children;
    std::vector<Report> inputReports;
    std::vector<Report> outputReports;
    std::vector<Report> featureReports;
};

} // namespace mw::native::input::hid

namespace mw::native {

namespace input {
class IVirtualHid;
}

/// A device as the page describes it.
struct HidDeviceInfo
{
    std::string name;
    uint16_t vendorId = 0;
    uint16_t productId = 0;
    uint16_t version = 0;
    std::vector<input::hid::Collection> collections;
    /// The page can play force feedback on the real device (it found a way to
    /// drive its motor, e.g. Logitech's HID++ 0x8123): the recreated device
    /// gets a PID block, and what games ask of it comes back as HidFfb.
    bool forceFeedback = false;
};

/// What the host's OS asked of a recreated device, for the page to pass on.
struct HidRequest
{
    enum class Kind
    {
        Output,
        GetFeature,
        SetFeature
    };
    int slot = 0;
    Kind kind = Kind::Output;
    uint8_t reportId = 0;
    std::vector<uint8_t> data;
};

/// One force-feedback operation a game asked of a recreated device, decoded
/// from the PID reports pid.dll wrote (input/HidPid.h), for the page to play on
/// the real wheel. Levels use DirectInput's scale, -10000..10000; times are in
/// milliseconds; angles in hundredths of a degree.
///  - "effect": an effect's header; `kind` is constant, ramp, square, sine,
///    triangle, sawtoothUp, sawtoothDown, spring, damper, inertia or friction;
///    fields duration (-1 = infinite), delay, gain (0..255), direction,
///    directionEnable (0: apply along the enabled axes as is), axes (bit 0 X,
///    bit 1 Y);
///  - "envelope": attackLevel, attackTime, fadeLevel, fadeTime;
///  - "condition": axis, offset, positiveCoefficient, negativeCoefficient,
///    positiveSaturation, negativeSaturation, deadBand;
///  - "periodic": magnitude, offset, phase, period;
///  - "constant": magnitude;  "ramp": start, end;
///  - "start" (loops), "solo" (loops: stop the others first), "stop", "free";
///  - "gain": gain (0..255, the device's master gain);
///  - "control": `kind` enable, disable, stopAll, reset, pause or continue.
/// `effect` is the effect block (1..40), 0 for gain and control.
struct HidFfb
{
    int slot = 0;
    std::string op;
    int effect = 0;
    std::string kind;
    std::vector<std::pair<std::string, int32_t>> fields;
};

/// A recreated device no stream holds, as it crosses to another process
/// (HidParking::handOut, takeIn): what it is, where it rests, and its force
/// feedback as the game left it.
struct HidParkedState
{
    std::string name;
    uint16_t vendorId = 0;
    uint16_t productId = 0;
    uint16_t version = 0;
    std::vector<uint8_t> descriptor;
    /// Per input report id, without the id byte: the device's first report
    /// (where its pedals rest) and its last.
    std::vector<std::pair<uint8_t, std::vector<uint8_t>>> first;
    std::vector<std::pair<uint8_t, std::vector<uint8_t>>> last;
    /// The PID block (0: none) and its effect block table (PidEngine::save).
    uint8_t pidFirstId = 0;
    std::vector<uint8_t> pidState;
    /// What rebuilds its force feedback on a fresh player (FfbJournal::replay).
    std::vector<HidFfb> effects;
    /// How much longer it may wait for a stream to take it.
    int64_t keepMs = 0;
};

/// One device handed out: `handle` is its OS handle in the process that hands
/// it out (see IVirtualHid::nativeHandle).
struct HidHandedDevice
{
    uint64_t handle = 0;
    HidParkedState state;
};

class HidPassthrough;

/// The recreated devices no stream holds (plan « garder le volant », Bruno's
/// choice of 11/10/2026): a game left running between two streams keeps its
/// wheel, and the force feedback it set up on it. Recreating the device would
/// give the game a new one: DirectInput keeps its effects on the old, and the
/// wheel would steer without a motor until the game restarts.
///
/// A stream that ends parks its devices here, at rest, still answering the
/// game (the PID block's questions, the effects it keeps writing, which the
/// journal remembers). The next stream's page attaching the same device —
/// same descriptor, ids and name — takes it back: no new device, the slot's
/// sequence numbers start over, and the journal's operations go to the page
/// first so its player knows every effect the game still drives.
///
/// Each stream runs in a process of its own, so the parking crosses
/// processes: the stream's worker hands its devices out (handOut, their OS
/// handles duplicated into the server), the server keeps them (takeIn), and
/// hands them to the next worker the same way. The server, not elevated, then
/// holds a handle to a game device already made: it can feed it reports and
/// answer it, never make another device nor change this one's descriptor (the
/// driver refuses both once a device exists). Windows only for now: a uhid or
/// uinput device stays in its process, and goes with it.
///
/// Policy, in one place: a parked device waits kKeepMs for a stream; in a
/// stream's process, one the page has not taken within kUnclaimedMs goes (the
/// stream has no use for it, and a game might pick it over the user's pad);
/// an explicit detach (device unplugged, « As itself » switched off) removes
/// a device at once and never parks it.
class HidParking
{
public:
    static constexpr int64_t kKeepMs = 10 * 60 * 1000;
    static constexpr int64_t kUnclaimedMs = 30 * 1000;

    using Clock = std::function<int64_t()>; // milliseconds, monotonic

    /// `clock` for tests (the steady clock otherwise); `ownThread` lets
    /// expired devices go every second, else the caller calls expire().
    explicit HidParking(Clock clock = nullptr, bool ownThread = false);
    ~HidParking();
    HidParking(const HidParking&) = delete;
    HidParking& operator=(const HidParking&) = delete;

    /// This process's parking, with its own thread.
    static HidParking& process();

    /// Devices here, handed out ones included.
    size_t size() const;
    void expire(int64_t nowMs);

    /// Every device that can cross processes, paused (no longer answering the
    /// game) and listed with its state; they stay here, handed out, until
    /// settle(). Returns the batch, 0 when nothing was handed out.
    uint64_t handOut(std::vector<HidHandedDevice>& out);
    /// `taken`: the other process holds the batch now, this one lets go of its
    /// copies. Otherwise they answer the game here again.
    void settle(uint64_t batch, bool taken);

    /// A device another process handed out: `handle` is this process's copy,
    /// owned from here on, closed on failure. `unclaimedMs`: in a stream's
    /// process, how long the page has to take it (0: the server, no limit).
    /// Empty on success, otherwise why not.
    std::string takeIn(uint64_t handle, const HidParkedState& state, int64_t unclaimedMs);
    /// The same with the backend already made (tests).
    std::string takeIn(std::unique_ptr<input::IVirtualHid> device, const HidParkedState& state,
                       int64_t unclaimedMs);

private:
    friend class HidPassthrough;
    struct Entry;
    void park(std::unique_ptr<Entry> entry);
    std::unique_ptr<Entry> claim(const std::string& name, uint16_t vendorId, uint16_t productId,
                                 uint16_t version, const std::vector<uint8_t>& descriptor);
    void run();
    void logRequests();

    Clock m_clock;
    mutable std::mutex m_mutex;
    std::vector<std::unique_ptr<Entry>> m_entries;
    uint64_t m_nextBatch = 1;
    std::atomic<bool> m_stop{false};
    std::thread m_thread;
};

/// The devices one stream session recreates. Thread-safe: attach and detach
/// come from the relay's input handler, input() from the `hid` channel's
/// callback, requests leave from the backends' threads.
///
/// Policy, in one place:
///  - at most kMaxSlots devices, each checked by hid::validate() first;
///  - an input report of the wrong size for its id is dropped, as is one older
///    than the newest already applied (the channel is unordered);
///  - after kSilenceMs without a report, each input report goes back to rest
///    once: buttons up, hats centred, sticks and wheels centred, pedals and
///    throttles at their rest end, read from the device's first report when
///    its usages do not say (hid::restReport, Bruno's rule of 04/10);
///  - with a parking (setParking), the devices still here when this ends go
///    there at rest, and attach() takes a parked one back before making one.
class HidPassthrough
{
public:
    static constexpr int kMaxSlots = 8;
    static constexpr int kSilenceMs = 3000;

    using RequestSink = std::function<void(const HidRequest&)>;
    using FfbSink = std::function<void(const HidFfb&)>;
    using Factory = std::function<std::unique_ptr<input::IVirtualHid>()>;
    using Clock = std::function<int64_t()>; // milliseconds, monotonic

    /// `factory` and `clock` are for tests; by default the OS's backend and
    /// the steady clock.
    explicit HidPassthrough(RequestSink onRequest, Factory factory = nullptr,
                            Clock clock = nullptr);
    ~HidPassthrough();
    HidPassthrough(const HidPassthrough&) = delete;
    HidPassthrough& operator=(const HidPassthrough&) = delete;

    /// Where force-feedback operations go; set before the first attach. Called
    /// on a backend thread, never under this object's lock.
    void setFfbSink(FfbSink sink) { m_onFfb = std::move(sink); }
    /// Where devices go when this ends, and come back from; set before the
    /// first attach. None: they are removed with this, as before.
    void setParking(HidParking* parking) { m_parking = parking; }

    /// Empty when this host can recreate devices; why not otherwise.
    static std::string unavailableReason();
    /// What the hosts page shows on the « As itself » switch, before any
    /// stream: "ok"; "driver_missing" (Windows without MoonlightWeb Virtual
    /// HID); "setup" (Linux without uhid access); "unsupported" (macOS).
    static const char* supportToken();
    /// Whether a recreated wheel can carry force feedback on this host now
    /// (announced to the page in hidcaps.ffb).
    static bool forceFeedbackAvailable();

    /// Empty on success; otherwise why the device was refused (for the log and
    /// the page). A slot already in use is replaced. A parked device of the
    /// same identity is taken back rather than a new one made.
    std::string attach(int slot, const HidDeviceInfo& device);
    /// Once the page knows the device is there (it answered hidattached): a
    /// device taken back from the parking sends what rebuilds its force
    /// feedback, through the FfbSink. Nothing for a new one.
    void attached(int slot);
    /// One frame of the `hid` channel's payload: report id, sequence number and
    /// the report as WebHID gives it (without its id byte).
    void input(int slot, uint8_t reportId, uint16_t seq, const uint8_t* bytes, size_t size);
    /// The real device's answer to a request the host's OS made (a Logitech
    /// HID++ reply the page relayed, plan P4 under Linux), injected once as it
    /// came: no sequence number, never repeated, never put to rest. Ignored when
    /// the device has no input report of that id and size.
    void reply(int slot, uint8_t reportId, const uint8_t* bytes, size_t size);
    void detach(int slot);
    void detachAll();

    /// For the watchdog's thread and the tests: puts silent devices to rest.
    void checkSilence(int64_t nowMs);

private:
    friend class HidParking;
    struct Route;
    struct Slot;
    static void wire(input::IVirtualHid& device, const std::shared_ptr<Route>& route);
    void watchdog();
    /// Every 5 s, for each device: logged when the game starts or stops asking,
    /// when a get feature went unanswered, and whenever its requests are no
    /// longer serviced (a game waiting on an unanswered one stalls).
    void logRequests();
    /// The line for what the route counted since the last look, empty when
    /// nothing changed; resets the counts.
    static std::string requestSummary(Route& route, bool servicing);
    /// Requests logged one by one after a device is made or taken back, the
    /// game's force feedback setting up; an output repeating the last one's
    /// report id is not.
    static constexpr int kTraceRequests = 64;

    RequestSink m_onRequest;
    FfbSink m_onFfb;
    Factory m_factory;
    Clock m_clock;
    HidParking* m_parking = nullptr;
    std::mutex m_mutex;
    std::map<int, std::unique_ptr<Slot>> m_slots;
    std::atomic<bool> m_stop{false};
    std::thread m_watchdog;
};

} // namespace mw::native
