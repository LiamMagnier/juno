import SwiftUI

// The construction, in dots — the web's `dot-engine.ts` + `dot-scenes.ts`
// (src/components/home), ported to one `Canvas` in one `TimelineView`.
//
// Alevr's drawing: nested orbits growing by 1.5, seen at an isometric
// diagonal, on the ℵ number line, with one presence trajectory travelling the
// fourth orbit. Every drawing is rasterised onto a fine grid of dots (one dot
// per ~3.9pt cell), each dot sized and lit by the brightest thing that crossed
// its cell, so near halves of a ring land bigger and brighter than far halves.
// The trajectory is the only thing drawn in presence blue.
//
// Same numbers as the web, so a field on the Mac and the same field in the
// browser draw the same dots on the same beat: rings start 110ms apart, draw
// over 2.2s on the homepage's expo ease, then the drawing sways ±7° over 80s
// while the comet travels one revolution every ~31s.
//
// Two scenes, as on the web:
//  - ``JunoDotConstruction`` — the construction (home field, page backdrops).
//  - ``JunoDotRings`` — flat ellipses placed in fractions of the box, with
//    optional lines and presence arcs (project covers, the profile, orbits).
//
// Cheap: the raster is a flat array rebuilt for each frame at the size the
// Canvas is handed, and each frame is ~48 path fills (one per brightness level
// and tone). The clock pauses off screen, in the background and under Reduce
// Motion — where the final frame is drawn once — and the settled drawing asks
// for 30 frames a second, not 120.
//
// None of the web's "blank until reload" failure can happen here: there is no
// retained bitmap or retained raster to go stale. Every frame is drawn from
// the drawing's description at the Canvas's current size and the screen's
// current scale, so a size change, a display change, a theme flip or a return
// from the background simply draws again (docs/native/BRAND_MOTIFS.md).

// MARK: - Palette

/// How a dot field is coloured, per surface. The web's `--dots-*` variables.
public struct JunoDotStyle: Sendable, Equatable {
    /// Overall ink opacity multiplier.
    public var strength: Double
    /// Presence bloom opacity.
    public var glow: Double
    /// How bright the far half of a ring stays (0…1).
    public var floor: Double
    /// Dot size multiplier.
    public var size: Double
    /// Number-line opacity multiplier.
    public var axis: Double

    public init(strength: Double, glow: Double, floor: Double, size: Double, axis: Double) {
        self.strength = strength
        self.glow = glow
        self.floor = floor
        self.size = size
        self.axis = axis
    }

    /// Paper: slightly larger dots, the far half held brighter, the number
    /// line quieter (`.alv-dots` in light).
    public static let light = JunoDotStyle(strength: 0.64, glow: 0.32, floor: 0.46, size: 1.06, axis: 0.5)
    /// The dark ground (`.dark .alv-dots`).
    public static let dark = JunoDotStyle(strength: 0.82, glow: 0.6, floor: 0.35, size: 1, axis: 1)

    public static func standard(for scheme: ColorScheme) -> JunoDotStyle {
        scheme == .dark ? .dark : .light
    }

    /// The same style with its ink strength replaced (the home field's 0.56 / 0.66).
    public func strength(_ value: Double) -> JunoDotStyle {
        var copy = self
        copy.strength = value
        return copy
    }
}

// MARK: - Easing

/// cubic-bezier(.16, 1, .3, 1), the homepage's expo ease, and its inverse.
enum JunoDotEase {
    private static let n = 512
    private static let table: (x: [Double], y: [Double]) = {
        let (x1, y1, x2, y2) = (0.16, 1.0, 0.3, 1.0)
        var xs = [Double](repeating: 0, count: n + 1)
        var ys = [Double](repeating: 0, count: n + 1)
        for i in 0...n {
            let s = Double(i) / Double(n)
            let m = 1 - s
            xs[i] = 3 * m * m * s * x1 + 3 * m * s * s * x2 + s * s * s
            ys[i] = 3 * m * m * s * y1 + 3 * m * s * s * y2 + s * s * s
        }
        return (xs, ys)
    }()

