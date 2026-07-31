import JunoAuth
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// Who is signed in, how much of the week's allowance is gone, and the way to
/// both — pinned to the bottom of Juno Code's navigation column.
///
/// Juno Code was the one window in the app with no account chrome at all:
/// switching product hid the reader's name, their plan, whether their work was
/// reaching the account, and every route to Usage and Settings. The website has
/// never had that gap because it has no separate Code *shell* — `app-sidebar.tsx`
/// renders the same `UserMenu` in both modes, so plan and profile stay in the
/// column whichever mode you are in. This does that job in the shape a source
/// list already has a place for.
///
/// It restates Chat's footer rather than sharing one, and that is a debt rather
/// than a decision: the shared component belongs in neither window and lifting
/// Chat's copy out is a change to `DesktopChatWorkspace.swift`. The two are the
/// same layout, the same metrics and the same avatar; only the palette differs,
/// and only because Chat's copy predates the status tokens.
struct DesktopCodeAccountFooter: View {
    let session: NativeAuthenticatedSession
    let avatarModel: NativeAvatarModel?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    /// The account's plan meters. Nil until the first read lands, and the meter
    /// is then absent rather than drawn empty — a bar at zero is a claim about
    /// spend, and "not read yet" is not that claim.
    let plan: DesktopUsagePlan?
    let openUsage: () -> Void
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if let plan {
                DesktopCodeQuotaMeter(plan: plan, open: openUsage)
                    .transition(.opacity)
            }
            accountRow
        }
        .padding(JunoSpace.snug)
    }

    private var accountRow: some View {
        Button(action: openSettings) {
            HStack(spacing: JunoSpace.cozy) {
                ZStack(alignment: .bottomTrailing) {
                    JunoAvatar(
                        imageData: avatarModel?.imageData,
                        imageURL: session.profile.imageURL,
                        name: session.profile.name ?? session.profile.email,
                        size: 26
                    )
                    DesktopCodeSyncDot(syncModel: syncModel)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.profile.name ?? "Juno account")
                        .font(.callout)
                        .lineLimit(1)
                    Text(session.profile.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.hairline)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Account and settings")
        .accessibilityIdentifier("juno.code.account")
    }
}

// MARK: - Quota

/// The plan, and how much of this week's budget is spent, in the website's own
/// dot signature.
///
/// `user-menu.tsx` draws exactly this above its menu rows: the plan's name, a
/// short readout, and a `DotFillBar` whose filled dots are `--primary`. The
/// quantity differs because the native plan route reports *spend windows* rather
/// than a message count, and `weekly` is the window the budget gate actually
/// enforces — so it is the one worth seeing before a turn is refused rather than
/// after.
///
/// Clicking it opens Usage, which is where the number can be interrogated. A
/// meter that cannot be drilled into is a decoration.
struct DesktopCodeQuotaMeter: View {
    let plan: DesktopUsagePlan
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(plan.planName)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    Spacer(minLength: JunoSpace.hairline)
                    Text(readout)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .contentTransition(.numericText())
                }
                if !plan.isBrowseOnly {
                    DesktopCodeDotFillBar(
                        fraction: fraction,
                        tint: tint,
                        dimmed: plan.isUnlimited
                    )
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(plan.planName) plan, \(readout). Opens Usage.")
        .accessibilityIdentifier("juno.code.usage")
    }

    /// An unlimited plan draws a full bar rather than an empty one, because the
    /// honest reading of "no cap" is that nothing is left to run out.
    private var fraction: Double {
        plan.isUnlimited ? 1 : min(1, max(0, plan.weekly.fraction))
    }

    /// Past 90% the meter stops being information and starts being a warning —
    /// the same threshold, and the same colour, the Usage page's plan card uses.
    ///
    /// Read from the plan and not from ``fraction``, which is a *display* value:
    /// an unlimited plan sets it to 1 to draw a full bar, and choosing the tint
    /// from that painted the one account that cannot run out in the amber
    /// reserved for the account that nearly has. The dimming does not rescue it —
    /// 40% of caution is still caution — so the least constrained plan in the
    /// product read as the most alarming, distinguishable only by the "No cap"
    /// beside it. The Usage page never hits this because it draws no meter at all
    /// for an unlimited plan; this footer has one row and shows the bar either way.
    private var tint: Color {
        guard !plan.isUnlimited, fraction >= 0.9 else { return Color.junoAccent }
        return Color.junoCaution
    }

    private var percent: Int { Int((fraction * 100).rounded()) }

    private var readout: String {
        if plan.isBrowseOnly { return "Browse only" }
        if plan.isUnlimited { return "No cap" }
        return "\(percent)% used"
    }

    private var help: String {
        if plan.isBrowseOnly {
            return "Free is a browse-only tier. Open Usage to see your plan."
        }
        if plan.isUnlimited {
            return "No usage limits on this plan. Open Usage for the detail."
        }
        guard let resetsAt = plan.weekly.resetsAt else {
            return "\(percent)% of this week's budget used across all models."
        }
        let day = resetsAt.formatted(date: .abbreviated, time: .omitted)
        return "\(percent)% of this week's budget used across all models — resets \(day)."
    }
}

