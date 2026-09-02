import SwiftUI

/// The centred orb for full-screen voice: the same light as ``JunoVoiceAura``,
/// gathered into one body instead of spread along the edges.
///
/// The aura is right for a call that runs *beside* a transcript — light that
/// asks for none of your attention. Full-screen voice is the opposite moment:
/// the reader has chosen to look, so the orb is the thing to look at. It
/// breathes at rest, swells with whoever is speaking, and takes the account's
/// accent for the reader's turn and the aura's companion hue for Juno's, so
/// the two surfaces read as one voice in two rooms.
///
/// Drawn with `Canvas` in a `TimelineView`, like the aura, so a level that
/// changes thirty times a second invalidates one drawing and nothing else.
/// Under Reduce Motion the clock stops: the orb still scales with the level —
/// a live microphone must stay visibly live — but the drift and the rotation
/// are gone.
public struct JunoVoiceOrb: View {
    private let level: Double
    private let speaking: Bool
    private let active: Bool
    /// Held to talk. The orb tightens and brightens so the press has an
    /// answer the finger can see.
    private let pressed: Bool

    public init(level: Double, speaking: Bool, active: Bool, pressed: Bool = false) {
        self.level = level
        self.speaking = speaking
        self.active = active
        self.pressed = pressed
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var mixOrigin: Double = 0
    @State private var mixStartedAt = Date.distantPast

    private static let crossfade: TimeInterval = 0.4
    private static let companionHueShift: Double = 152

    public var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            Canvas(opaque: false) { canvas, size in
                draw(in: canvas, size: size, date: context.date)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: speaking) { _, _ in
            mixOrigin = mix(at: Date())
            mixStartedAt = Date()
        }
    }

    private func mix(at date: Date) -> Double {
        let target: Double = speaking ? 1 : 0
        guard mixStartedAt != .distantPast else { return target }
        let t = min(1, max(0, date.timeIntervalSince(mixStartedAt) / Self.crossfade))
        let eased = t * t * (3 - 2 * t)
        return mixOrigin + (target - mixOrigin) * eased
    }

    private func draw(in canvas: GraphicsContext, size: CGSize, date: Date) {
        guard size.width > 1, size.height > 1 else { return }
        let clock = reduceMotion ? 0 : date.timeIntervalSinceReferenceDate
        let isDark = colorScheme == .dark
        let amplitude = min(1, max(0, level))
        let floor = active ? (speaking ? 0.16 : 0.08) : 0.03
        let lit = max(floor, amplitude)

        let accent = JunoAccentSelection.shared.current.hsl(dark: isDark)
        let blend = mix(at: date)
        let hue = (accent.h + Self.companionHueShift * blend).truncatingRemainder(dividingBy: 360)
        let saturation = accent.s * (1 - 0.1 * blend)
        let lightness = min(0.9, accent.l + 0.06 * blend)

        func tint(_ alpha: Double, lift: Double = 0) -> Color {
            Color(
                juno: JunoColorToken(
                    hsl: (h: hue, s: min(1, saturation), l: min(0.94, lightness + lift))
                )
            )
            .opacity(alpha)
        }

        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        let base = min(size.width, size.height) * 0.5
        // A slow breath at rest, and the voice on top of it. Pressed pulls the
        // orb in a touch, as a held control should.
        let breath = reduceMotion ? 0 : 0.03 * sin(clock * 1.4)
        let scale = (pressed ? 0.9 : 1) * (0.78 + 0.22 * lit + breath)
        let radius = base * scale * 0.72

        // The halo: a wide, faint bloom that grows faster than the body so a
        // loud syllable reads from across the room.
        let haloRadius = radius * (1.25 + 0.55 * lit)
        canvas.fill(
            Path(ellipseIn: CGRect(
                x: centre.x - haloRadius, y: centre.y - haloRadius,
                width: haloRadius * 2, height: haloRadius * 2
            )),
            with: .radialGradient(
                Gradient(colors: [tint(0.28 * (0.6 + 0.4 * lit)), tint(0.08), tint(0)]),
                center: centre, startRadius: radius * 0.6, endRadius: haloRadius
            )
        )

        // The body: three slowly drifting lobes under one sphere, so it never
        // reads as a flat disc.
        for index in 0..<3 {
            let phase = Double(index) * 2.1
            let drift = reduceMotion ? 0 : 0.08 * radius
            let dx = drift * sin(clock * (0.55 + 0.11 * Double(index)) + phase)
            let dy = drift * cos(clock * (0.47 + 0.13 * Double(index)) + phase)
            let lobeRadius = radius * (0.92 + 0.06 * Double(index)) * (1 + 0.1 * lit)
            var lobe = canvas
            lobe.opacity = 0.55
            lobe.fill(
                Path(ellipseIn: CGRect(
                    x: centre.x + dx - lobeRadius, y: centre.y + dy - lobeRadius,
                    width: lobeRadius * 2, height: lobeRadius * 2
                )),
                with: .radialGradient(
                    Gradient(colors: [tint(0.9, lift: 0.12), tint(0.75), tint(0.35)]),
                    center: CGPoint(x: centre.x + dx - lobeRadius * 0.3, y: centre.y + dy - lobeRadius * 0.35),
                    startRadius: 0, endRadius: lobeRadius
                )
            )
        }

        // The sphere itself, with the light from the top-left the whole design
        // language keeps.
        canvas.fill(
            Path(ellipseIn: CGRect(
                x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2
            )),
            with: .radialGradient(
                Gradient(colors: [tint(0.95, lift: isDark ? 0.18 : 0.1), tint(0.85), tint(0.6, lift: -0.04)]),
                center: CGPoint(x: centre.x - radius * 0.35, y: centre.y - radius * 0.4),
                startRadius: 0, endRadius: radius * 1.3
            )
        )

        // A crisp rim so the boundary clears the 3:1 the language asks of
        // every surface, whatever the canvas behind it.
        canvas.stroke(
            Path(ellipseIn: CGRect(
                x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2
            )),
            with: .color(tint(0.55, lift: isDark ? 0.24 : -0.08)),
            lineWidth: 1
        )
    }
}

#Preview("Voice orb") {
    struct Harness: View {
        @State private var speaking = false
        let start = Date()

        var body: some View {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSince(start)
                let syllable = max(0, sin(t * 5.2))
                let jitter = 0.5 + 0.5 * sin(t * 21)
                let value = min(1, syllable * syllable * (0.55 + 0.45 * jitter))
                VStack {
                    JunoVoiceOrb(level: value, speaking: speaking, active: true)
                        .frame(width: 260, height: 260)
                    Button(speaking ? "Hand back to you" : "Let Juno answer") {
                        speaking.toggle()
                    }
                }
                .frame(width: 400, height: 500)
            }
        }
    }
    return Harness()
}
