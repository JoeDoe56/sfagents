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

#include "RateControl.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace mw::native::encode {

/// Our own rate control (plan pipeline-video-d3d12-v2, §4.6): a QP for every
/// picture, handed to an encoder told a constant QP.
///
/// ── Why one of our own ──────────────────────────────────────────────────────
///
/// D3D12 Video Encode on the Arc takes its bitrate once, when the encoder is
/// made: the governor, the frame-rate scaling and the still-screen boost all
/// move the target through setBitrate(), and the driver refused every one of
/// those moves — a still screen stayed at the first bitrate's ~33 KB a pass
/// and never sharpened (27/09/2026, bench §8n.5). The delta-QP map that would
/// have carried a controller of ours is refused at EncodeFrame by the
/// runtime's second look (plan §4.6). What the Arc does do is code each
/// picture at a constant QP changed since the last one, without being told,
/// and say which QP it used: that is the lever, and this is what moves it.
/// Anywhere else it runs as a witness only (the bench's rc12=qp).
///
/// ── The model, and why its slope is learned ─────────────────────────────────
///
/// Around the QP it was last coded at, a picture's size falls by half for
/// every k of QP: log2(bits) = level − (QP − anchor) / k. The textbook k is
/// 6 — the quantizer's step doubles — and it holds for a game: the Call of
/// Duty clip on the bench held its rate to a few percent with it. It does not
/// hold for a page of text scrolling: on the Arc, 162 KB at QP 24 and next to
/// nothing at QP 36 (27/09/2026) — the residual of an edge that moved either
/// clears the quantizer or does not. There k is nearer 2, and a model that
/// believes 6 swings between pictures four times their budget and empty ones.
/// So k is read off the pictures: two new pictures whose QPs differ by two or
/// more, and whose sizes moved the other way, give a secant; the slope moves
/// a third of the way to it, between 1.5 and 9. A picture coded again for an
/// overshoot gives the cleanest secant there is: the same picture at two QPs.
///
/// The level is anchored at the last new picture's QP and moved there after
/// each one, so the model never reaches far from where it was measured. It
/// is smoothed, half the old and half the new, so that one noisy picture moves
/// the QP by a step or two; two pictures in a row it missed the same way by
/// more than twice — a new scene, a window opened — replace it outright. One
/// alone does not: at 120 fps a scroll captured with two presents folded
/// costs 2.5 times the next, and a model replaced by each in turn codes each
/// at the QP the other needed. A picture of a few hundred bytes
/// says little: at a QP above what the content needs, P pictures are skipped
/// nearly whole and cost the same whatever the QP. It may lower the level by
/// half at most, and teaches no slope.
///
/// ── The budget ──────────────────────────────────────────────────────────────
///
/// A bucket, the VBV's: every picture pours its bits in, the link takes a
/// frame's worth (bitrate / fps) out before the next one, and it never holds
/// less than nothing — a link left idle is capacity gone, not saved. What is
/// in it is time the next picture waits behind on the wire. So a predicted
/// picture's budget is a frame's worth less half of what is in the bucket (a
/// backlog is paid back in halves), and an intra picture's is the VBV itself,
/// by the rule every encoder follows (RateControl.h). Never below an eighth of
/// a frame's worth: there the QP is at the top of its range anyway.
///
/// ── Up at once, down in steps ──────────────────────────────────────────────
///
/// Latency first. A picture over its budget delays every picture behind it
/// and one under it delays nothing, so the two errors are not worth the same:
/// the QP rises as far as the model says at once, and falls by 3 at most per
/// new picture when pictures got cheaper — a menu over a game, a camera at
/// rest — because the next one may well cost what they used to. The brake is
/// on what the model believes, not on the QP: a budget that grows (the
/// governor, a backlog paid back) is known exactly and is followed on the
/// next picture, through the slope learned. One exception: a picture that
/// jumped far above the others, followed by one back where they were, was a
/// one-off — a cut, a flash, a page wrapping round — and the belief from
/// before it comes back whole, without the brake.
///
/// ── The same picture again ─────────────────────────────────────────────────
///
/// The still-screen passes and the idle floor encode the picture that already
/// went out, and every pass codes what the one before it left out: between the
/// picture's quantizer and its own, (2^((QP before − QP) / 6) − 1) of the
/// whole picture at the QP it has — the whole picture costs the same in the
/// end, however many passes it takes. So a pass is priced against that whole
/// picture, not as a picture of its own: priced as one, a page of text whose
/// first picture was three times its budget got no pass below that picture's
/// QP, and the burst ended there, "converged", at QP 42 (27/09/2026). Passes
/// keep that whole picture's complexity apart, started from the picture's own
/// and read again off every pass that refined, and it never moves the model
/// new pictures are sized by — the first movement after a sharpened desktop
/// is budgeted as movement, not as the nothing the last pass cost. A pass goes
/// down 6 at most (the step halves) and never above the QP the picture already
/// has: coded there, the residual is under the quantizer and the pass costs
/// next to nothing, which is what an idle-floor frame should cost. A light
/// picture reaches 18 in three to five passes; a heavy one at a low bitrate
/// reaches what RefineConvergence's cap of passes buys, and the idle floor
/// carries on from there.
///
/// ── What it does not do ────────────────────────────────────────────────────
///
/// It sees whole pictures: a picture far over its budget has gone out before
/// anything can be done about it. reencode() gives the QP that would have
/// fitted, for an encoder that can afford to code the picture again —
/// VideoEncode12 does, since the bench of 27/09/2026 (plan §9-5).
class QpRateController
{
public:
    /// The engine's floor, as on every encoder: below it a still picture
    /// spends bits on noise nobody sees.
    static constexpr int kMinQp = 18;
    static constexpr int kMaxQp = 51;
    /// Where intra complexity is measured.
    static constexpr int kPivotQp = 26;
    /// QP per halving of the size: the textbook step, and where a learned
    /// slope starts and stays bounded.
    static constexpr double kSlope = 6.0;
    static constexpr double kMinSlope = 1.5;
    static constexpr double kMaxSlope = 9.0;
    /// How far one secant moves the slope.
    static constexpr double kSlopeWeight = 1.0 / 3.0;
    /// How far apart two QPs must be for their sizes to say a slope: at 2, a
    /// game's ±23 % from one picture to the next moved the slope between 4.6
    /// and 7.8.
    static constexpr int kSlopeSpan = 3;
    /// The most the QP falls in one new picture, on the model's word alone.
    static constexpr int kNewPictureDrop = 3;
    /// The most one pass over the same picture sharpens it.
    static constexpr int kPassDrop = 6;
    /// log2 of how far a picture may miss before it replaces the estimate.
    static constexpr double kCut = 1.0;
    /// The budget's floor, as a share of a frame's worth.
    static constexpr int kMinBudgetShare = 8;
    /// A picture under this, or under 1/32 of a frame's worth, was skipped
    /// nearly whole: it says little of what the content costs.
    static constexpr uint64_t kTinyBits = 2048 * 8;
    /// No floor under intra (the bench's interfloor=k sets one at 1/2^k).
    static constexpr double kNoInterFloor = -1000.0;
    /// A picture this many times over its budget — and over the VBV — is the
    /// overshoot the bench counts and VideoEncode12 codes again.
    static constexpr double kStrongOvershoot = 2.5;
    /// Under the fitting rule (setReencodeFit), the first try at such a
    /// picture aims at this many budgets — under the overshoot line, where
    /// every picture the controller lets through already sits — through the
    /// slope learned, never shallower than kReencodeMinSlope.
    static constexpr double kReencodeAim = 2.0;
    static constexpr double kReencodeMinSlope = 3.0;
    /// Before the first intra picture: bits per pixel at QP 26. A desktop of
    /// text sits at or below it — high on purpose: a first picture under its
    /// budget costs a pass of refinement, one over it a stall.
    static constexpr double kIntraBitsPerPixel = 1.0;
    /// Before the first new predicted picture: a third of the intra one, log2.
    static constexpr double kInterShare = -1.585;

