import AppKit
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// Chat's account footer (§2.7 of the Liquid Glass redesign): who is signed in
/// and on what plan, the sync mark when there is something to say, and the
/// Settings gear — pinned under the source list in its `safeAreaBar`.
///
/// **Chat's, for now.** The spec names this file as the footer both products
/// share; Code keeps ``DesktopSidebarFooter`` (DesktopCodeAccountFooter.swift)
/// until its own rework adopts this one, so the two columns are not both
/// rewritten underneath a parallel change.
///
/// **A word, not a meter.** The plan is one word after the name — "Pro" — and
/// says nothing about usage below 80% of the week's budget. Above that it
/// becomes "n% left" in warning ink, and at 100% "Limit reached" in
/// destructive ink: the only moments the number is worth a glance. The meter
/// itself lives in the account popover, which is the one place the web draws
/// it. The word is read from the plan route rather than written as a literal:
/// a footer that said "Pro" to every account was a claim about money nobody
/// had made.
///
/// There is no Download button — this app is the download.
struct DesktopAccountFooter: View {
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession

    /// The account's plan meters, or nil until the first read lands. Nil draws
    /// no plan word at all rather than a guessed one.
    @State private var plan: DesktopUsagePlan?
    @State private var planReadAt: Date?
    @State private var isAccountOpen = false
    @State private var isHoveringAccount = false
    /// `@State` rather than a bare reference to the singleton, so the update
    /// row re-evaluates when the updater's phase changes.
    @State private var updater = DesktopUpdateModel.shared
    @Environment(\.openSettings) private var openSettings

    /// Re-reading the plan more often than this adds requests and no
    /// information: the budget moves when turns finish, not by the second.
    private static let planReadFloor: TimeInterval = 60

    private var name: String { session.profile.name ?? session.profile.email }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if case .ready(let version) = updater.phase {
                DesktopFooterUpdateRow(version: version) { updater.installAndRelaunch() }
            }

