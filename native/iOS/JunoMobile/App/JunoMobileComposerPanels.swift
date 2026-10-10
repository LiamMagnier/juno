import JunoChatKit
import JunoDesignSystem
import SwiftUI

// The composer's two floating glass panels — the "+" panel and the Thinking
// panel — and the one motion they share.
//
// Both stand on the composer card's top edge, in the card's glass container,
// and both grow out of the control that opened them: the "+" panel out of the
// "+", the Thinking panel out of the dial. Closing runs the same path back
// into the control. Before this, the "+" panel scaled from its own corner, a
// point 8pt above the card and nowhere near the button, so it seemed to
// arrive from nowhere (owner, Oct 10).

/// The composer card's coordinate space: the controls report their centres
/// in it and the panels measure their own frames in it, so a panel knows
/// where its control is without either knowing the other's size.
enum JunoMobileComposerSpace {
  static let card = "juno.mobile.composer.card"
}

// MARK: - Bloom

/// A panel blooming out of a control and folding back into it.
///
/// The scale's anchor is the control's centre expressed in the panel's own
/// unit square, so it usually lies outside the panel (below it, since the
/// panels stand above the card). `visualEffect` reads the panel's laid-out
/// frame at render time, which is what lets one transition serve both panels
/// without a measuring pass first.
///
/// Reduce Motion: a cross-fade, with no scale and no blur.
struct JunoMobileBloomTransition: Transition {
  /// The control's centre in ``JunoMobileComposerSpace/card``; nil before it
  /// has been measured, when the panel grows from its own bottom edge.
  var origin: CGPoint?
  var reduceMotion: Bool

  /// How small the panel is at the control: about the glyph's own size.
  static let collapsedScale: CGFloat = 0.12
  static let collapsedBlur: CGFloat = JunoSpace.tight

  func body(content: Content, phase: TransitionPhase) -> some View {
    let shown = phase.isIdentity || reduceMotion
    let origin = origin
    let scale = shown ? 1 : Self.collapsedScale
    let blur = shown ? 0 : Self.collapsedBlur
    return content
      .visualEffect { effect, proxy in
        let frame = proxy.frame(in: .named(JunoMobileComposerSpace.card))
        var anchor = UnitPoint.bottom
        if let origin, frame.width > 0, frame.height > 0 {
          anchor = UnitPoint(
            x: (origin.x - frame.minX) / frame.width,
            y: (origin.y - frame.minY) / frame.height
          )
        }
        return effect
          .scaleEffect(scale, anchor: anchor)
          .blur(radius: blur)
      }
      .opacity(phase.isIdentity ? 1 : 0)
  }
}

extension JunoMotion {
  /// A composer panel opening: the emphasized spring, whose small bounce is
  /// the bloom settling. Reduce Motion: the travel substitute (a fade).
  static func panelOpen(reduceMotion: Bool) -> Animation? {
    reduced(emphasized, when: reduceMotion)
  }

  /// A composer panel closing back into its control: the control spring,
  /// faster than the opening, with no overshoot.
  static func panelClose(reduceMotion: Bool) -> Animation? {
    reduced(chatControl, when: reduceMotion)
  }
}

/// A panel's rows arriving just behind its glass: each a few points lower and
/// clear, then in place, 24ms apart. Opacity alone under Reduce Motion.
private struct JunoMobileBloomRow: ViewModifier {
  let index: Int
  let shown: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .opacity(shown ? 1 : 0)
      .offset(y: shown || reduceMotion ? 0 : JunoSpace.tight)
      .animation(
        JunoMotion.reduced(JunoMotion.chatLayout, when: reduceMotion, tier: .tint)?
          .delay(shown ? 0.05 + Double(index) * 0.024 : 0),
        value: shown
      )
  }
}

extension View {
  /// One row of a blooming panel; see ``JunoMobileBloomRow``.
  func junoMobileBloomRow(_ index: Int, shown: Bool) -> some View {
    modifier(JunoMobileBloomRow(index: index, shown: shown))
  }

  /// Reports this control's centre in the composer card's space.
  func junoMobileComposerOrigin(_ origin: Binding<CGPoint?>) -> some View {
    onGeometryChange(for: CGPoint.self) { proxy in
      let frame = proxy.frame(in: .named(JunoMobileComposerSpace.card))
      return CGPoint(x: frame.midX, y: frame.midY)
    } action: { origin.wrappedValue = $0 }
  }
}

// MARK: - Thinking panel