    enum class Kind
    {
        Intra, ///< an IDR, new picture or not
        Inter, ///< a new picture, predicted
        Pass,  ///< the same picture again: a still-screen pass, the idle floor
    };

    /// What one picture is to be coded at, and against what budget.
    struct Picture
    {
        Kind kind = Kind::Inter;
        int qp = kPivotQp;
        uint64_t budgetBits = 0;
    };

    /// A session starts: @p bitsPerSecond at @p fps, the VBV by the shared
    /// rule (or @p vbvFrames frames' worth, the bench's vbv=), for pictures
    /// of @p pixels. @p interFloor: a new picture is never believed to cost
    /// under intra × 2^interFloor (the bench's interfloor=); none by default.
    void start(uint32_t bitsPerSecond, int fps, int vbvFrames, uint64_t pixels,
               double interFloor = kNoInterFloor)
    {
        const bool fit = m_ReencodeFit;
        *this = QpRateController{};
        m_ReencodeFit = fit;
        m_Fps = fps > 0 ? fps : 60;
        m_VbvFrames = vbvFrames;
        m_InterFloor = interFloor;
        setBitrate(bitsPerSecond);
        const double px = static_cast<double>(pixels > 0 ? pixels : 1);
        m_Intra = std::log2(px * kIntraBitsPerPixel);
        m_AnchorQp = kPivotQp;
        m_Level = m_Held = m_Intra + kInterShare;
    }

