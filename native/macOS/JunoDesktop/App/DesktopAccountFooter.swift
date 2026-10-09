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
/// **Both products' footer** (premium pass, rule 1). Code pins this same view
/// under its column; the only thing it changes is what the gear opens — the
/// settings of the product on screen (``DesktopFooterSettingsAction``).
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
    /// What the gear opens, when it is not the app's Settings: Code points it
    /// at Code's settings window. Nil is Chat's gear.
    var settingsAction: DesktopFooterSettingsAction? = nil
    /// Archived Chats, from the account menu (the contract's archive). Nil
    /// leaves the item out.
    var openArchivedChats: (() -> Void)? = nil

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
    @Environment(\.openURL) private var openURL
    @Environment(\.openWindow) private var openWindow

    /// Re-reading the plan more often than this adds requests and no
    /// information: the budget moves when turns finish, not by the second.
    private static let planReadFloor: TimeInterval = 60

    private var name: String { session.profile.name ?? session.profile.email }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            if case .ready(let version) = updater.phase {
                DesktopFooterUpdateRow(
                    version: version,
                    restart: { updater.installAndRelaunch() },
                    details: { openWindow(id: JunoDesktopWindow.softwareUpdateID) }
                )
            }

            HStack(spacing: JunoSpace.micro) {
                accountButton
                Spacer(minLength: 0)
                DesktopFooterSyncMark(
                    syncPhase: configuration.syncModel?.phase,
                    connectivity: configuration.authModel.connectivity
                )
                settingsButton
            }
        }
        .padding(.horizontal, DesktopSidebarMetrics.fillInset)
        .padding(.bottom, DesktopSidebarMetrics.fillInset)
        .task(id: session.profile.id) { await readPlan() }
        // The popover shows the meter, so a fresh read is worth its request
        // when the reader has asked to see it.
        .onChange(of: isAccountOpen) { _, isOpen in
            if isOpen { Task { await readPlan() } }
        }
        .accessibilityIdentifier("juno.desktop.account-footer")
    }

    // MARK: Account

    /// The account as a native menu row (round 2): the avatar, the name over
    /// the plan in secondary ink, and the system's up-down chevron — the row
    /// Notes, Mail and ChatGPT for Mac end their sidebars on. Its menu is
    /// AppKit's own: the account's facts as a header, then Settings, the plan,
    /// the archive, shortcuts and Sign Out.
    private var accountButton: some View {
        let word = plan.map(DesktopFooterPlanWord.init(plan:))
        let usage = DesktopAccountUsage(plan: plan)
        return Menu {
            Section {
                Text(session.profile.email)
                if plan != nil {
                    Text("\(usage.caption) \(usage.readout)")
                }
            } header: {
                Text(name)
            }
            Section {
                Button("Profile") { DesktopPageRouter.shared.open(.profile) }
                Button("Settings…") { DesktopSettingsRouter.open(.general, using: openSettings) }
                    .keyboardShortcut(",", modifiers: .command)
                if DesktopAccountPopoverRows.canUpgrade(planID: plan?.planID) {
                    Button("Upgrade Plan…") { DesktopUpgradePresenter.shared.present(in: .chat) }
                }
                if let openArchivedChats {
                    Button(JunoShellChatSidebar.More.archivedTitle + "…", action: openArchivedChats)
                }
                if plan?.planID.uppercased() == "OWNER" {
                    Button("Admin Panel") {
                        if let url = URL(string: "\(JunoBackend.productionURLString)/admin") { openURL(url) }
                    }
                }
                Button("Keyboard Shortcuts") { openWindow(id: JunoDesktopWindow.shortcutsID) }
            }
            Section {
                Button("Sign Out", role: .destructive) {
                    Task { await configuration.authModel.signOut() }
                }
                .accessibilityIdentifier("juno.desktop.account-menu.sign-out")
            }
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoAvatar(
                    imageData: configuration.avatarModel?.imageData,
                    imageURL: session.profile.imageURL,
                    name: name,
                    size: 28
                )
                VStack(alignment: .leading, spacing: 0) {
                    Text(name)
                        .junoFont(size: 14, relativeTo: .body, weight: .medium)
                        .junoInk()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let word {
                        Text(word.text)
                            .junoFont(size: 11, relativeTo: .caption)
                            .foregroundStyle(word.tone.color)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                JunoIconView(.chevronsUpDown, size: 12)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            // The avatar on the 16pt glyph edge: 8 from the fill, which sits
            // 8 in from the panel.
            .padding(.horizontal, DesktopSidebarMetrics.fillInset)
            .frame(height: DesktopSidebarMetrics.accountHeight)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(isHoveringAccount ? Color.junoGlassHover : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .onHover { isHoveringAccount = $0 }
        .animation(JunoMotion.fast, value: isHoveringAccount)
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
            if let settingsAction {
                settingsAction.action()
            } else {
                DesktopSettingsRouter.open(.general, using: openSettings)
            }
        } label: {
            JunoIconView(.settings, size: 16)
                .foregroundStyle(Color.junoSidebarInk)
                .frame(width: 36, height: 36)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help(settingsAction?.help ?? JunoShortcutRegistry.help("Settings", .settings))
        .accessibilityLabel(settingsAction?.help ?? "Settings")
        .accessibilityIdentifier(settingsAction?.identifier ?? "juno.desktop.footer.settings")
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
        DesktopPlanGate.shared.update(planID: loaded.planID)
    }
}

/// The footer gear's target when it is not the app's Settings.
struct DesktopFooterSettingsAction {
    /// The tooltip, which is also the spoken name.
    let help: String
    let identifier: String
    let action: () -> Void
}

// MARK: - Plan word

/// The footer's plan segment, as a pure rule over the plan: the web's
/// `usageNote` (`app-sidebar.tsx`).
///
/// It reads the same number the account popover's usage block reads, the
/// month's messages against the plan's cap (`quota`, seam 9), so the two can
/// never disagree about one account: under 80% the plan's name, from 80%
/// "{remaining} left" in warning, at 100% "Limit reached". A server that
/// predates `quota.used` falls back to the week's share of the budget.
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
        if let used = plan.quota.used, let limit = plan.quota.limit, limit > 0 {
            self.init(planName: plan.planName, used: used, limit: limit)
        } else {
            self.init(
                planName: plan.planName,
                weeklyFraction: plan.weekly.fraction,
                isUnlimited: plan.isUnlimited,
                isBrowseOnly: plan.isBrowseOnly
            )
        }
    }

    /// The web's rule over the quota: `pct = min(100, round(used / limit ×
    /// 100))`, and what is left clamped at zero.
    init(planName: String, used: Int, limit: Int) {
        let percent = Self.percentUsed(used: used, limit: limit)
        if percent >= 100 {
            self.init(text: "Limit reached", tone: .destructive)
        } else if percent >= 80 {
            self.init(text: "\(max(0, limit - used)) left", tone: .warning)
        } else {
            self.init(text: planName, tone: .quiet)
        }
    }

    /// The fallback over the week's share, for a server without `quota.used`.
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

    static func percentUsed(used: Int, limit: Int) -> Int {
        guard limit > 0 else { return 0 }
        return min(100, Int((Double(used) / Double(limit) * 100).rounded()))
    }

    /// The whole truth rides the accessible name, so nothing a sighted reader
    /// can see is lost to the truncation on that one line. The web's words.
    static func accessibilityLabel(name: String, plan: DesktopUsagePlan?) -> String {
        guard let plan else { return name }
        if let used = plan.quota.used, let limit = plan.quota.limit, limit > 0 {
            return "\(name), \(plan.planName) plan, \(used) of \(limit) messages used"
        }
        if plan.isUnlimited || plan.quota.limit == nil && plan.quota.used != nil {
            return "\(name), \(plan.planName) plan, no message cap"
        }
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
            return (.cloudOff, Color.junoSecondaryInk, DesktopOfflineState.unreachableSentence)
        }
        switch syncPhase {
        case .offline:
            return (.cloudOff, Color.junoSecondaryInk, DesktopOfflineState.offlineSentence)
        case .failed:
            return (.error, Color.junoWarningInk, "Sync failed · open Settings › Data & privacy for details")
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
    /// Opens Software Update: the versions, and what is new.
    var details: () -> Void = {}

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Button(action: details) {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.download, size: 13)
                    Text("Update ready")
                        .junoFont(size: 12, relativeTo: .footnote)
                }
                .junoSecondaryInk()
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("See what's new in Alevr \(version)")
            .accessibilityIdentifier("juno.desktop.update-details")
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
            .help("Alevr \(version) is downloaded and verified. This quits Alevr and opens it again on the new version.")
            .accessibilityLabel("Restart to update Alevr to \(version)")
            .accessibilityIdentifier("juno.desktop.update-ready")
        }
        .padding(.horizontal, JunoSpace.tight)
        .frame(height: 28)
    }
}

