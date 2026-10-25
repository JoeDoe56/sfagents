/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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

/**
 * @brief Click-to-sound probe, host side: the latency flag's beep (plan « le son
 *        et la priorité des paquets », A1).
 *
 * The click-to-photon flag (LatencyFlag.h) times the picture; this times the
 * sound the same way. When the bench asks for it — MW_LATENCY_FLAG_SOUND in the
 * server's environment, never set by the product — the flag also plays a beep:
 * 20 ms of a 1 kHz tone on the default output, the one the stream captures.
 * The client's half (scripts/bench/photon/click-sound.cpp) hears it through its
 * own loopback and times click → sound, click → flag, and the gap between the
 * two, which is the stream's lip-sync offset.
 *
 *   - `click`: a beep with every flag an injected click raises;
 *   - `tick`: no click needed — beep and flag together every 500 ms, for the
 *     offset alone (the client pairs each beep with its flag).
 *
 * MW_LATENCY_BEEP=noise plays white noise instead of the tone: a pure tone is
 * what NetEq's time stretching shortens best when it catches up on a grown
 * buffer, noise gives it nothing to cut.
 *
 * The output stream is opened once, when the flag starts, and kept running on
 * silence: opening one per beep would add its own start-up to every figure.
 * Each beep is logged twice on the steady clock the relay stamps with — when
 * it was asked for, and when its first sample went into the output buffer with
 * how much was queued ahead of it — so a pass can split the host's own share
 * (beep → its capture, from `audiolog=1`) from the rest.
 *
 * Windows only; elsewhere every call is inert.
 */
namespace LatencyBeep {

enum class Mode
{
    Off,
    Click,
    Tick,
};

/// The bench's choice, from MW_LATENCY_FLAG_SOUND: `click`, `tick`, or off.
Mode modeFromEnvironment();

/// Opens the output stream and its thread. False (and logged) when the
/// default output cannot be opened, or on another platform.
bool start();

/// Closes them. Idempotent.
void stop();

/// The next output period carries a beep. Any thread.
void beep();

} // namespace LatencyBeep