    private static func lookup(_ from: [Double], _ to: [Double], _ v: Double) -> Double {
        if v <= 0 { return 0 }
        if v >= 1 { return 1 }
        var lo = 0
        var hi = n
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1
            if from[mid] < v { lo = mid } else { hi = mid }
        }
        let a = from[lo]
        let b = from[hi]
        let k = b == a ? 0 : (v - a) / (b - a)
        return to[lo] + (to[hi] - to[lo]) * k
    }

    static func ease(_ x: Double) -> Double { lookup(table.x, table.y, x) }
    static func inverse(_ y: Double) -> Double { lookup(table.y, table.x, y) }
}

@inline(__always) func junoClamp01(_ v: Double) -> Double { v < 0 ? 0 : (v > 1 ? 1 : v) }

/// How a dot arrives: it grows and brightens from nothing, glinting a little
/// past its resting value as the pen passes, then settles.
private let settleTime = 0.55
private func settle(_ base: Double, _ age: Double) -> Double {
    if age >= settleTime { return base }
    if age <= 0 { return 0 }
    let s = age / settleTime
    let grown = 1 - (1 - s) * (1 - s) * (1 - s)
    return base * grown + 0.3 * sin(.pi * s) * (1 - s * 0.5)
}

// MARK: - Raster

struct JunoDotRaster {
    static let levels = 24

    let pitch: Double
    let gw: Int
    let gh: Int
    private(set) var lum: [Float]
    private(set) var blue: [Bool]
    private(set) var lit: [Int] = []

    /// How many cells are lit (for tests).
    var litCount: Int { lit.count }
    /// How many lit cells are presence blue (for tests).
    var blueCount: Int { lit.reduce(0) { $0 + (blue[$1] ? 1 : 0) } }
    /// The summed brightness of the lit cells (for tests).
    var litLuminance: Double { lit.reduce(0) { $0 + Double(lum[$1]) } }

    init(width: Double, height: Double, pitch: Double) {
        self.pitch = pitch
        gw = max(1, Int((width / pitch).rounded(.up)))
        gh = max(1, Int((height / pitch).rounded(.up)))
        lum = [Float](repeating: 0, count: gw * gh)
        blue = [Bool](repeating: false, count: gw * gh)
        lit.reserveCapacity(4096)
    }

    mutating func plot(_ x: Double, _ y: Double, _ v: Double, blue isBlue: Bool = false) {
        if v <= 0.004 || x < 0 || y < 0 { return }
        let gx = Int(x / pitch)
        let gy = Int(y / pitch)
        if gx >= gw || gy >= gh { return }
        let i = gy * gw + gx
        let was = lum[i]
        if was == 0 { lit.append(i) }
        let value = Float(min(1, v))
        if value > was { lum[i] = value }
        if isBlue { blue[i] = true }
    }

    /// One path per brightness level and tone, the presence glow under the dots.
    func draw(in context: inout GraphicsContext, ink: Color, presence: Color, style: JunoDotStyle) {
        guard !lit.isEmpty else { return }
        let levels = Self.levels
        var paths = [Path](repeating: Path(), count: levels * 2)
        // The presence glow sits under the dots: the web's 32px radial sprite
        // (0.9 / 0.35 / 0 at 0, 35%, 100%) at 2.6 pitches, one per presence
        // dot of level 7 and up, at glow × level × 0.42.
        var glows: [(x: Double, y: Double, alpha: Double)] = []
        let glowRadius = pitch * 2.6
        for i in lit {
            let level = min(levels - 1, max(0, Int((Double(lum[i]) * Double(levels)).rounded(.up)) - 1))
            let isBlue = blue[i]
            let k = isBlue ? levels + level : level
            let lv = Double(level + 1) / Double(levels)
            let rad = pitch * (0.13 + 0.33 * lv + (isBlue ? 0.08 : 0)) * style.size
            let x = (Double(i % gw) + 0.5) * pitch
            let y = (Double(i / gw) + 0.5) * pitch
            paths[k].addEllipse(in: CGRect(x: x - rad, y: y - rad, width: rad * 2, height: rad * 2))
            if isBlue, level >= 6, style.glow > 0 {
                glows.append((x, y, style.glow * lv * 0.42))
            }
        }
        for g in glows {
            let rect = CGRect(x: g.x - glowRadius, y: g.y - glowRadius, width: glowRadius * 2, height: glowRadius * 2)
            context.fill(
                Path(ellipseIn: rect),
                with: .radialGradient(
                    Gradient(stops: [
                        .init(color: presence.opacity(0.9 * g.alpha), location: 0),
                        .init(color: presence.opacity(0.35 * g.alpha), location: 0.35),
                        .init(color: presence.opacity(0), location: 1),
                    ]),
                    center: CGPoint(x: g.x, y: g.y), startRadius: 0, endRadius: glowRadius
                )
            )
        }
        for k in 0..<(levels * 2) where !paths[k].isEmpty {
            let isBlue = k >= levels
            let lv = Double((isBlue ? k - levels : k) + 1) / Double(levels)
            let alpha = isBlue ? min(1, lv + 0.22) : min(1, lv * 1.15) * style.strength
            context.fill(paths[k], with: .color((isBlue ? presence : ink).opacity(alpha)))
        }
    }
}

