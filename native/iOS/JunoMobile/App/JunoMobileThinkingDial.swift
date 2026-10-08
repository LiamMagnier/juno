import JunoChatKit
import JunoDesignSystem
import SwiftUI

// The composer's thinking dial, after ChatGPT's "thinking speed" gauge.
//
// At rest it is one glyph in the composer's row — a gauge whose needle sits at
// the current depth. Tapping it turns the composer's row into a slider with one
// detent per level the selected model offers, with the level's name over the
// composer; the knob is dragged (or a detent tapped) and the row folds back
// into the gauge a moment after the finger lifts.
//
// It replaced a "sliders" chip that opened a popover, and the model chip beside
// it. The model is now chosen from the top of the "+" menu, or by pressing and
// holding the gauge.

/// The gauge in the composer's control row.
struct JunoMobileThinkingDialButton: View {
  let scale: NativeThinkingScale?
  let effort: NativeReasoningEffort?
  let open: () -> Void
  let chooseModel: () -> Void

  var body: some View {
    Button {
      // A model without levels (Auto, or a model that cannot think) has
      // nothing to dial; the honest thing the gauge can offer is the model.
      if scale?.isAdjustable == true { open() } else { chooseModel() }
    } label: {
      JunoMobileDialGlyph(fraction: Self.fraction(scale: scale, effort: effort))
        .foregroundStyle(Color.primary)
        .frame(width: 40, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.junoQuietPress)
    .simultaneousGesture(LongPressGesture(minimumDuration: 0.45).onEnded { _ in chooseModel() })
    .accessibilityLabel("Thinking")
    .accessibilityValue(accessibilityValue)
    .accessibilityHint("Double-tap to set how long Alevr thinks. Touch and hold to choose the model.")
    .accessibilityIdentifier("juno.mobile.chat-thinking")
  }

  private var accessibilityValue: String {
    guard let scale else { return "" }
    if scale.isAutomatic { return "Chosen automatically for each message" }
    return scale.stops.first { $0.effort == effort }?.label ?? "Off"
  }

  /// The needle's position: the current level's place on the model's own
  /// ladder, 0 (instant) to 1 (deepest). Auto sits upright.
  static func fraction(scale: NativeThinkingScale?, effort: NativeReasoningEffort?) -> Double {
    guard let scale, scale.isAdjustable, let index = scale.index(of: effort) else { return 0.5 }
    return Double(index) / Double(max(scale.stops.count - 1, 1))
  }
}

/// The gauge: an open arc and a needle that swings to the current level on the
/// control spring — the one moving part in the composer's row, and the
/// signature of the dial (ChatGPT's "thinking speed" glyph, drawn so the needle
/// can actually travel rather than swapping between four fixed symbols).
struct JunoMobileDialGlyph: View {
  let fraction: Double
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    JunoMobileDialShape(fraction: fraction)
      .stroke(style: StrokeStyle(lineWidth: 1.9, lineCap: .round, lineJoin: .round))
      .frame(width: 21, height: 21)
      .animation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion), value: fraction)
      .frame(width: 24, height: 24)
      .accessibilityHidden(true)
  }
}

/// The gauge as one animatable path: a 270° arc open at the bottom, and a
/// needle from the hub. `fraction` interpolates, so the needle swings rather
/// than jumping when the level changes.
struct JunoMobileDialShape: Shape {
  var fraction: Double

  var animatableData: Double {
    get { fraction }
    set { fraction = newValue }
  }

  func path(in rect: CGRect) -> Path {
    let center = CGPoint(x: rect.midX, y: rect.midY)
    let radius = min(rect.width, rect.height) / 2
    var path = Path()
    // SwiftUI angles run clockwise from 3 o'clock; 135° is the lower left,
    // 405° (45°) the lower right — the gap sits at the bottom.
    path.addArc(
      center: center, radius: radius,
      startAngle: .degrees(135), endAngle: .degrees(405), clockwise: false
    )
    let angle = Angle.degrees(135 + 270 * min(max(fraction, 0), 1)).radians
    let length = radius * 0.56
    path.move(to: center)
    path.addLine(to: CGPoint(x: center.x + cos(angle) * length, y: center.y + sin(angle) * length))
    return path
  }
}

/// The dial, open: a track with one detent per level and a ring knob.
///
/// The knob follows the finger continuously and snaps to the nearest detent
/// with the control spring when it lands; each detent it crosses ticks the
/// selection haptic. VoiceOver gets an adjustable element that steps through
/// the same levels.
struct JunoMobileThinkingDialSlider: View {
  let scale: NativeThinkingScale
  @Binding var effort: NativeReasoningEffort?
  /// Called when the reader is done — the composer folds the row back.
  let close: () -> Void

  @State private var dragX: CGFloat?
  @State private var tick = JunoMobileHapticTrigger()
  @State private var idle = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var index: Int { scale.index(of: effort) ?? 0 }
  private var count: Int { max(scale.stops.count, 1) }