    /// A new target, from the next picture on — no new sequence, no IDR. The
    /// bucket keeps what it holds: those bits are on the wire whatever the
    /// rate now is.
    void setBitrate(uint32_t bitsPerSecond)
    {
        const uint32_t bps = bitsPerSecond > 0 ? bitsPerSecond : 1000;
        m_FrameBits = (std::max)(uint64_t(bps / static_cast<uint32_t>(m_Fps)), uint64_t(1));
        m_VbvBits = (std::max)(uint64_t(vbvBits(bps, m_Fps, m_VbvFrames)), m_FrameBits);
    }

    /// The QP of the next picture: an IDR (@p intra), or a predicted one —
    /// new (@p newPicture) or the same picture as the last one encoded. One
    /// call per picture encoded: the rounding of new pictures carries over.
    Picture plan(bool intra, bool newPicture)
    {
        Picture p;
        const double left = static_cast<double>(m_Fullness) / 2.0;
        if (intra) {
            p.kind = Kind::Intra;
            p.budgetBits = budget(static_cast<double>(m_VbvBits) - left);
            // An intra picture costs at least what a predicted one of the same
            // content does: the intra estimate may be from another screen.
            const double inter = believed() + (m_AnchorQp - kPivotQp) / kSlope;
            p.qp = clampQp(kPivotQp + kSlope * ((std::max)(m_Intra, inter) - log2Of(p.budgetBits)));
            return p;
        }
        p.budgetBits = budget(static_cast<double>(m_FrameBits) - left);
        if (newPicture || !m_HavePicture) {
            p.kind = Kind::Inter;
            // The fraction rounding leaves goes to the next picture, so a
            // steady picture does not sit half a step off its budget for good:
            // the bucket catches a picture over it, nothing catches one under.
            const double wanted =
                m_AnchorQp + m_Slope * (believed() - log2Of(p.budgetBits)) + m_Carry;
            p.qp = clampQp(wanted);
            m_Carry = (p.qp == kMinQp || p.qp == kMaxQp) ? 0.0 : wanted - p.qp;
            return p;
        }
        p.kind = Kind::Pass;
        p.qp = passQp(p.budgetBits);
        return p;
    }