/// A soft presence bloom at an exact position: the comet's head.
private func bloom(_ context: inout GraphicsContext, presence: Color, x: Double, y: Double, radius: Double, alpha: Double) {
    guard alpha > 0.01 else { return }
    let rect = CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)
    context.fill(
        Path(ellipseIn: rect),
        with: .radialGradient(
            Gradient(stops: [
                .init(color: presence.opacity(alpha * 0.55), location: 0),
                .init(color: presence.opacity(alpha * 0.16), location: 0.4),
                .init(color: presence.opacity(0), location: 1),
            ]),
            center: CGPoint(x: x, y: y),
            startRadius: 0,
            endRadius: radius
        )
    )
}

// MARK: - Frame

struct JunoDotFrame {
    /// Seconds on this drawing's own clock (1e4 = settled, for a still frame).
    var t: Double
    var w: Double
    var h: Double
    var ox: Double
    var oy: Double
    /// Points per unit of the web's 1500 × 1000 viewBox.
    var u: Double
    var pitch: Double
    var still: Bool
    var style: JunoDotStyle
}

// MARK: - The construction scene

private let deg = Double.pi / 180
private let tau = Double.pi * 2

enum JunoConstructionMotion {
    static let delay = 0.2
    static let stagger = 0.11
    static let draw = 2.2
    static let tickDelay = 1.3
    static let tickFade = 0.9
    static let swayAmp = 7 * deg
    static let swayPeriod = 80.0
    static let travel = 0.032
    static let tail = 0.2
    static let ringIn = 1.5
    static let ringLag = 0.55
}

struct JunoConstructionScene {
    var ticks: Bool
    var trajectory: Bool
    var axis: Bool
    var animate: Bool

    private static let base = 132.0
    private static let ratio = 1.5
    private static let count = 7
    private static let tilt = 58 * deg
    private static let yaw0 = -24 * deg
    private static let roll = -20 * deg
    private static let trajRing = 3
    private static let lead0 = 0.2
    private static let subscripts = ["₀", "₁", "₂", "₃", "₄"]

    struct Plotted {
        var busy: Bool
        var head: (x: Double, y: Double, near: Double, tp: Double)?
        var labels: [(x: Double, y: Double, a: Double)]
    }

    /// Draws one frame. Returns true while the arrival is still running.
    func render(_ f: JunoDotFrame, raster r: inout JunoDotRaster, context: inout GraphicsContext, ink: Color, presence: Color, sub: Color) -> Bool {
        let out = plot(f, raster: &r)
        if let head = out.head {
            bloom(&context, presence: presence, x: head.x, y: head.y, radius: f.pitch * 7,
                  alpha: f.style.glow * head.tp * (0.55 + 0.45 * head.near))
        }
        r.draw(in: &context, ink: ink, presence: presence, style: f.style)
        for (k, l) in out.labels.enumerated() {
            let label = Text("ℵ\(Self.subscripts[k])")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(sub.opacity(0.85 * l.a))
            context.draw(label, at: CGPoint(x: l.x + 6, y: l.y - 5 + (1 - l.a) * 4), anchor: .bottomLeading)
        }
        return out.busy
    }