            HStack(spacing: 2) {
                accountButton
                Spacer(minLength: 0)
                DesktopFooterSyncMark(
                    syncPhase: configuration.syncModel?.phase,
                    connectivity: configuration.authModel.connectivity
                )
                settingsButton
            }
        }
        .padding(.horizontal, JunoSpace.close)
        .padding(.bottom, JunoSpace.snug)
        .task(id: session.profile.id) { await readPlan() }
        // The popover shows the meter, so a fresh read is worth its request
        // when the reader has asked to see it.
        .onChange(of: isAccountOpen) { _, isOpen in
            if isOpen { Task { await readPlan() } }
        }
        .accessibilityIdentifier("juno.desktop.account-footer")
    }

    // MARK: Account

    private var accountButton: some View {
        let word = plan.map(DesktopFooterPlanWord.init(plan:))
        return Button {
            isAccountOpen.toggle()
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoAvatar(
                    imageData: configuration.avatarModel?.imageData,
                    imageURL: session.profile.imageURL,
                    name: name,
                    size: 20
                )
                HStack(spacing: 0) {
                    Text(name)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .junoInk()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let word {
                        Text(" · \(word.text)")
                            .junoFont(size: 13, relativeTo: .callout)
                            .foregroundStyle(word.tone.color)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                JunoIconView(.chevronUp, size: 10)
                    .foregroundStyle(Color.junoTertiaryInk)
            }
            .padding(.horizontal, JunoSpace.tight)
            .frame(height: 36)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(accountFill)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHoveringAccount = $0 }
        .animation(JunoMotion.fast, value: isHoveringAccount)
        // Dismissed with its anchor: a popover whose anchor leaves the
        // hierarchy while presented has crashed this app before.
        .onDisappear { isAccountOpen = false }
        .popover(isPresented: $isAccountOpen, arrowEdge: .top) {
            DesktopAccountPopover(
                session: session,
                avatarData: configuration.avatarModel?.imageData,
                plan: plan,
                openSettings: { section in
                    isAccountOpen = false
                    DesktopSettingsRouter.open(section, using: openSettings)
                },
                signOut: {
                    isAccountOpen = false
                    Task { await configuration.authModel.signOut() }
                }
            )
        }
        .help("Account")
        .accessibilityLabel(DesktopFooterPlanWord.accessibilityLabel(name: name, plan: plan))
        // The launch UI suite finds the window by this control; the identifier
        // predates the footer rewrite and is kept so the suite needs no change.
        .accessibilityIdentifier("Account and settings")
    }

    /// Open wins over hover: while the popover is up the row wears the
    /// selected recipe, the same fill a selected sidebar row has.
    private var accountFill: Color {
        if isAccountOpen { return Color.junoSelectedFill }
        return isHoveringAccount ? Color.junoGlassHover : Color.clear
    }

    // MARK: Settings

    private var settingsButton: some View {
        Button {
            DesktopSettingsRouter.open(.general, using: openSettings)
        } label: {
            JunoIconView(.settings, size: 16)
                .foregroundStyle(Color.junoSidebarInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help("Settings  ⌘,")
        .accessibilityLabel("Settings")
        .accessibilityIdentifier("juno.desktop.footer.settings")
    }

    // MARK: Plan

    private func readPlan() async {
        guard let sender = configuration.requestSender else { return }
        if plan != nil, let planReadAt,
            Date().timeIntervalSince(planReadAt) < Self.planReadFloor
        {
            return
        }
        guard let loaded = await NativeUsageClient(sender: sender)
            .loadPlan(for: session.profile.id)
        else { return }
        planReadAt = Date()
        plan = loaded
    }
}

// MARK: - Plan word

/// The footer's plan segment, as a pure rule over the plan — the web's
/// `planSegment` (`app-sidebar.tsx`), on the native plan route's spend windows.
///
/// The web counts messages; the native route reports the fraction of the
/// week's budget spent, which is also what the budget gate enforces, so the
/// thresholds are read against that: under 80% the plan's name, from 80% the
/// share that is left, at 100% "Limit reached".
struct DesktopFooterPlanWord: Equatable {
    enum Tone: Equatable {
        case quiet
        case warning
        case destructive

        var color: Color {
            switch self {
            case .quiet: Color.junoSecondaryInk
            case .warning: Color.junoWarningInk
            case .destructive: Color.junoDestructiveInk
            }
        }
    }

    let text: String
    let tone: Tone

    init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    init(plan: DesktopUsagePlan) {
        self.init(
            planName: plan.planName,
            weeklyFraction: plan.weekly.fraction,
            isUnlimited: plan.isUnlimited,
            isBrowseOnly: plan.isBrowseOnly
        )
    }

    /// The rule itself, over the four facts it reads — so it can be checked
    /// without a plan decoded from the wire.
    init(planName: String, weeklyFraction: Double, isUnlimited: Bool, isBrowseOnly: Bool) {
        // An unlimited plan cannot run out, and a browse-only one has nothing
        // to run out of; both are simply their name.
        guard !isUnlimited, !isBrowseOnly else {
            self.init(text: planName, tone: .quiet)
            return
        }
        let percent = Self.percentUsed(fraction: weeklyFraction)
        if percent >= 100 {
            self.init(text: "Limit reached", tone: .destructive)
        } else if percent >= 80 {
            self.init(text: "\(100 - percent)% left", tone: .warning)
        } else {
            self.init(text: planName, tone: .quiet)
        }
    }

    static func percentUsed(_ plan: DesktopUsagePlan) -> Int {
        percentUsed(fraction: plan.weekly.fraction)
    }

    static func percentUsed(fraction: Double) -> Int {
        let clamped = fraction.isFinite ? min(1, max(0, fraction)) : 0
        return Int((clamped * 100).rounded())
    }

    /// The whole truth rides the accessible name, so nothing a sighted reader
    /// can see is lost to the truncation on that one line.
    static func accessibilityLabel(name: String, plan: DesktopUsagePlan?) -> String {
        guard let plan else { return name }
        if plan.isUnlimited { return "\(name), \(plan.planName) plan, no usage cap" }
        return "\(name), \(plan.planName) plan, \(percentUsed(plan))% of this week's budget used"
    }
}

// MARK: - Sync mark

/// Whether this Mac's work has reached the account — drawn **only** when it
/// has not.
///
/// A mark that shows while syncing is a light that is always on; the orange
/// dot it replaces was exactly that. Offline (the network, or a restored
/// session the server has not confirmed yet) is a cloud with a slash; a sync
/// the server refused is a warning in warning ink.
struct DesktopFooterSyncMark: View {
    let syncPhase: NativeSyncModel<SQLiteAccountRepository>.Phase?
    let connectivity: NativeAuthModel.Connectivity

    var body: some View {
        if let state {
            JunoIconView(state.icon, size: 12)
                .foregroundStyle(state.ink)
                .frame(width: 20, height: 28)
                .help(state.reason)
                .accessibilityLabel(state.reason)
                .accessibilityIdentifier("juno.desktop.footer.sync")
        }
    }

    private var state: (icon: JunoIcon, ink: Color, reason: String)? {
        if case .unreachable = connectivity {
            return (.cloudOff, Color.junoSecondaryInk, "Juno is unreachable — showing your local copy")
        }
        switch syncPhase {
        case .offline:
            return (.cloudOff, Color.junoSecondaryInk, "Offline — messages send when you're back")
        case .failed:
            return (.error, Color.junoWarningInk, "Sync failed — open Settings › Data & privacy for details")
        case .idle, .synchronizing, .live, .none:
            return nil
        }
    }
}

// MARK: - Update row

/// One quiet row above the account, present only while a downloaded update is
/// waiting: what it is, and the one action that installs it.
private struct DesktopFooterUpdateRow: View {
    let version: String
    let restart: () -> Void

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.download, size: 13)
                .junoSecondaryInk()
            Text("Update ready")
                .junoFont(size: 12, relativeTo: .footnote)
                .junoSecondaryInk()
            Spacer(minLength: 0)
            // Link-style accent text, stated here rather than left to the
            // borderless style: the sidebar sits outside the detail's accent
            // tint, so a borderless title would take the *system* accent —
            // blue on most Macs (§0.4).
            Button(action: restart) {
                Text("Restart")
                    .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
                    .foregroundStyle(Color.junoAccentInk)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Juno \(version) is downloaded and verified. This quits Juno and opens it again on the new version.")
            .accessibilityLabel("Restart to update Juno to \(version)")
            .accessibilityIdentifier("juno.desktop.update-ready")
        }
        .padding(.horizontal, JunoSpace.tight)
        .frame(height: 28)
    }
}