    /// @p p, a picture over its budget, was not sent: it is coded again (at
    /// reencode()'s QP), and what it cost at its own QP is the model's to
    /// learn from, not the bucket's. encoded() follows, for the picture sent.
    void overshot(const Picture& p, uint64_t bits)
    {
        switch (p.kind) {
        case Kind::Inter:
            learnNew(p.qp, bits);
            m_AgainOf = true;
            break;
        case Kind::Pass:
            // What the whole picture costs, as the try says it; the picture
            // on screen is still the one before the try.
            if (p.qp < m_PictureQp) m_Pass = passWhole(p.qp, bits);
            break;
        case Kind::Intra: break;
        }
    }

    /// @p p went out at @p bits.
    void encoded(const Picture& p, uint64_t bits)
    {
        const int64_t level = static_cast<int64_t>(m_Fullness) + static_cast<int64_t>(bits) -
                              static_cast<int64_t>(m_FrameBits);
        m_Fullness = level > 0 ? static_cast<uint64_t>(level) : 0;
        switch (p.kind) {
        case Kind::Intra: {
            const double measured = pivotComplexity(p.qp, bits);
            // The first measure replaces the guess, whatever the distance.
            m_Intra = m_IntraSeen ? learn(m_Intra, measured) : measured;
            m_IntraSeen = true;
            m_Spike = false;
            // Until a new picture has been measured, what one costs is only
            // known through the intra one: the guess follows it.
            if (!m_InterSeen) {
                m_AnchorQp = p.qp;
                m_Level = m_Held =
                    std::log2(static_cast<double>((std::max)(bits, uint64_t(1)))) + kInterShare;
            }
            startPicture(p.qp, measured);
            break;
        }
        case Kind::Inter:
            learnNew(p.qp, bits);
            m_AgainOf = false;
            startPicture(p.qp, pivotComplexity(p.qp, bits));
            break;
        case Kind::Pass:
            // A pass at the picture's own QP refined nothing, and its size
            // says nothing of what refining costs. One below it coded its
            // share of the whole picture: what it cost says what the whole
            // does.
            if (p.qp < m_PictureQp) {
                m_Pass = passWhole(p.qp, bits);
                m_PictureQp = p.qp;
            }
            break;
        }
        ++m_Pictures;
        m_QpSum += static_cast<uint64_t>(p.qp);
        if (strongOvershoot(p, bits)) ++m_StrongOvershoots;
    }

    /// Whether @p bits is far enough over @p p's budget that coding the
    /// picture again would be worth it.
    bool strongOvershoot(const Picture& p, uint64_t bits) const
    {
        const double b = static_cast<double>(bits);
        return b > kStrongOvershoot * static_cast<double>(p.budgetBits) &&
               b > static_cast<double>(m_VbvBits);
    }

