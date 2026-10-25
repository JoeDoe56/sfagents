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

#include <cstring>

// How a GPU conversion pass brings the picture down to a smaller stream — the
// one vocabulary shared by ColorConvert (D3D11) and GlConvert (EGL), and by
// the MW_SCALER override both read.
//
// Measured with tools/scaler-bench on 17/09/2026 (docs/bench-native-host.md
// §8j): the one-fetch bilinear the passes always had is a 2-texel tent whatever
// the ratio — at 1440p → 1080p it leaves ten times the aliasing energy of a
// real low-pass in the picture (flicker 0.159 vs 0.017), the shimmer of
// scrolling text and the residual the encoder pays for. A Lanczos-2 dilated to
// the ratio, separable, in linear light, is within 1 dB of the reference at
// every ratio for a few hundred microseconds on a discrete GPU. Which one a
// session gets is the platform session's call, by tier.

namespace mw::native::convert {

enum class ScaleFilter
{
    /// The scale rides in the conversion pass: one linear fetch. What the
    /// passes always did, and what a 1:1 stream still gets.
    Bilinear,
    /// A separate resample first — Lanczos-2, kernel stretched to the
    /// reduction ratio, horizontal then vertical, in linear light — into an
    /// output-sized picture the conversion then reads 1:1. Also what makes
    /// the 4:2:0 chroma a true 2x2 average, and a frame of another shape
    /// letterboxed rather than stretched.
    Lanczos2,
};

inline const char* toString(ScaleFilter filter)
{
    return filter == ScaleFilter::Lanczos2 ? "lanczos2" : "bilinear";
}

/// The MW_SCALER override, as typed: `bilinear` or `lanczos2`, either case.
/// Anything else — including nothing — leaves @p filter alone and returns
/// false, so the caller can say so in the log rather than guess.
inline bool parseScaleFilter(const char* value, ScaleFilter& filter)
{
    if (!value || !*value) return false;
    auto equalsIgnoringCase = [](const char* a, const char* b) {
        for (; *a && *b; ++a, ++b) {
            const char ca = (*a >= 'A' && *a <= 'Z') ? static_cast<char>(*a + 32) : *a;
            if (ca != *b) return false;
        }
        return *a == '\0' && *b == '\0';
    };
    if (equalsIgnoringCase(value, "bilinear")) {
        filter = ScaleFilter::Bilinear;
        return true;
    }
    if (equalsIgnoringCase(value, "lanczos2")) {
        filter = ScaleFilter::Lanczos2;
        return true;
    }
    return false;
}

} // namespace mw::native::convert