/// The dial, open: the Mac and web effort panel, drawn for a thumb.
///
/// The rung named large with the model under it — the model's name is the
/// way to the full catalogue — and, on the header's left, the speed bolt and
/// Pro, as the Mac and the web draw them (``JunoEffortSpeedButton``,
/// ``JunoEffortProCapsule``): one press of the bolt moves Off → Fast (one
/// bolt) → Ultra fast (two bolts), Pro is a capsule beside it, and there is no
/// row or submenu under the track (owner: "move the ultra fast and pro next
/// to the actual flash icon … no submenu"). Reset sits on the right. Then the
/// effort track: a full capsule whose ground is always visible, filled up to
/// the knob (``JunoEffortSlider``, the same control the Mac draws).
///
/// It replaced a row of dots with a ring knob drawn straight on the
/// composer's glass, which showed the knob and nothing it travelled along,
/// and which folded itself away 900ms after the finger lifted — too soon to
/// reach a model name or a switch beside it.
struct JunoMobileThinkingPanel: View {
  let scale: NativeThinkingScale
  @Binding var effort: NativeReasoningEffort?
  /// Fast, drawn only where the model publishes a rate for it.
  var fastMode: Binding<Bool>?
  /// Ultra fast (OpenAI's Ultrafast tier), exclusive with Fast.
  var ultraFast: Binding<Bool>?
  /// Pro, drawn only where the ladder supports it.
  var proMode: Binding<Bool>?
  let modelName: String
  var providerID: String = "juno"
  var providerName: String = "Alevr"
  /// Opens the full catalogue; the composer closes this panel first.
  let openModels: () -> Void

  @State private var rowsIn = false
  @State private var tick = JunoMobileHapticTrigger()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var ladder: JunoThinkingLadder { scale.junoLadder }

  private var stopID: Binding<String?> {
    Binding(
      get: { scale.stopID(for: effort) ?? ladder.defaultStopID ?? ladder.stops.first?.id },
      set: { effort = scale.effort(forStopID: $0) }
    )
  }

  private var current: NativeThinkingStop? { scale.stops.first { $0.effort == effort } }
  private var showsFast: Bool { fastMode != nil && ladder.supportsFastMode }
  private var showsUltra: Bool { JunoEffortPanel.showsUltraFast(ladder: ladder, ultraFast: ultraFast) }
  private var showsPro: Bool { JunoEffortPanel.showsPro(ladder: ladder, proMode: proMode) }

  private var speedTier: JunoSpeedTier {
    if showsUltra, ultraFast?.wrappedValue == true { return .ultra }
    if showsFast, fastMode?.wrappedValue == true { return .fast }
    return .off
  }

  /// One press, one tier: the shared cycle, Fast and Ultra fast never both on.
  private func cycleSpeed() {
    tick.fire()
    switch speedTier.next(hasFast: showsFast, hasUltra: showsUltra) {
    case .fast:
      ultraFast?.wrappedValue = false
      fastMode?.wrappedValue = true
    case .ultra:
      fastMode?.wrappedValue = false
      ultraFast?.wrappedValue = true
    case .off:
      fastMode?.wrappedValue = false
      ultraFast?.wrappedValue = false
    }
  }
  private var canReset: Bool {
    guard let defaultStopID = ladder.defaultStopID else { return false }
    return stopID.wrappedValue != defaultStopID
  }

  var body: some View {
    VStack(spacing: JunoSpace.cozy) {
      header
        .junoMobileBloomRow(0, shown: rowsIn)
      JunoEffortSlider(ladder: ladder, stopID: stopID)
        // The track is 36pt; the finger gets the 44pt row around it.
        .padding(.vertical, JunoSpace.hairline)
        .contentShape(Rectangle())
        .accessibilityIdentifier("juno.mobile.thinking-dial")
        .junoMobileBloomRow(1, shown: rowsIn)
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.vertical, JunoSpace.cozy)
    .frame(maxWidth: .infinity)
    // No glass of its own: the composer lays it on, inside the card's glass
    // container (`junoMobilePanelGlass`), so the panel and the card are one
    // material.
    .junoHaptic(JunoMobileHaptic.selection, trigger: tick)
    .onAppear { rowsIn = true }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Thinking")
    .accessibilityIdentifier("juno.mobile.thinking-panel")
  }

