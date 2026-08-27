import JunoAuth
import JunoChatKit
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// A staged update, who is signed in, how much of the week's allowance is gone,
/// and the way to all three — pinned to the bottom of the navigation column.
///
/// **One footer, both columns.** Chat and Code each carried their own copy of
/// this, and the copies had already drifted: two accessibility identifiers for
/// the same button, two sync-dot palettes for the same five states (one on the
/// status tokens, one on `.green`/`.orange`/`.red`), and a quota meter that
/// existed in one column and not the other. The website has never had that gap
/// because it has no separate Code *shell* — `app-sidebar.tsx` renders the same
/// `UserMenu` in both modes. This is that: one component, one set of metrics,
/// nothing left to drift.
///
/// The rows are ordered news-first: an update, then the meter, then the account.
/// The row with the reader's own name on it is furniture, and an update
/// announced *below* it would be reporting the one piece of news in the quietest
/// place on screen.
///
/// Nothing here paints a background. The column is a vibrant region and stays
/// one all the way to its bottom edge — see ``SwiftUI/View/junoSidebarScrollEdge()``
/// for what replaced the opaque bar that used to sit under these rows.
struct DesktopSidebarFooter: View {
    let session: NativeAuthenticatedSession
    let avatarModel: NativeAvatarModel?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    /// The account's plan meters. Nil until the first read lands — or, in the
    /// chat column, because that column has no plan model to read. The meter is
    /// then absent rather than drawn empty: a bar at zero is a claim about spend,
    /// and "not read yet" is not that claim.
    let plan: DesktopUsagePlan?
    let openUsage: () -> Void
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            DesktopUpdateReadyRow()
            if let plan {
                DesktopSidebarQuotaMeter(plan: plan, open: openUsage)
                    .transition(.opacity)
            }
            DesktopSidebarAccountRow(
                session: session,
                avatarModel: avatarModel,
                syncModel: syncModel,
                open: openSettings
            )
        }
        .padding(JunoSpace.snug)
    }
}

// MARK: - Account

/// Who is signed in, whether this Mac's work has reached them, and the way to
/// Settings.
struct DesktopSidebarAccountRow: View {
    let session: NativeAuthenticatedSession
    let avatarModel: NativeAvatarModel?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let open: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.cozy) {
                JunoAvatar(
                    imageData: avatarModel?.imageData,
                    imageURL: session.profile.imageURL,
                    name: session.profile.name ?? session.profile.email,
                    size: 26
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.profile.name ?? "Juno account")
                        .font(.callout)
                        .lineLimit(1)
                    Text(session.profile.email)
                        .font(.caption)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }
                Spacer(minLength: JunoSpace.hairline)
                JunoIconView(.chevronRight, size: 11)
                    .junoMetaInk()
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(isHovering ? Color.junoSidebarSelection : .clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(JunoMotion.standard, value: isHovering)
        .help("Account and settings")
        // The launch UI suite finds the window by this button. It is the chat
        // column's original identifier, kept when the two footers merged so the
        // test did not have to be taught a new name for the same control.
        .accessibilityIdentifier("Account and settings")
    }
}

// MARK: - Update

/// The one row that says a new Juno is already downloaded and one relaunch away.
///
/// ``DesktopUpdateModel`` has always done the work — poll, download, verify the
/// signature, stage the bundle — and then offered the swap only from the
/// application menu, under About. Nobody opens that menu to find out an update
/// is waiting, so a build that had been ready for a week looked identical to one
/// that was current. This is the same action where the reader already is.
///
/// **Only `.ready` draws anything.** Not `.checking`, not `.downloading`: a row
/// that is permanently present is chrome the eye learns to skip, and a progress
/// spinner for a download nobody asked to watch turns a deliberately quiet
/// updater into an interruption. The rest of the ladder stays in the menu, where
/// someone who went looking for it will find it.
///
/// **It is a sidebar row, not a poster.** Two earlier passes at this drew a
/// callout: a tinted panel, a glyph in its own tinted chip, a bordered edge, and
/// a coral capsule button — a stack of containers, each one added to make the
/// last one look deliberate. In a 264pt column it was the loudest thing on
/// screen and it was announcing a routine event; worse, an opaque tinted block
/// is the one shape a vibrant column cannot absorb.
///
/// So the containers are gone. What is left is the account row's own anatomy —
/// a 26pt mark, a title, a quieter second line, the same insets, the same hover
/// fill the list uses for selection — which makes the two rows read as one
/// footer rather than as a notice sitting on top of one. The single piece of
/// colour is the mark, and it is Juno's own: what is waiting is a new Juno, and
/// the mark is what the reader will see in the Dock a second after they click.
struct DesktopUpdateReadyRow: View {
    /// `@State` rather than a bare reference to the singleton, so the row
    /// re-evaluates when the phase changes. `JunoDesktopCommands` holds the same
    /// object the same way for the same reason.
    @State private var updater = DesktopUpdateModel.shared
    @State private var isHovering = false