// MARK: - Account popover

/// The usage block's words and meter, from the plan route (seam 9).
///
/// The web's block reads "Messages {used} / {limit}" from the account's
/// quota. The native plan route does not carry that count yet, so a plan with
/// a weekly budget says what it does today — this week's share, as a
/// percentage — until Stage C's `NativeUsagePlan.quota` lands and the
/// integration switches the block to the web's words. With no cap it is the
/// web's "No cap" and its sentence.
struct DesktopAccountUsage: Equatable {
    /// The block's left-hand word: "Messages", or "This week".
    let caption: String
    /// The right-hand figure, tabular.
    let readout: String
    /// How full the 18-dot bar is; nil draws no bar.
    let fraction: Double?
    /// The line under an uncapped plan's readout.
    let sentence: String?
    let tone: DesktopFooterPlanWord.Tone

    init(caption: String, readout: String, fraction: Double?, sentence: String?, tone: DesktopFooterPlanWord.Tone) {
        self.caption = caption
        self.readout = readout
        self.fraction = fraction
        self.sentence = sentence
        self.tone = tone
    }

    init(plan: DesktopUsagePlan?) {
        guard let plan else {
            self.init(caption: "This week", readout: "Unavailable", fraction: nil, sentence: nil, tone: .quiet)
            return
        }
        if plan.isUnlimited {
            self.init(
                caption: "Messages",
                readout: "No cap",
                fraction: nil,
                sentence: Self.uncappedSentence(isOwner: plan.planID.uppercased() == "OWNER"),
                tone: .quiet
            )
        } else if let used = plan.quota.used, let limit = plan.quota.limit, limit > 0 {
            // The web's block (`user-menu.tsx`): the month's messages against
            // the plan's cap, read from the usage route's `quota` (seam 9).
            let fraction = min(1, max(0, Double(used) / Double(limit)))
            self.init(
                caption: "Messages",
                readout: "\(used) / \(limit)",
                fraction: fraction,
                sentence: nil,
                tone: fraction >= 1 ? .destructive : fraction >= 0.8 ? .warning : .quiet
            )
        } else if plan.isBrowseOnly {
            self.init(caption: "This week", readout: "Browse only", fraction: nil, sentence: nil, tone: .quiet)
        } else {
            // A server that predates `quota.used`: the week's share, as before.
            self.init(
                caption: "This week",
                readout: "\(DesktopFooterPlanWord.percentUsed(plan))% used",
                fraction: plan.weekly.fraction,
                sentence: nil,
                tone: DesktopFooterPlanWord(plan: plan).tone
            )
        }
    }