    /// @p p again, at the QP that would have fitted its budget, going by what
    /// it cost at its own — through the slope learned for a new picture,
    /// never shallower than the textbook's: coded again, a picture must land
    /// under its budget, and the one far over it is often another content —
    /// a whole new page in a scroll — whose curve is not the scroll's. A pass
    /// is planned again, off what overshot() learned the whole picture costs:
    /// a smaller step, or none where the budget buys none. Raised by the rule
    /// for new pictures, it went above the picture's QP, coded nothing and
    /// taught nothing, and the next pass tried the same step: a dense page
    /// stayed at its moving QP, every pass coded twice (27/09/2026).
    ///
    /// Under the fitting rule, a new picture's first try aims at kReencodeAim
    /// budgets through the slope learned (never under kReencodeMinSlope). On
    /// the N95, where Chrome scrolls in fits and starts and 14 % of the
    /// pictures were coded again, the textbook's try landed them at a fifth of
    /// their budget, bits no picture after them made up: the text ran at 0.75
    /// of its budget, 0.89 under this rule when replayed (bench §8n.8). A
    /// picture the first try leaves far over — a whole new page, whose curve
    /// is the textbook's — is worth a last one (lastTryWanted), @p lastTry.
    Picture reencode(const Picture& p, uint64_t bits, bool lastTry = false) const
    {
        Picture again = p;
        if (p.kind == Kind::Pass) {
            again.qp = (std::min)((std::max)(passQp(p.budgetBits), p.qp + 1), m_PictureQp);
            return again;
        }
        const bool fit = m_ReencodeFit && !lastTry && p.kind == Kind::Inter;
        const double aim = fit ? kReencodeAim : 1.0;
        const double over = static_cast<double>(bits) /
                            (aim * static_cast<double>((std::max)(p.budgetBits, uint64_t(1))));
        double slope = p.kind == Kind::Inter ? (std::max)(m_Slope, kSlope) : kSlope;
        if (fit) slope = (std::max)(m_Slope, kReencodeMinSlope);
        const int raise = static_cast<int>(std::ceil(slope * std::log2((std::max)(over, 1.0))));
        again.qp = (std::min)(kMaxQp, p.qp + (std::max)(raise, 1));
        return again;
    }

    /// Whether @p p — a new picture coded again under the fitting rule, and
    /// still @p bits — is far enough over to be worth a last try, by the
    /// textbook. Never without the fitting rule: its one try already is.
    bool lastTryWanted(const Picture& p, uint64_t bits) const
    {
        return m_ReencodeFit && p.kind == Kind::Inter && strongOvershoot(p, bits);
    }

    /// How a picture far over its budget is coded again (the bench's refit=,
    /// plan §9-14). Off: once, at its budget, by the textbook's slope. On: at
    /// kReencodeAim budgets by the slope learned, then by the textbook when
    /// that still lands far over — what VideoEncode12 asks since 28/09/2026,
    /// the controller alone starting off. Kept by start().
    void setReencodeFit(bool on) { m_ReencodeFit = on; }
    bool reencodeFit() const { return m_ReencodeFit; }

    uint64_t frameBits() const { return m_FrameBits; }
    uint64_t vbvCapacityBits() const { return m_VbvBits; }
    /// Bits still on the wire before the next picture's.
    uint64_t fullnessBits() const { return m_Fullness; }
    /// The QP the picture on screen has been sharpened to.
    int pictureQp() const { return m_PictureQp; }
    /// QP per halving of a new picture's size, as learned.
    double slope() const { return m_Slope; }

    int pictures() const { return m_Pictures; }
    int strongOvershoots() const { return m_StrongOvershoots; }
    double meanQp() const
    {
        return m_Pictures > 0 ? static_cast<double>(m_QpSum) / m_Pictures : 0.0;
    }

private:
    static double log2Of(uint64_t bits)
    {
        return std::log2(static_cast<double>((std::max)(bits, uint64_t(1))));
    }

    /// log2 of what a picture would cost at kPivotQp, by the textbook slope.
    static double pivotComplexity(int qp, uint64_t bits)
    {
        return log2Of(bits) + (qp - kPivotQp) / kSlope;
    }

    static int clampQp(double qp)
    {
        return std::clamp(static_cast<int>(std::lround(qp)), kMinQp, kMaxQp);
    }

    static double learn(double estimate, double measured)
    {
        return std::fabs(measured - estimate) > kCut ? measured : (estimate + measured) / 2.0;
    }

    uint64_t budget(double bits) const
    {
        const double floor = static_cast<double>(m_FrameBits) / kMinBudgetShare;
        return static_cast<uint64_t>((std::max)(bits, floor));
    }

    bool tiny(uint64_t bits) const { return bits < kTinyBits || bits < m_FrameBits / 32; }

