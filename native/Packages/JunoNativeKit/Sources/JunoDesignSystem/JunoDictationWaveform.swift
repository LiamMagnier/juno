import SwiftUI

// Dictation's waveform, shared by the iPhone and the Mac so the two listen
// the same way.
//
// Host usage: put it in the accessory row between the row's ✕ and ✓, give it
// the row's height and let it fill the width:
//
//     JunoDictationWaveform(samples: history, active: listening)
//         .frame(maxWidth: .infinity)
//         .frame(height: 44)
//
// `samples` is speech loudness 0...1, newest last, one per meter tick (30 Hz):
// `JunoSpeechService.loudnessHistory`, or a history the host keeps of any
// level with `JunoDictationWaveform.appending(_:to:)`.

/// The live waveform: thin rounded bars, one per meter tick, flowing in from
/// the right and filling the row's width.
///
/// A still room looks still: below speech loudness a bar sits at its floor,
/// so the row only moves when you do. The oldest bars fade at the leading
/// edge instead of being cut off. Reduce Motion holds every bar at rest.
public struct JunoDictationWaveform: View {
  /// Speech loudness, 0...1, newest last.
  let samples: [Double]
  let active: Bool

  public init(samples: [Double], active: Bool = true) {
    self.samples = samples
    self.active = active
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public static let historyCapacity = 72
  public static let barWidth: CGFloat = 2.5
  public static let gap: CGFloat = 2.5
  public static let minimumHeight: CGFloat = 2.5
  public static let maximumHeight: CGFloat = 24

  /// A sample's bar height. Below the floor is a room, not a voice; above it
  /// a soft curve, so a word's onset rises rather than switching on.
  public static func height(for loudness: Double) -> CGFloat {
    let floor = 0.12
    guard loudness > floor else { return minimumHeight }
    let x = min(1, (loudness - floor) / (0.8 - floor))
    return minimumHeight + CGFloat(pow(x, 0.8)) * (maximumHeight - minimumHeight)
  }

  public var body: some View {
    Canvas { context, size in
      let pitch = Self.barWidth + Self.gap
      let count = max(1, Int((size.width + Self.gap) / pitch))
      let recent = Array(samples.suffix(count))
      let ink = active ? Color.junoForeground : Color.junoSecondaryInk
      let midY = size.height / 2
      // Right-aligned: the newest sample sits against the ✓.
      let leading = size.width - CGFloat(count) * pitch + Self.gap
      for slot in 0..<count {
        let sampleIndex = recent.count - count + slot
        let loudness = sampleIndex >= 0 && !reduceMotion && active ? recent[sampleIndex] : 0
        let height = Self.height(for: loudness)
        let x = leading + CGFloat(slot) * pitch
        let rect = CGRect(x: x, y: midY - height / 2, width: Self.barWidth, height: height)
        // The leading fifth fades out, so the past leaves softly.
        let fade = min(1, Double(slot) / max(1, Double(count) * 0.2))
        context.fill(
          Path(roundedRect: rect, cornerRadius: Self.barWidth / 2),
          with: .color(ink.opacity((active ? 0.3 : 0.2) + (active ? 0.7 : 0.35) * fade))
        )
      }
    }
    .accessibilityHidden(true)
  }
}

extension JunoDictationWaveform {
    /// `history` with `value` added, trimmed to ``historyCapacity``.
    public static func appending(_ value: Double, to history: [Double]) -> [Double] {
        var next = history
        next.append(value)
        if next.count > historyCapacity { next.removeFirst(next.count - historyCapacity) }
        return next
    }
}