    /// The web's two sentences for a plan with no cap (`user-menu.tsx`).
    static func uncappedSentence(isOwner: Bool) -> String {
        isOwner ? "Everything unlocked, with no usage cap." : "All models, with a monthly token limit."
    }

    /// Progress is one of the accent's sanctioned uses; near the limit the
    /// bar takes the footer word's warning and destructive tones.
    var meterTint: Color {
        switch tone {
        case .quiet: Color.junoAccent
        case .warning: Color.junoWarning
        case .destructive: Color.junoDestructive
        }
    }
}

/// Which rows the account popover draws, and so how tall it is.
struct DesktopAccountPopoverRows: Equatable {
    var showsUpgrade: Bool
    var showsAdmin: Bool
    var showsProfile = false
    /// An uncapped plan's sentence stands a little taller than the dots.
    var usageHasSentence = false

    /// Plans below the top one for sale (Ultra) may upgrade; Owner and a
    /// plan this build does not know may not. The row also needs the Upgrade
    /// presenter (seam 4).
    static func canUpgrade(planID: String?) -> Bool {
        guard let planID else { return false }
        return JunoAccountPlan(serverID: planID).canUpgrade
    }

    /// The popover's height: a constant per row set, never measured at run
    /// time (crash rule 2).
    var height: CGFloat {
        Self.baseHeight
            + (usageHasSentence ? Self.sentenceExtra : 0)
            + (showsUpgrade ? Self.rowHeight : 0)
            + (showsAdmin ? Self.rowHeight : 0)
            + (showsProfile ? Self.rowHeight : 0)
    }

    static let rowHeight: CGFloat = 28
    /// Padding, identity, usage block with its dots, three dividers,
    /// Settings, Keyboard Shortcuts and Sign Out.
    static let baseHeight: CGFloat = 246
    static let sentenceExtra: CGFloat = 10
}