    /// A pass codes what lies between the picture's quantizer and its own:
    /// (2^((QP before − QP) / 6) − 1) of the whole picture at the QP it has.
    /// So @p budgetBits buys 6 · log2(1 + budget / whole) steps down.
    int passQp(uint64_t budgetBits) const
    {
        const double whole = std::exp2(m_Pass - (m_PictureQp - kPivotQp) / kSlope);
        const double steps =
            kSlope * std::log2(1.0 + static_cast<double>(budgetBits) / (std::max)(whole, 1.0));
        const int sharpest = (std::max)(kMinQp, m_PictureQp - kPassDrop);
        return std::clamp(static_cast<int>(std::lround(m_PictureQp - steps)), sharpest,
                          (std::max)(sharpest, m_PictureQp));
    }

    /// log2 of what the whole picture costs at kPivotQp, going by a pass at
    /// @p qp, below the picture's own, that cost @p bits — its share of it.
    double passWhole(int qp, uint64_t bits) const
    {
        const double share = std::exp2((m_PictureQp - qp) / kSlope) - 1.0;
        return log2Of(bits) - std::log2(share) + (m_PictureQp - kPivotQp) / kSlope;
    }

    /// What a new picture is taken to cost at the anchor: the brake of
    /// kNewPictureDrop, and the bench's floor under intra, if any.
    double believed() const
    {
        const double floor = m_Intra - (m_AnchorQp - kPivotQp) / kSlope + m_InterFloor;
        return (std::max)(m_Held, floor);
    }

    /// Moves the anchor to @p qp, the level and the belief with it.
    void reanchor(int qp)
    {
        const double shift = (qp - m_AnchorQp) / m_Slope;
        m_Level -= shift;
        m_Held -= shift;
        m_AnchorQp = qp;
    }

    /// A new predicted picture, @p bits at @p qp: the slope, the level, the
    /// belief, and whether it was a spike or the end of one.
    void learnNew(int qp, uint64_t bits)
    {
        const double measured = log2Of(bits);
        const bool skipped = tiny(bits);
        if (!m_InterSeen) {
            m_InterSeen = true;
            m_AnchorQp = qp;
            m_Level = m_Held = measured;
            if (!skipped) remember(qp, measured);
            return;
        }
        // The picture before jumped far above what new pictures cost. If this
        // one, coded at about the same QP, costs less than half of it, that
        // one was a one-off — a cut, a flash, a page wrapping round — and what
        // was believed before it comes back whole: level, belief and slope.
        // One that costs as much is a new level, and stays. This one may well
        // be a few hundred bytes: coded as dear as the spike, the scroll behind
        // it is, and that is the answer. Coded far above the spike — the
        // backlog of a spike sent as it was being paid back — it proves
        // nothing: on a steep curve a picture seventeen QP up costs next to
        // nothing whatever the content, and taking that for a return brought
        // the spike back picture after picture, the QP sinking to 18 and every
        // other picture twelve times its budget (27/09/2026).
        if (m_Spike && !m_AgainOf) {
            m_Spike = false;
            const double atSpike = measured + (qp - m_SpikeAtQp) / kSlope;
            if (std::abs(qp - m_SpikeAtQp) <= kSlopeSpan && atSpike < m_SpikeMeasured - kCut) {
                m_AnchorQp = m_SpikeQp;
                m_Level = m_SpikeLevel;
                m_Held = m_SpikeHeld;
                m_Slope = m_SpikeSlope;
                reanchor(qp);
                if (!skipped) remember(qp, measured);
                return;
            }
        }
        // Two pictures that said something, at QPs apart, with sizes that
        // moved the other way: a secant of the curve.
        const double slopeBefore = m_Slope;
        if (!skipped && m_PrevValid && std::abs(qp - m_PrevQp) >= kSlopeSpan) {
            const double dq = qp - m_PrevQp;
            const double dl = m_PrevLog2 - measured;
            if (dq * dl > 0)
                m_Slope =
                    std::clamp(m_Slope + kSlopeWeight * (dq / dl - m_Slope), kMinSlope, kMaxSlope);
        }
        reanchor(qp);
        if (!skipped && !m_AgainOf && measured > m_Held + kCut) {
            m_Spike = true;
            m_SpikeQp = m_AnchorQp;
            m_SpikeLevel = m_Level;
            m_SpikeHeld = m_Held;
            m_SpikeSlope = slopeBefore;
        }
        // The spike as it went out — coded again, the second picture.
        if (m_Spike) {
            m_SpikeAtQp = qp;
            m_SpikeMeasured = measured;
        }
        // A level replaced by one picture that missed by more than twice is a
        // level that changed — unless the picture before missed the other
        // way: every other capture of a scroll at 120 fps folds two presents
        // and costs 2.5 times the one before, and a model replaced by each in
        // turn codes each at the QP the other needed — twice the swing the
        // content has. Two misses the same way are a change; one is halved.
        if (skipped) {
            m_Level = (std::max)((std::min)(m_Level, measured), m_Level - kCut);
        } else {
            const double miss = measured - m_Level;
            const bool changed =
                std::fabs(miss) > kCut && miss * m_LastMiss > 0 && std::fabs(m_LastMiss) > kCut / 2;
            m_Level = changed ? measured : (m_Level + measured) / 2.0;
            m_LastMiss = miss;
        }
        m_Held =
            m_Level >= m_Held ? m_Level : (std::max)(m_Level, m_Held - kNewPictureDrop / m_Slope);
        if (!skipped) remember(qp, measured);
    }

