import JunoDesignSystem
import SwiftUI

/// A tab's label: the destination's own Lucide mark and its title.
///
/// The mark comes from the same generated set every other surface uses, so
/// the tab bar, the iPad sidebar and the Mac's product switcher draw one
/// glyph per product.
struct JunoMobileTabLabel: View {
  let section: JunoMobileSection

  var body: some View {
    Label {
      Text(section.title)
    } icon: {
      Image(section.junoIcon.assetName)
        .renderingMode(.template)
    }
  }
}

/// What is live across the products right now, for the tab bar's accessory.
struct JunoMobileLiveRun: Equatable {
  /// Runs in flight, Work and Code together.
  let running: Int
  /// Runs stopped on a question or an approval.
  let needsYou: Int
  /// The product the pill opens.
  let section: JunoMobileSection
}

/// The persistent "a run is in progress" pill above the tab bar.
///
/// The one place a phone can say, whatever screen it is on, that Juno is doing
/// something elsewhere and whether it is stuck on you. It reads as static text
/// on purpose — count, then verdict — so a still frame explains it; the only
/// motion is the breathing dot, which is the one ambient loop the screen is
/// allowed and which stops under Reduce Motion.
struct JunoMobileLiveRunPill: View {
  let run: JunoMobileLiveRun
  let open: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button(action: open) {
      HStack(spacing: JunoSpace.snug) {
        JunoMobileLiveDot(active: run.running > 0, attention: run.needsYou > 0)
        Text(headline)
          .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
        if run.needsYou > 0 {
          Text(attention)
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .foregroundStyle(Color.junoAccent)
            .lineLimit(1)
        }
        Spacer(minLength: JunoSpace.tight)
        JunoIconView(.chevronRight, size: 13)
          .foregroundStyle(Color.junoMutedForeground)
      }
      .padding(.horizontal, JunoSpace.regular)
      .frame(maxWidth: .infinity, minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text("\(headline). \(run.needsYou > 0 ? attention : "")"))
    .accessibilityIdentifier("juno.mobile.live-run")
  }

  private var headline: String {
    switch run.running {
    case 0: return run.section == .code ? String(localized: "Code") : String(localized: "Work")
    case 1: return String(localized: "1 run in progress")
    default: return String(localized: "\(run.running) runs in progress")
    }
  }

  private var attention: String {
    run.needsYou == 1
      ? String(localized: "1 needs you")
      : String(localized: "\(run.needsYou) need you")
  }
}

/// The dot: accent while something is running, amber when something waits on
/// the reader, and a slow breath only while live.
private struct JunoMobileLiveDot: View {
  let active: Bool
  let attention: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 20, paused: !active || reduceMotion)) { context in
      let phase = active && !reduceMotion ? breath(at: context.date) : 1
      Circle()
        .fill(attention ? Color.junoCaution : Color.junoAccent)
        .frame(width: 8, height: 8)
        .scaleEffect(0.85 + 0.15 * phase)
        .opacity(0.7 + 0.3 * phase)
    }
    .frame(width: 12, height: 12)
    .accessibilityHidden(true)
  }

  /// One breath every 1.6s — inside the brief's 1.2–2.0s window.
  private func breath(at date: Date) -> Double {
    let t = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
    return 0.5 + 0.5 * sin(t * 2 * .pi)
  }
}