    /// Rasterises one frame (pure; see ``JunoRingsScene/plot(_:raster:)``).
    func plot(_ f: JunoDotFrame, raster r: inout JunoDotRaster) -> Plotted {
        typealias M = JunoConstructionMotion
        let animate = self.animate && !f.still
        let t = animate ? f.t : 1e4
        let u = f.u
        let ox = f.ox
        let oy = f.oy
        let step = f.pitch * 0.42

        let swayT = t - (M.delay + M.stagger * Double(Self.count) + M.draw * 0.6)
        let swayIn = animate ? junoClamp01(swayT / 6) : 0
        let sway = M.swayAmp * sin(tau * max(0, swayT) / M.swayPeriod) * swayIn * swayIn
        let yaw = Self.yaw0 + sway
        let cy = cos(yaw), sy = sin(yaw)
        let cT = cos(Self.tilt), sT = sin(Self.tilt)
        let cR = cos(Self.roll), sR = sin(Self.roll)
        let ax = cy * cR - sy * cT * sR
        let bx = -sy * cR - cy * cT * sR
        let ay = cy * sR + sy * cT * cR
        let by = -sy * sR + cy * cT * cR
        let dx = sy * sT
        let dy = cy * sT

        func radius(_ k: Int) -> Double { Self.base * pow(Self.ratio, Double(k)) * u }
        var busy = false
        let floor = f.style.floor

        if axis, f.style.axis > 0 {
            let length = radius(Self.count - 2) * 1.08
            let p = JunoDotEase.ease((t - M.delay) / M.ringIn)
            if p < 1 { busy = true }
            let n = Int((length / step).rounded(.up))
            let strength = 0.2 * f.style.axis
            if n > 0 {
                for i in -n...n {
                    let s = Double(i) / Double(n)
                    let a = abs(s)
                    if a > p { continue }
                    r.plot(ox + ax * s * length, oy + ay * s * length,
                           strength * (1 - a * a * 0.7) * JunoDotEase.ease(junoClamp01((p - a) / 0.25 + 0.2)))
                }
            }
        }

        for k in 0..<Self.count {
            let t0 = M.delay + M.stagger * Double(k)
            let lt = t - t0
            if lt <= 0 {
                busy = true
                continue
            }
            let done = lt > M.ringIn + M.ringLag
            if !done { busy = true }
            let global = done ? 1 : JunoDotEase.ease(lt / M.ringIn)
            let rad = radius(k) * (done ? 1 : 0.965 + 0.035 * global)
            let strength = k >= 5 ? 0.3 : 0.62
            let n = max(24, Int((tau * rad / step).rounded(.up)))
            let soft = rad * 0.6
            for s in 0..<n {
                let q = Double(s) / Double(n)
                let a = q * tau
                let px = rad * cos(a)
                let py = rad * sin(a)
                let X = ox + ax * px + bx * py
                let Y = oy + ay * px + by * py
                if X < -4 || Y < -4 || X > f.w + 4 || Y > f.h + 4 { continue }
                let near = 0.5 + 0.5 * tanh((dx * px + dy * py) / soft)
                let base = strength * (floor + (1 - floor) * near)
                var v = base
                if !done {
                    let local = (lt - M.ringLag * q) / (M.ringIn * 0.6)
                    let arrived = JunoDotEase.ease(junoClamp01(local))
                    let band = local > -0.2 && local < 0.6 ? exp(-pow((local - 0.12) / 0.14, 2)) : 0
                    v = base * global * (0.45 + 0.55 * arrived) + 0.34 * band * (0.5 + 0.5 * near)
                }
                r.plot(X, Y, v)
            }
        }

        var head: (x: Double, y: Double, near: Double, tp: Double)?
        if trajectory {
            let rad = radius(Self.trajRing)
            let tT0 = M.delay + M.stagger * Double(Self.trajRing + 2) + 0.4
            let tp = JunoDotEase.ease((t - tT0) / 1.6)
            if tp > 0 {
                let lead = Self.lead0 + (animate ? M.travel * max(0, t - tT0) : 0)
                let span = M.tail * tp
                let n = max(8, Int((span * tau * rad / step).rounded(.up)))
                let soft = rad * 0.6
                for i in 0...n {
                    let s = Double(i) / Double(n)
                    let a = (lead - span * (1 - s)) * tau
                    let px = rad * cos(a)
                    let py = rad * sin(a)
                    let X = ox + ax * px + bx * py
                    let Y = oy + ay * px + by * py
                    let near = 0.5 + 0.5 * tanh((dx * px + dy * py) / soft)
                    r.plot(X, Y, (0.28 + 0.72 * pow(s, 1.6)) * (0.62 + 0.38 * near), blue: true)
                    if i == n { head = (X, Y, near, tp) }
                }
            } else {
                busy = true
            }
        }
        var labels: [(x: Double, y: Double, a: Double)] = []
        if ticks {
            for k in 0..<5 {
                let a = JunoDotEase.ease((t - (M.tickDelay + M.stagger * Double(k))) / M.tickFade) * f.style.axis.squareRoot()
                if a < 1 { busy = true }
                if a <= 0 { continue }
                let rk = radius(k)
                labels.append((ox + ax * rk, oy + ay * rk, a))
            }
        }
        return Plotted(busy: busy, head: head, labels: labels)
    }
}