    @ViewBuilder
    var body: some View {
        if case .ready(let version) = updater.phase {
            Button {
                updater.installAndRelaunch()
            } label: {
                HStack(spacing: JunoSpace.cozy) {
                    JunoMark(size: 17)
                        .foregroundStyle(Color.junoAccent)
                        // The avatar's slot, to the point, so the two rows share
                        // one left edge for their text.
                        .frame(width: 26, height: 26)

                    VStack(alignment: .leading, spacing: 1) {
                        Text("Relaunch to update")
                            .font(.callout)
                            .lineLimit(1)
                        Text("Version \(version)")
                            .font(.caption)
                            .junoSecondaryInk()
                            .lineLimit(1)
                    }
                    Spacer(minLength: JunoSpace.hairline)
                }
                .padding(.horizontal, JunoSpace.snug)
                .padding(.vertical, JunoSpace.tight)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                        .fill(isHovering ? Color.junoSidebarSelection : .clear)
                )
                .contentShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
            }
            .buttonStyle(.plain)
            .onHover { isHovering = $0 }
            .animation(JunoMotion.standard, value: isHovering)
            .help("Juno \(version) is downloaded and verified. This quits Juno and opens it again on the new version.")
            .transition(.opacity)
            .accessibilityLabel("Relaunch to update Juno to \(version)")
            .accessibilityHint("Juno will quit and reopen with the downloaded update.")
            .accessibilityIdentifier("juno.desktop.update-ready")
        }
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
struct DesktopSidebarQuotaMeter: View {
    let plan: DesktopUsagePlan
    let open: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    // Not monospaced. A plan's name and "62% used" are labels,
                    // and the code face on a label is what makes a product
                    // read as a debug console — it is reserved here for code,
                    // paths and terminal output and nothing else. The digits
                    // still hold their column: `monospacedDigit()` fixes the
                    // figure widths without changing the face, which is the
                    // only thing the code face was buying.
                    Text(plan.planName)
                        .junoCaption()
                    Spacer(minLength: JunoSpace.hairline)
                    Text(readout)
                        .junoCaption()
                        .monospacedDigit()
                        .lineLimit(1)
                        .contentTransition(.numericText())
                }
                if !plan.isBrowseOnly {
                    DesktopSidebarDotFillBar(
                        fraction: fraction,
                        tint: tint,
                        dimmed: plan.isUnlimited
                    )
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(isHovering ? Color.junoSidebarSelection : .clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(JunoMotion.standard, value: isHovering)
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
struct DesktopSidebarDotFillBar: View {
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
/// On the status tokens rather than on `.green`/`.orange`/`.red`. The chat
/// column's copy of this reached for the raw system colours, and Juno has a
/// token for each of those three meanings — so the same five sync states were
/// drawn in two palettes depending on which product the reader was in. This is
/// the palette that survived the merge.
struct DesktopSidebarSyncDot: View {
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
        case .offline, .idle, .none: Color.junoMutedForeground
        }
    }
}

/// A live run, as one breathing dot.
///
/// This is the website's mark for the state, verbatim: `TASK_STATUS_META` gives a
/// running task `bg-success motion-safe:animate-pulse`, and reserves hue for the
/// three states worth interrupting a reader for. It replaces a coral caption,
/// which said the same thing in the colour the product spends on primary actions.
///
/// **One of these per screen, and only where something is genuinely changing.**
/// A pulse over a wedged run says exactly what a pulse over a healthy one says,
/// so it is never the only thing reporting progress — the surfaces that use it
/// carry the step, the elapsed time and the last action as static text beside
/// it. Run rows in the source list deliberately do *not* use it: dozens of
/// synchronized loops in one column is decoration, and their mark is
/// `CodeStatusGlyph`, which is still.
struct DesktopCodeRunningDot: View {
    var diameter: CGFloat = 6

    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The ambient loop's period. Two seconds between full and half opacity,
    /// which is the top of the 1.2–2.0s band the motion system allows a loop —
    /// slow enough to read as breathing rather than as blinking.
    /// The breath's full cycle, built from the ladder rather than written as a
    /// literal — which is what the note below already claimed and what the
    /// motion gate checks for. It was `2` until the gate flagged it.
    ///
    /// `emphasis` is the ladder's slowest rung at 560ms; a loop wants to be a
    /// small multiple of a rung rather than a number of its own, so this is
    /// 4× it — 2.24s, inside the 1.2–2.0s-per-cycle band the agentic motion
    /// rules ask for once you count a single direction of an autoreversing
    /// animation (1.12s each way).
    private static let period: TimeInterval = JunoMotion.Duration.emphasis * 4

    /// The one animation in the product that is a `repeatForever`, and the only
    /// place a duration is written rather than named.
    ///
    /// A ladder rung would be wrong here and the ladder says so: every rung is
    /// a *transition* between two states, 70ms to 560ms, and this is neither a
    /// transition nor in that range. It is built from `JunoMotion.Duration`'s
    /// own arithmetic and passed through `reduced(_:when:tier:)` at the
    /// `ambient` tier, which is the tier that exists precisely for this — under
    /// Reduce Motion an ambient loop does not want to be faster, it wants to
    /// stop, and `ambient` returns `nil` so it does.
    private var breath: Animation {
        JunoMotion.outSoft(Self.period / 2).repeatForever(autoreverses: true)
    }

    var body: some View {
        Circle()
            .fill(Color.junoSuccess)
            .frame(width: diameter, height: diameter)
            .opacity(dimmed ? 0.5 : 1)
            .animation(
                JunoMotion.reduced(breath, when: reduceMotion, tier: .ambient),
                value: dimmed
            )
            // Guarded rather than relying on the nil animation above: with motion
            // reduced there is no animation to carry the change, so setting it
            // would simply leave the dot permanently half-lit.
            .onAppear { if !reduceMotion { dimmed = true } }
            .accessibilityHidden(true)
    }
}
