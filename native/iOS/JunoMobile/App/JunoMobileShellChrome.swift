import JunoDesignSystem
import SwiftUI

/// A tab's label: the destination's own mark and its title.
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

/// Installs the live-run pill as the tab bar's bottom accessory.
///
/// `tabViewBottomAccessory(isEnabled:)` is 26.1; on 26.0 the accessory is
/// installed unconditionally and simply has no content while nothing is
/// live. The pill and the shell never see the difference.
struct JunoMobileLiveRunAccessory: ViewModifier {
  let run: JunoMobileLiveRun?
  let open: (JunoMobileSection) -> Void

  func body(content: Content) -> some View {
    if #available(iOS 26.1, *) {
      content.tabViewBottomAccessory(isEnabled: run != nil) { pill }
    } else {
      content.tabViewBottomAccessory { pill }
    }
  }

  @ViewBuilder
  private var pill: some View {
    if let run {
      JunoMobileLiveRunPill(run: run) { open(run.section) }
    }
  }
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
        // No breathing dot: in-progress work is said by the words, with a
        // quiet shimmer on the line while something is running. Only the
        // attention half keeps a colour, led by its own symbol.
        JunoShimmerText(
          headline,
          font: .subheadline.weight(.medium),
          active: run.running > 0 && !reduceMotion
        )
        .lineLimit(1)
        if run.needsYou > 0 {
          HStack(spacing: 4) {
            Image(systemName: "exclamationmark.circle.fill")
              .imageScale(.small)
              .accessibilityHidden(true)
            Text(attention)
          }
          .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
          .foregroundStyle(Color.junoCaution)
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