// MARK: - The rings scene

/// A flat ellipse placed in fractions of the box (rx of its width, ry of its height).
public struct JunoDotRing: Sendable, Equatable {
    public var cx: Double
    public var cy: Double
    public var rx: Double
    public var ry: Double
    public var faint: Bool

    public init(cx: Double = 0.5, cy: Double = 0.5, rx: Double, ry: Double, faint: Bool = false) {
        self.cx = cx
        self.cy = cy
        self.rx = rx
        self.ry = ry
        self.faint = faint
    }
}

/// A straight run of dots in fractions of the box.
public struct JunoDotLine: Sendable, Equatable {
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public var presence: Bool
    public var strength: Double

    public init(x1: Double, y1: Double, x2: Double, y2: Double, presence: Bool = false, strength: Double = 0.26) {
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
        self.presence = presence
        self.strength = strength
    }
}

/// A presence arc on a ring, drawn towards `to` (degrees), where its head blooms.
public struct JunoDotArc: Sendable, Equatable {
    public var ring: Int
    public var from: Double
    public var to: Double

    public init(ring: Int, from: Double, to: Double) {
        self.ring = ring
        self.from = from
        self.to = to
    }
}

struct JunoRingsScene {
    var rings: [JunoDotRing]
    var lines: [JunoDotLine]
    var arcs: [JunoDotArc]
    var animate: Bool
    var stagger: Double
    var draw: Double
    var delay: Double
    var start: Double

    private static let lineDraw = 0.7

    func render(_ f: JunoDotFrame, raster r: inout JunoDotRaster, context: inout GraphicsContext, ink: Color, presence: Color) -> Bool {
        let (busy, heads) = plot(f, raster: &r)
        for head in heads {
            bloom(&context, presence: presence, x: head.x, y: head.y, radius: f.pitch * 6, alpha: f.style.glow * head.p)
        }
        r.draw(in: &context, ink: ink, presence: presence, style: f.style)
        return busy
    }