// MARK: - Account popover

/// Who, how much, and where to go (§2.7): the web's `UserMenu`, on the
/// system's popover glass with no background of Juno's own.
///
/// **An explicit frame** (crash rule 2): a popover that negotiates its own size
/// against the window underneath it has put this shell in a constraint loop
/// before. Owners get the extra Admin Panel row and 32 more points.
private struct DesktopAccountPopover: View {
    let session: NativeAuthenticatedSession
    let avatarData: Data?
    let plan: DesktopUsagePlan?
    let openSettings: (DesktopSettingsSection) -> Void
    let signOut: () -> Void

    @Environment(\.openURL) private var openURL

    /// The plan route names the owner's plan; the profile carries no role.
    private var isOwner: Bool { plan?.planID.uppercased() == "OWNER" }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            header
            usage
            Divider()
            VStack(spacing: 0) {
                DesktopPopoverRow(title: "Profile…", icon: .user) { openSettings(.account) }
                DesktopPopoverRow(title: "Settings…", icon: .settings, shortcut: "⌘,") {
                    openSettings(.general)
                }
                if isOwner {
                    DesktopPopoverRow(title: "Admin Panel", icon: .permissions, trailing: .external) {
                        if let url = URL(string: "\(JunoBackend.productionURLString)/admin") {
                            openURL(url)
                        }
                    }
                }
            }
            Divider()
            DesktopPopoverRow(title: "Sign Out", icon: .logOut, ink: Color.junoDestructiveInk, action: signOut)
                .accessibilityIdentifier("juno.desktop.account-menu.sign-out")
        }
        .padding(12)
        .frame(width: 288, height: isOwner ? 316 : 284, alignment: .top)
        .accessibilityIdentifier("juno.desktop.account-menu")
    }

    private var header: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoAvatar(
                imageData: avatarData,
                imageURL: session.profile.imageURL,
                name: session.profile.name ?? session.profile.email,
                size: 32
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: JunoSpace.snug) {
                    Text(session.profile.name ?? session.profile.email)
                        .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                        .junoInk()
                        .lineLimit(1)
                    if let plan {
                        // Neutral, not the accent: a plan is a fact about the
                        // account, not an action.
                        Text(plan.planName)
                            .junoFont(size: 11, relativeTo: .caption2, weight: .medium, design: .monospaced)
                            .junoSecondaryInk()
                            .padding(.horizontal, JunoSpace.snug)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.junoGlassFill))
                            .fixedSize()
                    }
                }
                Text(session.profile.email)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .junoSecondaryInk()
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    /// The one place the quota is drawn: this week's share of the budget, as
    /// the web's 18-dot matrix, or "No cap".
    private var usage: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline) {
                Text("This week")
                Spacer(minLength: JunoSpace.snug)
                Text(readout)
                    .monospacedDigit()
                    .junoInk()
                    .contentTransition(.numericText())
            }
            .junoFont(size: 11, relativeTo: .caption2)
            .junoSecondaryInk()

            if let plan, !plan.isUnlimited, !plan.isBrowseOnly {
                DesktopSidebarDotFillBar(fraction: plan.weekly.fraction, tint: meterTint(plan))
            }
        }
        .padding(JunoSpace.close)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoGlassFill)
        )
        .accessibilityElement(children: .combine)
    }

    private var readout: String {
        guard let plan else { return "Unavailable" }
        if plan.isBrowseOnly { return "Browse only" }
        if plan.isUnlimited { return "No cap" }
        return "\(DesktopFooterPlanWord.percentUsed(plan))% used"
    }

    /// Progress is one of the accent's sanctioned uses; near the limit the
    /// matrix takes the same warning and destructive tones the footer word does.
    private func meterTint(_ plan: DesktopUsagePlan) -> Color {
        switch DesktopFooterPlanWord(plan: plan).tone {
        case .quiet: Color.junoAccent
        case .warning: Color.junoWarning
        case .destructive: Color.junoDestructive
        }
    }
}

/// A 28pt row inside a popover: glyph, title, an optional shortcut or trailing
/// mark, and the glass hover fill.
private struct DesktopPopoverRow: View {
    let title: String
    let icon: JunoIcon
    var shortcut: String? = nil
    var trailing: JunoIcon? = nil
    var ink: Color = Color.junoForeground
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 16)
                Text(title)
                    .junoFont(size: 13, relativeTo: .callout)
                Spacer(minLength: JunoSpace.snug)
                if let shortcut {
                    Text(shortcut)
                        .junoFont(size: 12, relativeTo: .footnote)
                        .junoSecondaryInk()
                }
                if let trailing {
                    JunoIconView(trailing, size: 12)
                        .junoSecondaryInk()
                }
            }
            .foregroundStyle(ink)
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous)
                    .fill(isHovering ? Color.junoGlassHover : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.md, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}