  private var header: some View {
    HStack(spacing: JunoSpace.snug) {
      HStack(spacing: 0) {
        if showsFast || showsUltra {
          JunoEffortSpeedButton(
            tier: speedTier,
            multiplier: speedTier == .ultra ? ladder.ultraFastRateMultiplier : ladder.fastModeRateMultiplier,
            hitSide: JunoLayout.touchTarget,
            action: cycleSpeed
          )
          .accessibilityIdentifier("juno.mobile.thinking-speed")
        }
        if showsPro, let proMode {
          JunoEffortProCapsule(
            isOn: Binding(get: { proMode.wrappedValue }, set: { tick.fire(); proMode.wrappedValue = $0 }),
            hitHeight: JunoLayout.touchTarget
          )
          .accessibilityIdentifier("juno.mobile.thinking-pro")
        }
      }
      .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)

      VStack(spacing: 0) {
        levelName
          .accessibilityHidden(true)
        modelButton
      }
      // Sized to the rung and the model's name, as the Mac's header is: the
      // side groups share what is left, so the name is never cut for them.
      .fixedSize(horizontal: true, vertical: false)
      .layoutPriority(1)

      roundButton(
        icon: .rotateCcw,
        isOn: false,
        label: "Reset to the model's default",
        identifier: "juno.mobile.thinking-reset"
      ) {
        guard let defaultStopID = ladder.defaultStopID else { return }
        tick.fire()
        stopID.wrappedValue = defaultStopID
      }
      .disabled(!canReset)
      .opacity(canReset ? 1 : 0.35)
      .frame(minWidth: 0, maxWidth: .infinity, alignment: .trailing)
    }
  }

  /// The rung's name, large. The deepest rung ("Max") wears the web's
  /// top-tier ramp (`--ultra-from` → `--ultra-to`), as the web's effort
  /// panel draws it; every other rung is ink.
  private var levelName: some View {
    let word = Text(verbatim: current?.label ?? scale.stops.first?.label ?? "")
      .junoFont(size: 17, relativeTo: .headline, weight: .semibold)
      .monospacedDigit()
    let deepest = scale.stops.count > 1 && current != nil && current == scale.stops.last
    return word
      .foregroundStyle(
        deepest
          ? AnyShapeStyle(LinearGradient(
            colors: [
              Color.junoAdaptive(JunoGeneratedColors.ultraFrom),
              Color.junoAdaptive(JunoGeneratedColors.ultraTo),
            ],
            startPoint: .leading,
            endPoint: .trailing
          ))
          : AnyShapeStyle(Color.junoForeground)
      )
      .lineLimit(1)
      .contentTransition(.opacity)
      .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: current)
  }

  /// The model, and the way to every other: the lab's mark, the name and a
  /// chevron on a quiet capsule, so it reads as something to press.
  private var modelButton: some View {
    Button(action: openModels) {
      HStack(spacing: JunoSpace.tight) {
        if JunoMobileModelSelectorView.isOwnProvider(providerID) {
          JunoMark(size: 14)
        } else {
          JunoProviderMark(providerID: providerID, providerName: providerName, size: 14)
        }
        Text(verbatim: modelName)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
          .lineLimit(1)
          .truncationMode(.tail)
        JunoIconView(.chevronRight, size: 12)
          .foregroundStyle(Color.junoTertiaryInk)
      }
      .foregroundStyle(Color.junoSecondaryInk)
      .padding(.horizontal, JunoSpace.cozy)
      .frame(minHeight: JunoLayout.Control.compactHeight)
      .background(Color.primary.opacity(0.06), in: Capsule())
      .frame(minHeight: JunoLayout.touchTarget)
      .contentShape(Capsule())
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityLabel("Change model")
    .accessibilityValue(modelName)
    .accessibilityIdentifier("juno.mobile.thinking-models")
  }

  private func roundButton(
    icon: JunoIcon,
    isOn: Bool,
    label: String,
    identifier: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      JunoIconView(icon, size: 18)
        .foregroundStyle(isOn ? Color.junoCanvas : Color.junoForeground)
        .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
        .background(
          Circle().fill(isOn ? Color.junoForeground : Color.primary.opacity(0.06))
        )
        .contentShape(Circle())
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isOn)
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityLabel(Text(verbatim: label))
    .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier(identifier)
  }
}

/// The two panels' shared geometry.
enum JunoMobileComposerPanelMetrics {
  /// Concentric with the composer card's 24pt corners, one inset out.
  static let radius: CGFloat = JunoSpace.wide
  /// The "+" panel's width: wide enough for "Deep research" and a check.
  static let plusWidth: CGFloat = 264
}