    /// Rasterises one frame; returns whether anything is still arriving and
    /// where each presence arc's head blooms. Pure, so it is tested against
    /// the web's numbers without a graphics context.
    func plot(_ f: JunoDotFrame, raster r: inout JunoDotRaster) -> (busy: Bool, heads: [(x: Double, y: Double, p: Double)]) {
        let animate = self.animate && !f.still
        let t = animate ? f.t : 1e4
        let startAngle = start * deg
        let step = f.pitch * 0.42
        let w = f.w
        let h = f.h
        var busy = false

        func ringAt(_ ring: JunoDotRing, _ a: Double, grow: Double = 1) -> (x: Double, y: Double, near: Double) {
            (ring.cx * w + ring.rx * grow * w * cos(a), ring.cy * h + ring.ry * grow * h * sin(a), 0.5 + 0.5 * sin(a))
        }

        let floor = max(0.5, f.style.floor)
        let ringIn = draw * 0.8
        let lag = draw * 0.3
        for (k, ring) in rings.enumerated() {
            let lt = t - (delay + stagger * Double(k))
            if lt <= 0 {
                busy = true
                continue
            }
            let done = lt > ringIn + lag
            if !done { busy = true }
            let global = done ? 1 : JunoDotEase.ease(lt / ringIn)
            let grow = done ? 1 : 0.96 + 0.04 * global
            let strength = ring.faint ? 0.26 : 0.5
            let length = tau * ((pow(ring.rx * w, 2) + pow(ring.ry * h, 2)) / 2).squareRoot()
            let n = max(24, Int((length / step).rounded(.up)))
            for s in 0..<n {
                let q = Double(s) / Double(n)
                let pt = ringAt(ring, startAngle + q * tau, grow: grow)
                let base = strength * (floor + (1 - floor) * pt.near)
                var v = base
                if !done {
                    let local = (lt - lag * q) / (ringIn * 0.6)
                    let arrived = JunoDotEase.ease(junoClamp01(local))
                    let band = local > -0.2 && local < 0.6 ? exp(-pow((local - 0.12) / 0.14, 2)) : 0
                    v = base * global * (0.45 + 0.55 * arrived) + 0.3 * band
                }
                r.plot(pt.x, pt.y, v)
            }
        }

        for (i, line) in lines.enumerated() {
            let x1 = line.x1 * w
            let y1 = line.y1 * h
            let ddx = line.x2 * w - x1
            let ddy = line.y2 * h - y1
            let n = max(2, Int((hypot(ddx, ddy) / step).rounded(.up)))
            let age = t - (delay + stagger * (Double(rings.count) + Double(i) * 0.5))
            let p = JunoDotEase.ease(age / Self.lineDraw)
            if age < Self.lineDraw + settleTime { busy = true }
            if p <= 0 { continue }
            let settled = age > Self.lineDraw + settleTime
            let last = Int(p * Double(n))
            for s in 0...last {
                let q = Double(s) / Double(n)
                let v = settled ? line.strength : settle(line.strength, age - Self.lineDraw * JunoDotEase.inverse(q))
                r.plot(x1 + ddx * q, y1 + ddy * q, v, blue: line.presence)
            }
        }

        var heads: [(x: Double, y: Double, p: Double)] = []
        for arc in arcs {
            guard rings.indices.contains(arc.ring) else { continue }
            let ring = rings[arc.ring]
            let t0 = delay + stagger * Double(rings.count + 3)
            let p = JunoDotEase.ease((t - t0) / draw)
            if p <= 0 {
                busy = true
                continue
            }
            if t - t0 < draw { busy = true }
            let from = arc.from * deg
            let to = arc.to * deg
            let end = from + (to - from) * p
            let length = abs(end - from) * ((pow(ring.rx * w, 2) + pow(ring.ry * h, 2)) / 2).squareRoot()
            let n = max(4, Int((length / step).rounded(.up)))
            var head = ringAt(ring, end)
            for i in 0...n {
                let s = Double(i) / Double(n)
                let pt = ringAt(ring, from + (end - from) * s)
                if i == n { head = pt }
                r.plot(pt.x, pt.y, (0.28 + 0.72 * pow(s, 1.6)) * (0.65 + 0.35 * pt.near), blue: true)
            }
            heads.append((head.x, head.y, p))
        }
        return (busy, heads)
    }
}

// MARK: - Clock

public extension EnvironmentValues {
    /// Pins every dot drawing to one moment on its clock, in seconds, for
    /// offscreen snapshots (which render a single frame and would otherwise
    /// catch t ≈ 0, before a ring has arrived). `nil` is the live clock;
    /// `.infinity` (or anything past the arrival) is the settled frame.
    @Entry var junoDotsTime: Double? = nil
}

