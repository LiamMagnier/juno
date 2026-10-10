import JunoChatKit
import JunoDesignSystem
import SwiftUI

// The composer's thinking dial, after ChatGPT's "thinking speed" gauge.
//
// At rest it is one glyph in the composer's row — a gauge whose needle sits at
// the current depth. What a tap opens is the Mac's and the web's rule
// (``JunoModelPickerStage/first(for:modality:)``): a model with levels opens
// the Thinking panel, whose model name opens the catalogue; any other model
// (Auto, one level) opens the catalogue straight away. Pressing and holding
// the gauge always opens the catalogue.

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
      if Self.opensPanel(scale) { open() } else { chooseModel() }
    } label: {
      // 19pt at a 1.6pt stroke: the weight of the SF Symbols beside it.
      JunoDialGlyph(fraction: Self.fraction(scale: scale, effort: effort), size: 19, lineWidth: 1.6)
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

  /// Whether a tap opens the Thinking panel rather than the catalogue: the
  /// shared two-stage rule the Mac's and the web's model chip follow.
  static func opensPanel(_ scale: NativeThinkingScale?) -> Bool {
    guard let scale else { return false }
    return JunoModelPickerStage.first(for: scale.junoLadder) == .effort
  }

  /// The needle's position: the current level's place on the model's own
  /// ladder, 0 (instant) to 1 (deepest). Auto sits upright.
  static func fraction(scale: NativeThinkingScale?, effort: NativeReasoningEffort?) -> Double {
    guard let scale, scale.isAdjustable, let index = scale.index(of: effort) else { return 0.5 }
    return Double(index) / Double(max(scale.stops.count - 1, 1))
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

  /// The web composer's own faces: the waveform, the up arrow, the stop.
  private var icon: JunoIcon {
    switch face {
    case .voice: .audioLines
    case .send: .arrowUp
    case .stop: .stop
    }
  }

  private var enabled: Bool {
    if case .send(let enabled) = face { return enabled }
    return true
  }

  var body: some View {
    Button(action: action) {
      JunoIconView(icon, size: face == .stop ? 14 : 18, weight: face == .stop ? .fill : .bold)
        .foregroundStyle(enabled ? Color.junoCanvas : Color.junoSecondaryInk)
        .id(icon)
        .transition(.scale(scale: 0.6).combined(with: .opacity))
        .frame(width: 36, height: 36)
        .modifier(JunoComposerSendBackground(active: enabled, tint: Color.primary))
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
  let icon: JunoIcon
  let title: String
  let remove: () -> Void

  var body: some View {
    Button(action: remove) {
      HStack(spacing: JunoSpace.hairline) {
        JunoIconView(icon, size: 14)
        Text(title)
          .junoFont(size: 15, relativeTo: .subheadline)
        JunoIconView(.close, size: 10)
          .foregroundStyle(Color.junoSecondaryInk)
      }
      .foregroundStyle(Color.junoAccent)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityLabel("\(title), armed")
    .accessibilityHint("Removes it from the next message")
  }
}