  var body: some View {
    GeometryReader { proxy in
      let inset: CGFloat = 26
      let usable = max(proxy.size.width - inset * 2, 1)
      let step = count > 1 ? usable / CGFloat(count - 1) : 0
      let knobX = dragX ?? (inset + step * CGFloat(index))

      ZStack(alignment: .leading) {
        ForEach(0..<count, id: \.self) { detent in
          Circle()
            .fill(Color.junoSecondaryInk.opacity(detent == index ? 0 : 0.45))
            .frame(width: 6, height: 6)
            .position(x: inset + step * CGFloat(detent), y: proxy.size.height / 2)
        }
        Circle()
          .strokeBorder(Color.primary, lineWidth: 3)
          .background(Circle().fill(Color.junoCanvas))
          .frame(width: 34, height: 34)
          .position(x: knobX, y: proxy.size.height / 2)
          .animation(
            dragX == nil ? JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion) : nil,
            value: index
          )
      }
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            let x = min(max(value.location.x, inset), inset + usable)
            dragX = x
            select(Int(((x - inset) / max(step, 1)).rounded()))
          }
          .onEnded { _ in
            withAnimation(JunoMotion.reduced(JunoMotion.chatControl, when: reduceMotion)) {
              dragX = nil
            }
            idle += 1
          }
      )
    }
    .frame(height: 52)
    .junoHaptic(JunoMobileHaptic.selection, trigger: tick)
    .task(id: idle) {
      // Folds back a moment after the last touch, as ChatGPT's does.
      guard idle > 0 else { return }
      try? await Task.sleep(for: .milliseconds(900))
      guard !Task.isCancelled else { return }
      close()
    }
    .accessibilityElement()
    .accessibilityLabel("Thinking")
    .accessibilityValue(scale.stop(at: index)?.label ?? "")
    .accessibilityAdjustableAction { direction in
      switch direction {
      case .increment: select(index + 1)
      case .decrement: select(index - 1)
      @unknown default: break
      }
    }
    .accessibilityIdentifier("juno.mobile.thinking-dial")
  }

  private func select(_ detent: Int) {
    let clamped = min(max(detent, 0), count - 1)
    guard clamped != index, let stop = scale.stop(at: clamped) else { return }
    tick.fire()
    effort = stop.effort
  }
}

/// The composer's one primary action: voice when there is nothing to send,
/// send the moment there is, stop while a reply is arriving.
///
/// **One button, three faces.** The glyph swaps with `symbolEffect(.replace)`
/// and the glass under it re-tints in place, on the send-morph spring — so the
/// thumb sees the control change, never a control leave and another arrive.
struct JunoMobileComposerPrimaryButton: View {
  enum Face: Equatable {
    case voice
    case send(enabled: Bool)
    case stop
  }

  let face: Face
  let action: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var symbol: String {
    switch face {
    case .voice: "waveform"
    case .send: "arrow.up"
    case .stop: "stop.fill"
    }
  }

  private var enabled: Bool {
    if case .send(let enabled) = face { return enabled }
    return true
  }

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: face == .stop ? 13 : 16, weight: face == .voice ? .bold : .semibold))
        .foregroundStyle(enabled ? Color.junoCanvas : Color.junoSecondaryInk)
        .contentTransition(.symbolEffect(.replace.downUp))
        .frame(width: 36, height: 36)
        .glassEffect(
          .regular.tint(enabled ? Color.primary : Color.junoMuted).interactive(),
          in: Circle()
        )
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .animation(JunoMotion.reduced(JunoMotion.sendMorph, when: reduceMotion, tier: .tint), value: face)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityIdentifier(identifier)
  }

  private var accessibilityLabel: LocalizedStringKey {
    switch face {
    case .voice: "Start voice conversation"
    case .send: "Send message"
    case .stop: "Stop generation"
    }
  }

  private var identifier: String {
    switch face {
    case .voice: "juno.mobile.chat-voice"
    case .send: "juno.mobile.chat-send"
    case .stop: "juno.mobile.chat-stop"
    }
  }
}

/// A tool armed for the next message, shown inside the field the way ChatGPT
/// shows a chosen tool: its glyph and name in the accent ink, and an × that
/// disarms it. No capsule — it is part of what is being typed, not a status.
struct JunoMobileComposerToken: View {
  let symbol: String
  let title: String
  let remove: () -> Void

  var body: some View {
    Button(action: remove) {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 13, weight: .regular))
        Text(title)
          .junoFont(size: 15, relativeTo: .subheadline)
        Image(systemName: "xmark")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Color.junoSecondaryInk)
      }
      .foregroundStyle(Color.junoAccent)
      .frame(minHeight: 32)
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityLabel("\(title), armed")
    .accessibilityHint("Removes it from the next message")
  }
}