/// Juno's dot matrix, as a proportion.
///
/// `dot-matrix.tsx` fills `round(ratio × dots)` of eighteen 5px dots in
/// `--primary` and leaves the rest on `--border`. Dots rather than a continuous
/// bar because the matrix is the product's own mark, and because at a sidebar's
/// width a bar two percent full and a bar four percent full are the same three
/// pixels.
struct DesktopCodeDotFillBar: View {
    let fraction: Double
    var tint: Color = .junoAccent
    /// An unlimited plan's full bar, held back so it reads as "not a limit"
    /// rather than as "full". The web dims the same bar for the same reason.
    var dimmed = false

    private static let dots = 18
    private static let diameter: CGFloat = 5
    private static let gap: CGFloat = 3

    private var filled: Int {
        Int((min(1, max(0, fraction.isFinite ? fraction : 0)) * Double(Self.dots)).rounded())
    }

    var body: some View {
        HStack(spacing: Self.gap) {
            ForEach(0..<Self.dots, id: \.self) { index in
                Circle()
                    .fill(index < filled ? tint : Color.junoBorder)
                    .frame(width: Self.diameter, height: Self.diameter)
            }
        }
        .opacity(dimmed ? 0.4 : 1)
        .animation(JunoMotion.standard, value: filled)
        .accessibilityHidden(true)
    }
}

// MARK: - Status dots

/// Whether this Mac's work has reached the account.
///
/// The palette is the one place this deliberately diverges from Chat's footer:
/// that copy reaches for `.green`, `.orange` and `.red`, and Juno has a token for
/// each of those three meanings. When the two footers are finally lifted into one
/// component it is this palette that should survive.
struct DesktopCodeSyncDot: View {
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .help(label)
            .accessibilityLabel(label)
    }

    private var label: String {
        switch syncModel?.phase {
        case .live: "Synced"
        case .synchronizing: "Synchronizing"
        case .offline: "Offline — local changes are queued"
        case .failed: "Synchronization failed"
        case .idle, .none: "Sync idle"
        }
    }

    private var color: Color {
        switch syncModel?.phase {
        case .live: Color.junoSuccess
        case .synchronizing: Color.junoCaution
        case .failed: Color.junoDanger
        case .offline, .idle, .none: Color.secondary
        }
    }
}

/// A live run, as one breathing dot.
///
/// This is the website's mark for the state, verbatim: `TASK_STATUS_META` gives a
/// running task `bg-success motion-safe:animate-pulse`, and reserves hue for the
/// three states worth interrupting a reader for. It replaces a coral caption,
/// which said the same thing in the colour the product spends on primary actions.
struct DesktopCodeRunningDot: View {
    var diameter: CGFloat = 6

    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Tailwind's own `animate-pulse` period — two seconds between full and half
    /// opacity — because that is literally the animation the web applies here.
    private static let period: TimeInterval = 2

    var body: some View {
        Circle()
            .fill(Color.junoSuccess)
            .frame(width: diameter, height: diameter)
            .opacity(dimmed ? 0.5 : 1)
            .animation(
                JunoMotion.reduced(
                    .easeInOut(duration: Self.period / 2).repeatForever(autoreverses: true),
                    when: reduceMotion
                ),
                value: dimmed
            )
            // Guarded rather than relying on the nil animation above: with motion
            // reduced there is no animation to carry the change, so setting it
            // would simply leave the dot permanently half-lit.
            .onAppear { if !reduceMotion { dimmed = true } }
            .accessibilityHidden(true)
    }
}