    void remember(int qp, double measured)
    {
        m_PrevValid = true;
        m_PrevQp = qp;
        m_PrevLog2 = measured;
    }

    void startPicture(int qp, double complexity)
    {
        m_PictureQp = qp;
        m_Pass = complexity;
        m_HavePicture = true;
    }

    int m_Fps = 60;
    int m_VbvFrames = 0;
    double m_InterFloor = kNoInterFloor;
    uint64_t m_FrameBits = 1;
    uint64_t m_VbvBits = 1;
    uint64_t m_Fullness = 0;

    /// Intra pictures: log2 of what one costs at kPivotQp.
    double m_Intra = 20.0;
    bool m_IntraSeen = false;

    /// New predicted pictures: log2 of what one costs at m_AnchorQp — as
    /// learned (m_Level), and as believed, through the brake (m_Held).
    int m_AnchorQp = kPivotQp;
    double m_Level = 18.4;
    double m_Held = 18.4;
    double m_Slope = kSlope;
    double m_Carry = 0.0;
    /// How far the last new picture that said something missed the level.
    double m_LastMiss = 0.0;
    bool m_InterSeen = false;
    /// The last new picture that said something, for the next secant.
    bool m_PrevValid = false;
    int m_PrevQp = 0;
    double m_PrevLog2 = 0.0;
    /// The last new picture jumped more than kCut above the belief; what the
    /// model held before it, anchored at m_SpikeQp; and the spike itself, as
    /// it went out.
    bool m_Spike = false;
    int m_SpikeQp = 0;
    double m_SpikeLevel = 0.0;
    double m_SpikeHeld = 0.0;
    double m_SpikeSlope = kSlope;
    int m_SpikeAtQp = 0;
    double m_SpikeMeasured = 0.0;
    /// overshot() came before this encoded(): the same picture, coded again.
    bool m_AgainOf = false;
    /// reencode()'s rule: see setReencodeFit().
    bool m_ReencodeFit = false;

    /// Passes: log2 of what the whole picture on screen costs at kPivotQp.
    double m_Pass = 18.4;
    bool m_HavePicture = false;
    int m_PictureQp = kMaxQp;

    int m_Pictures = 0;
    uint64_t m_QpSum = 0;
    int m_StrongOvershoots = 0;
};

} // namespace mw::native::encode