/// The shared host: one `TimelineView`, one `Canvas`. The clock runs only
/// while the drawing is on screen (appeared, and inside a scroll view's
/// visible region), its scene is not in the background, Reduce Motion is off,
/// and something is still moving; otherwise the timeline is paused and the
/// last frame stands. Each frame is drawn from scratch at the size the Canvas
/// is given, so nothing it shows can go stale.
struct JunoDotCanvas: View {
    /// True when the drawing keeps moving after it settles (sway, comet).
    let ambient: Bool
    let animate: Bool
    let pitch: Double
    let style: JunoDotStyle?
    let render: (inout GraphicsContext, CGSize, JunoDotFrame, JunoDotStyle) -> Bool

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.junoDotsTime) private var pinnedTime
    @State private var startedAt = Date()
    @State private var appeared = false
    @State private var scrolledIn = true
    @State private var settled = false

    private var still: Bool { reduceMotion || !animate }

    var body: some View {
        let running = pinnedTime == nil && !still && appeared && scrolledIn
            && scenePhase != .background && (ambient || !settled)
        TimelineView(.animation(minimumInterval: settled ? 1.0 / 30 : nil, paused: !running)) { timeline in
            let live = timeline.date.timeIntervalSince(startedAt)
            let t = pinnedTime.map { $0.isFinite ? $0 : 1e4 } ?? live
            let isStill = still || (pinnedTime.map { !$0.isFinite } ?? false)
            Canvas(rendersAsynchronously: false) { context, size in
                guard size.width > 0, size.height > 0 else { return }
                let resolved = style ?? .standard(for: scheme)
                let frame = JunoDotFrame(
                    t: isStill ? 1e4 : t, w: size.width, h: size.height,
                    ox: 0, oy: 0, u: 1, pitch: pitch, still: isStill, style: resolved
                )
                let busy = render(&context, size, frame, resolved)
                if !busy, !settled, !isStill, pinnedTime == nil {
                    Task { @MainActor in settled = true }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { appeared = true }
        .onDisappear { appeared = false }
        .onScrollVisibilityChange(threshold: 0.01) { scrolledIn = $0 }
    }
}

// MARK: - Public views

/// The construction as a dot matrix: Alevr's drawing, drawing itself on ring
/// by ring, then swaying very slowly while the trajectory travels its orbit.
///
/// Fills its frame; place the origin with `origin` (fractions of the box) and
/// size it with `span` (the width the web's 1500-unit drawing spans; the
/// box's own width when nil) and `zoom`. Decorative — hidden from assistive
/// technology and from hit testing.
public struct JunoDotConstruction: View {
    var ticks: Bool
    var trajectory: Bool
    var axis: Bool
    var animate: Bool
    var origin: UnitPoint
    var span: CGFloat?
    var zoom: CGFloat
    var pitch: CGFloat
    var style: JunoDotStyle?

    public init(
        ticks: Bool = false,
        trajectory: Bool = true,
        axis: Bool = true,
        animate: Bool = true,
        origin: UnitPoint = .center,
        span: CGFloat? = nil,
        zoom: CGFloat = 1,
        pitch: CGFloat = 3.9,
        style: JunoDotStyle? = nil
    ) {
        self.ticks = ticks
        self.trajectory = trajectory
        self.axis = axis
        self.animate = animate
        self.origin = origin
        self.span = span
        self.zoom = zoom
        self.pitch = pitch
        self.style = style
    }

    public var body: some View {
        let scene = JunoConstructionScene(ticks: ticks, trajectory: trajectory, axis: axis, animate: animate)
        let origin = origin
        let span = span
        let zoom = zoom
        let pitch = Double(pitch)
        JunoDotCanvas(ambient: true, animate: animate, pitch: pitch, style: style) { context, size, frame, _ in
            var f = frame
            f.ox = origin.x * size.width
            f.oy = origin.y * size.height
            f.u = Double((span ?? size.width) * zoom) / 1500
            var raster = JunoDotRaster(width: size.width, height: size.height, pitch: pitch)
            return scene.render(f, raster: &raster, context: &context, ink: .junoForeground, presence: .junoPresence, sub: .junoSecondaryInk)
        }
    }
}

/// Flat orbits in the same dot language, for drawings whose rings carry
/// things (project covers, the profile, the product switch).
public struct JunoDotRings: View {
    var rings: [JunoDotRing]
    var lines: [JunoDotLine]
    var arcs: [JunoDotArc]
    var animate: Bool
    var stagger: Double
    var draw: Double
    var delay: Double
    var start: Double
    var pitch: CGFloat
    var style: JunoDotStyle?

    public init(
        rings: [JunoDotRing],
        lines: [JunoDotLine] = [],
        arcs: [JunoDotArc] = [],
        animate: Bool = true,
        stagger: Double = 0.09,
        draw: Double = 1.8,
        delay: Double = 0.12,
        start: Double = 180,
        pitch: CGFloat = 3.9,
        style: JunoDotStyle? = nil
    ) {
        self.rings = rings
        self.lines = lines
        self.arcs = arcs
        self.animate = animate
        self.stagger = stagger
        self.draw = draw
        self.delay = delay
        self.start = start
        self.pitch = pitch
        self.style = style
    }

    public var body: some View {
        let scene = JunoRingsScene(
            rings: rings, lines: lines, arcs: arcs, animate: animate,
            stagger: stagger, draw: draw, delay: delay, start: start
        )
        let pitch = Double(pitch)
        JunoDotCanvas(ambient: false, animate: animate, pitch: pitch, style: style) { context, size, frame, _ in
            var raster = JunoDotRaster(width: size.width, height: size.height, pitch: pitch)
            return scene.render(frame, raster: &raster, context: &context, ink: .junoForeground, presence: .junoPresence)
        }
    }
}

