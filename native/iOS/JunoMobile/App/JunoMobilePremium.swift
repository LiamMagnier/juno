import JunoDesignSystem
import SwiftUI
import UIKit

// The premium pass's iOS primitives (docs/design/premium-pass/BRIEF.md).
//
// Everything here is iOS-local on purpose: the shared design system is also
// the Mac's, and nothing on this page changes a value the Mac can see. The
// phone gets its display face, its motion vocabulary, its brand backdrop and
// its page header from this one file, so every screen that adopts them reads
// as one product instead of eleven.

// MARK: - Motion

enum JunoMobileMotion {
  /// The brief's appearance spring: response 0.35, damping 0.86.
  static let appear = Animation.spring(response: 0.35, dampingFraction: 0.86)
  /// A slower, softer spring for large surfaces (hero art, a sheet's content).
  static let settle = Animation.spring(response: 0.6, dampingFraction: 0.9)
  /// The 120ms press.
  static let press = Animation.easeOut(duration: 0.12)

  /// `animation`, or nil under Reduce Motion so the change lands at once.
  static func gated(_ animation: Animation, _ reduceMotion: Bool) -> Animation? {
    reduceMotion ? nil : animation
  }
}

/// The brief's press: scale 0.97 over 120ms, and nothing under Reduce Motion.
struct JunoMobilePressStyle: ButtonStyle {
  var scale: CGFloat = 0.97

  func makeBody(configuration: Configuration) -> some View {
    Pressed(pressed: configuration.isPressed, scale: scale, label: configuration.label)
  }

  private struct Pressed: View {
    let pressed: Bool
    let scale: CGFloat
    let label: ButtonStyleConfiguration.Label
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      label
        .scaleEffect(pressed && !reduceMotion ? scale : 1)
        .opacity(pressed ? 0.88 : 1)
        .animation(JunoMobileMotion.gated(JunoMobileMotion.press, reduceMotion), value: pressed)
    }
  }
}

extension ButtonStyle where Self == JunoMobilePressStyle {
  static var junoMobilePress: JunoMobilePressStyle { JunoMobilePressStyle() }
}

/// A staggered rise: fade, 10pt lift and a whisper of blur, `delay` after the
/// view appears. The one entrance the phone uses, so screens arrive with the
/// same cadence everywhere. Collapses to "already there" under Reduce Motion.
private struct JunoMobileRise: ViewModifier {
  let delay: Double
  let distance: CGFloat
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = false

  func body(content: Content) -> some View {
    content
      .opacity(shown || reduceMotion ? 1 : 0)
      .offset(y: shown || reduceMotion ? 0 : distance)
      .blur(radius: shown || reduceMotion ? 0 : 3)
      .onAppear {
        guard !shown else { return }
        if reduceMotion {
          shown = true
        } else {
          withAnimation(JunoMobileMotion.settle.delay(delay)) { shown = true }
        }
      }
  }
}

extension View {
  func junoMobileRise(delay: Double = 0, distance: CGFloat = 10) -> some View {
    modifier(JunoMobileRise(delay: delay, distance: distance))
  }
}

// MARK: - Type

extension View {
  /// The display face: Newsreader, tight tracking, for greetings and page
  /// heroes only. Scales with Dynamic Type against `textStyle`.
  func junoMobileDisplay(
    _ size: CGFloat,
    relativeTo textStyle: Font.TextStyle = .largeTitle,
    face: JunoSerif.Face = .regular
  ) -> some View {
    font(JunoSerif.font(size: size, relativeTo: textStyle, face: face))
      .tracking(-0.02 * size)
      .foregroundStyle(Color.junoForeground)
  }
}

enum JunoMobileType {
  static func display(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
    JunoSerif.font(size: size, relativeTo: style, face: .regular)
  }

  static func displayItalic(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
    JunoSerif.font(size: size, relativeTo: style, face: .italic)
  }
}

// MARK: - Page header

/// The header every secondary page opens with: the page's name in the display
/// face, one line of plain explanation, and an optional trailing action.
///
/// One component so Projects, Library, Artifacts, Tasks, Connections and the
/// settings pages stop disagreeing about size, weight and whether the search
/// field sits above or below the title.
struct JunoMobilePageHeader<Trailing: View>: View {
  let title: LocalizedStringKey
  var subtitle: LocalizedStringKey?
  @ViewBuilder var trailing: () -> Trailing