/// Who, how much, and where to go (§0.5 of the Phase 3 brief): the web's
/// account menu, on the system's popover glass with no background of Juno's
/// own.
///
/// Settings…, Upgrade Plan (while a higher plan is for sale and the Upgrade
/// sheet is wired), Admin Panel for owners; Keyboard Shortcuts; Sign Out.
/// Profile opens the profile page (the web's user menu links `/profile`
/// again since the page shipped). No "Get the apps" (P3-15: this app is the
/// download).
///
/// **The signature detail** is the 18-dot bar — the web's own mark for how
/// much is left, drawn in the accent until the week runs short.
struct DesktopAccountPopover: View {
    let name: String
    let email: String
    let avatarData: Data?
    let imageURL: URL?
    let planName: String?
    let usage: DesktopAccountUsage
    let isOwner: Bool
    let openSettings: () -> Void
    /// The profile page (`/profile`); nil hides the row.
    var openProfile: (() -> Void)? = nil
    /// Seam 4: nil hides Upgrade Plan.
    let openUpgrade: (() -> Void)?
    let openAdmin: () -> Void
    let openShortcuts: () -> Void
    let signOut: () -> Void

    static let width: CGFloat = 288

    private var rows: DesktopAccountPopoverRows {
        DesktopAccountPopoverRows(
            showsUpgrade: openUpgrade != nil,
            showsAdmin: isOwner,
            showsProfile: openProfile != nil,
            usageHasSentence: usage.fraction == nil && usage.sentence != nil
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            usageBlock
                .padding(.top, JunoSpace.cozy)
            divider
            if let openProfile {
                DesktopPopoverRow(title: "Profile", icon: .user, action: openProfile)
                    .accessibilityIdentifier("juno.desktop.account-menu.profile")
            }
            DesktopPopoverRow(title: "Settings…", icon: .settings, shortcut: JunoShortcutRegistry.chord(.settings), action: openSettings)
            if let openUpgrade {
                DesktopPopoverRow(title: "Upgrade Plan", icon: .sparkles, action: openUpgrade)
            }
            if isOwner {
                DesktopPopoverRow(title: "Admin Panel", icon: .shieldCheck, trailing: .external, action: openAdmin)
            }
            divider
            DesktopPopoverRow(title: "Keyboard Shortcuts", icon: .keyboard, shortcut: JunoShortcutRegistry.chord(.keyboardShortcuts), action: openShortcuts)
            divider
            DesktopPopoverRow(title: "Sign Out", icon: .logOut, ink: Color.junoDestructiveInk, action: signOut)
                .accessibilityIdentifier("juno.desktop.account-menu.sign-out")
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.cozy)
        .frame(width: Self.width, height: rows.height, alignment: .top)
        .accessibilityIdentifier("juno.desktop.account-menu")
    }

    private var divider: some View {
        Divider()
            .padding(.vertical, JunoSpace.snug)
    }

    private var header: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoAvatar(imageData: avatarData, imageURL: imageURL, name: name, size: 32)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                HStack(spacing: JunoSpace.snug) {
                    Text(name)
                        .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let planName {
                        // Neutral, not the accent: a plan is a fact about the
                        // account. SF, like the rest of the menu's metadata.
                        Text(planName)
                            .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(.horizontal, JunoSpace.snug)
                            .padding(.vertical, JunoSpace.micro)
                            .background(Capsule().fill(Color.junoGlassFill))
                            .fixedSize()
                    }
                }
                Text(email)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    /// The one place the quota is drawn.
    private var usageBlock: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline) {
                Text(usage.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                Spacer(minLength: JunoSpace.snug)
                Text(usage.readout)
                    .fontWeight(.medium)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoForeground)
                    .contentTransition(.numericText())
                    .lineLimit(1)
            }
            .junoFont(size: 11, relativeTo: .caption2)

            if let fraction = usage.fraction {
                DesktopSidebarDotFillBar(fraction: fraction, tint: usage.meterTint)
            } else if let sentence = usage.sentence {
                Text(sentence)
                    .junoFont(size: 11, relativeTo: .caption2)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, JunoSpace.close)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoGlassFill)
        )
        .accessibilityElement(children: .combine)
    }
}

/// A 28pt row inside a popover: glyph, title, an optional shortcut or trailing
/// mark, and the glass hover fill at radius 8.
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
                    .foregroundStyle(ink == Color.junoForeground ? Color.junoSecondaryInk : ink)
                Text(title)
                    .junoFont(size: 13, relativeTo: .callout)
                Spacer(minLength: JunoSpace.snug)
                if let shortcut {
                    Text(shortcut)
                        .junoFont(size: 12, relativeTo: .footnote)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                if let trailing {
                    JunoIconView(trailing, size: 12)
                        .foregroundStyle(Color.junoSecondaryInk)
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
        .accessibilityLabel(title)
    }
}

// MARK: - Dot fill bar

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