  init(
    _ title: LocalizedStringKey,
    subtitle: LocalizedStringKey? = nil,
    @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }
  ) {
    self.title = title
    self.subtitle = subtitle
    self.trailing = trailing
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
      VStack(alignment: .leading, spacing: JunoSpace.hairline) {
        Text(title)
          .junoMobileDisplay(34)
          .accessibilityAddTraits(.isHeader)
        if let subtitle {
          Text(subtitle)
            .font(.subheadline)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
      trailing()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A grouped-list section label: small, medium weight, secondary ink, sentence
/// case. Replaces the mix of bold greys, all-caps and serif labels.
struct JunoMobileSectionLabel: View {
  let text: LocalizedStringKey
  init(_ text: LocalizedStringKey) { self.text = text }

  var body: some View {
    Text(text)
      .font(.footnote.weight(.medium))
      .foregroundStyle(Color.junoSecondaryInk)
      .textCase(nil)
      .accessibilityAddTraits(.isHeader)
  }
}

// MARK: - Raised surface

extension View {
  /// The brief's "raised" rung: solid raised fill, hairline, and the two-part
  /// tinted throw (`0 1px 2px` + `0 8px 24px -12px`), never pure black.
  func junoMobileRaised(cornerRadius: CGFloat = 22) -> some View {
    background {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(Color.junoRaised)
        .shadow(color: JunoMobilePalette.shadow.opacity(0.10), radius: 1, y: 1)
        .shadow(color: JunoMobilePalette.shadow.opacity(0.16), radius: 12, y: 8)
    }
    .overlay {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(Color.junoHairline, lineWidth: 0.75)
    }
  }
}

enum JunoMobilePalette {
  /// The warm ground's shadow hue: a deep umber rather than black, so throws
  /// read as the page's own shade.
  static let shadow = Color.junoAdaptive(
    light: JunoColorToken(hsl: (h: 25 / 360, s: 0.35, l: 0.22)),
    dark: JunoColorToken(hsl: (h: 25 / 360, s: 0.2, l: 0.02))
  )

  /// Ink on ink-filled buttons: the canvas, so the pair inverts in dark mode.
  static let onInk = Color.junoCanvas
}

// MARK: - The primary pair

/// The front door's button hierarchy, after Sign in with Apple: one solid ink
/// capsule for the primary path, one hairline capsule for the alternative.
struct JunoMobileInkButtonStyle: ButtonStyle {
  enum Kind { case primary, secondary }
  var kind: Kind = .primary

  func makeBody(configuration: Configuration) -> some View {
    InkBody(kind: kind, configuration: configuration)
  }

  private struct InkBody: View {
    let kind: Kind
    let configuration: Configuration
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      configuration.label
        .font(.body.weight(.semibold))
        .foregroundStyle(kind == .primary ? JunoMobilePalette.onInk : Color.junoForeground)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 54)
        .background {
          Capsule(style: .continuous)
            .fill(kind == .primary ? Color.junoForeground : Color.junoRaised)
        }
        .overlay {
          if kind == .secondary {
            Capsule(style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1)
          }
        }
        .opacity(isEnabled ? 1 : 0.38)
        .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
        .animation(JunoMobileMotion.gated(JunoMobileMotion.press, reduceMotion), value: configuration.isPressed)
        .contentShape(Capsule())
    }
  }
}

// MARK: - Brand backdrop

/// Juno's painted landscape: layered ranges under a dawn sky in light mode and
/// a dusk sky in dark, with film grain over the top.
///
/// Public surfaces only (brief rule 5): the front door and onboarding. If the
/// asset catalog carries the painted plates (`PlateDawn` / `PlateDusk`, from
/// `public/brand/plates/`), those are drawn instead and this procedural
/// painting is only the fallback.
///
/// `drift` slides the ranges at different speeds (parallax by depth), and
/// `rise` 0…1 lifts them into place on entrance; both are driven by the host.
struct JunoMobileLandscape: View {
  var drift: CGFloat = 0
  var rise: CGFloat = 1
  @Environment(\.colorScheme) private var colorScheme

  private var dusk: Bool { colorScheme == .dark }

  var body: some View {
    if let plate = UIImage(named: dusk ? "PlateDusk" : "PlateDawn") {
      Image(uiImage: plate)
        .resizable()
        .scaledToFill()
        .offset(x: drift * 12)
        .overlay { JunoMobileGrain(opacity: dusk ? 0.10 : 0.07) }
        .accessibilityHidden(true)
    } else {
      painted
        .overlay { JunoMobileGrain(opacity: dusk ? 0.12 : 0.09) }
        .accessibilityHidden(true)
    }
  }

  private var palette: LandscapePalette { dusk ? .dusk : .dawn }

  private var painted: some View {
    Canvas(rendersAsynchronously: false) { context, size in
      let w = size.width
      let h = size.height
      let p = palette

      // Sky.
      context.fill(
        Path(CGRect(origin: .zero, size: size)),
        with: .linearGradient(
          Gradient(stops: [
            .init(color: p.skyTop, location: 0),
            .init(color: p.skyMid, location: 0.42),
            .init(color: p.horizon, location: 0.66),
          ]),
          startPoint: .zero, endPoint: CGPoint(x: 0, y: h)
        )
      )

      // Sun and its bloom, low over the ranges.
      let sun = CGPoint(x: w * 0.7 + drift * 4, y: h * (0.55 + (1 - rise) * 0.06))
      context.fill(
        Path(ellipseIn: CGRect(x: sun.x - w * 0.9, y: sun.y - w * 0.9, width: w * 1.8, height: w * 1.8)),
        with: .radialGradient(
          Gradient(colors: [p.glow.opacity(0.55), p.glow.opacity(0.0)]),
          center: sun, startRadius: 0, endRadius: w * 0.9
        )
      )
      context.fill(
        Path(ellipseIn: CGRect(x: sun.x - 26, y: sun.y - 26, width: 52, height: 52)),
        with: .color(p.sun)
      )

      // Soft cloud banks: wide, low-contrast and blurred, so they read as
      // weather rather than as rules drawn across the sky.
      context.drawLayer { layer in
        layer.addFilter(.blur(radius: 14))
        for (index, band) in [(0.20, 0.30), (0.29, 0.78), (0.36, 0.45)].enumerated() {
          let width = w * (0.7 - CGFloat(index) * 0.12)
          let rect = CGRect(
            x: w * CGFloat(band.1) - width / 2 + drift * CGFloat(6 + index * 3),
            y: h * band.0,
            width: width,
            height: h * 0.018
          )
          layer.fill(Path(ellipseIn: rect), with: .color(p.cloud.opacity(0.42 - Double(index) * 0.1)))
        }
      }

      // The ranges, far to near. Each is lighter and hazier the farther it
      // sits, and rises a little later than the one behind it.
      for (index, range) in p.ranges.enumerated() {
        let depth = CGFloat(index + 1)
        let lift = (1 - rise) * (18 + depth * 10)
        let baseY = h * range.base + lift
        let shift = drift * depth * 9
        var path = Path()
        path.move(to: CGPoint(x: 0, y: h))
        var x: CGFloat = -8
        while x <= w + 8 {
          let u = (x + shift) / max(w, 1)
          let y =
            baseY
            + h * range.amplitude * sin(u * range.frequency * .pi * 2 + range.phase)
            + h * range.amplitude * 0.45 * sin(u * range.frequency * 2.7 * .pi * 2 + range.phase * 1.7)
            + h * range.amplitude * 0.18 * sin(u * range.frequency * 7.1 * .pi * 2 + range.phase * 0.6)
          path.addLine(to: CGPoint(x: x, y: y))
          x += 3
        }
        path.addLine(to: CGPoint(x: w + 8, y: h))
        path.closeSubpath()
        context.fill(
          path,
          with: .linearGradient(
            Gradient(colors: [range.color, range.color.mix(with: .black, by: 0.14)]),
            startPoint: CGPoint(x: 0, y: baseY - h * range.amplitude),
            endPoint: CGPoint(x: 0, y: h)
          )
        )
        // Mist pooling in the valley in front of this range.
        context.fill(
          Path(CGRect(x: 0, y: baseY, width: w, height: h * 0.08)),
          with: .linearGradient(
            Gradient(colors: [p.mist.opacity(0.0), p.mist.opacity(0.22), p.mist.opacity(0.0)]),
            startPoint: CGPoint(x: 0, y: baseY), endPoint: CGPoint(x: 0, y: baseY + h * 0.08)
          )
        )
      }
    }
  }
}

private struct LandscapeRange {
  let base: CGFloat
  let amplitude: CGFloat
  let frequency: CGFloat
  let phase: CGFloat
  let color: Color
}

private struct LandscapePalette {
  let skyTop: Color
  let skyMid: Color
  let horizon: Color
  let glow: Color
  let sun: Color
  let cloud: Color
  let mist: Color
  let ranges: [LandscapeRange]

  static func hex(_ value: UInt32) -> Color {
    Color(
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }

  static let dawn = LandscapePalette(
    skyTop: hex(0xEFE6DA),
    skyMid: hex(0xF1D5BD),
    horizon: hex(0xEDB290),
    glow: hex(0xFFE9CF),
    sun: hex(0xFFF4E4),
    cloud: hex(0xFFFFFF),
    mist: hex(0xFBE7D6),
    ranges: [
      LandscapeRange(base: 0.56, amplitude: 0.035, frequency: 1.2, phase: 0.4, color: hex(0xDDAE98)),
      LandscapeRange(base: 0.63, amplitude: 0.04, frequency: 0.9, phase: 2.1, color: hex(0xCB8F78)),
      LandscapeRange(base: 0.71, amplitude: 0.045, frequency: 1.4, phase: 4.0, color: hex(0xAC6B58)),
      LandscapeRange(base: 0.80, amplitude: 0.04, frequency: 0.7, phase: 1.2, color: hex(0x7F4B40)),
      LandscapeRange(base: 0.90, amplitude: 0.03, frequency: 1.1, phase: 5.3, color: hex(0x4E2F2A)),
    ]
  )

  static let dusk = LandscapePalette(
    skyTop: hex(0x15141B),
    skyMid: hex(0x2C2229),
    horizon: hex(0x7A3F31),
    glow: hex(0xE0845A),
    sun: hex(0xF3B48C),
    cloud: hex(0xE9A07C),
    mist: hex(0x9A5A48),
    ranges: [
      LandscapeRange(base: 0.56, amplitude: 0.035, frequency: 1.2, phase: 0.4, color: hex(0x5A3434)),
      LandscapeRange(base: 0.63, amplitude: 0.04, frequency: 0.9, phase: 2.1, color: hex(0x43282C)),
      LandscapeRange(base: 0.71, amplitude: 0.045, frequency: 1.4, phase: 4.0, color: hex(0x301E23)),
      LandscapeRange(base: 0.80, amplitude: 0.04, frequency: 0.7, phase: 1.2, color: hex(0x22161A)),
      LandscapeRange(base: 0.90, amplitude: 0.03, frequency: 1.1, phase: 5.3, color: hex(0x151013)),
    ]
  )
}

/// Seeded film grain. Static (drawn once, no animation) so it costs nothing
/// after the first frame and never reads as "live".
struct JunoMobileGrain: View {
  var opacity: Double = 0.08

  var body: some View {
    Canvas { context, size in
      var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
      func next() -> Double {
        seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Double(seed >> 33) / Double(UInt64(1) << 31)
      }
      let count = Int(size.width * size.height / 9)
      for _ in 0..<count {
        let x = next() * size.width
        let y = next() * size.height
        let light = next() > 0.5
        let alpha = next()
        context.fill(
          Path(CGRect(x: x, y: y, width: 1, height: 1)),
          with: .color((light ? Color.white : Color.black).opacity(alpha))
        )
      }
    }
    .opacity(opacity)
    .blendMode(.overlay)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

// MARK: - Navigation bar type

/// Sets every large navigation title in the display face.
///
/// One appearance-proxy line instead of eleven hand-built headers: Settings,
/// Projects, Tasks and the rest keep the system's own large-title collapse on
/// scroll, and all of them now open on Newsreader rather than on a bold SF
/// that read as a default. Inline titles stay SF, as the system sets them.
enum JunoMobileAppearance {
  @MainActor
  static func install() {
    let size: CGFloat = 34
    guard let base = UIFont(name: JunoSerif.Face.regular.rawValue, size: size) else { return }
    let font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: base)
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .kern: -0.6,
    ]
    UINavigationBar.appearance().largeTitleTextAttributes = attributes
  }
}
