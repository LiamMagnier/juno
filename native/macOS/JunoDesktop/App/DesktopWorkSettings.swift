import AppKit
import JunoCore
import JunoDesignSystem
import JunoWorkAutomation
import JunoWorkCore
import JunoWorkKit
import SwiftUI

/// **Juno Work on this Mac** — the settings tile that owns the whole consent.
///
/// Settings is one flat page of ``JunoSettingsTile`` cards with no
/// sub-navigation, so this is a card and not a pane. It is the largest card on
/// the page, and deliberately so: everything that decides what a remote
/// instruction may do to this machine is here, in one place, in the order
/// somebody reasoning about the risk would ask about it — may Juno Work run
/// here at all, what may it touch, when must it ask, what has it been given,
/// what is it doing right now, and how do I stop it.
///
/// Two rules shape the whole card:
///
/// * **Nothing reads as available when it is not.** Every capability row is
///   disabled while the master switch is off, and the reason a task would be
///   refused is printed as ``DesktopWorkHostModel/unavailabilityReason``'s own
///   sentence rather than implied by a dimmed control. A grey switch with no
///   sentence beside it sends the reader to look for the fix in the wrong place
///   — usually at the phone that dispatched the task.
/// * **Nothing here shows a filesystem path.** ``WorkGrantSummary`` carries a
///   display name and an access mode and no path, by construction, and this card
///   must not become the surface that reintroduces one: a path on a settings
///   screen is a path in a screenshot, and a screenshot is where the account
///   name and the directory layout leak.
struct DesktopWorkHostTile: View {
    let host: DesktopWorkHostModel

    /// Bumped after every write to one of the model's switches, and read at the
    /// top of `body`.
    ///
    /// This is not defensive bookkeeping; without it the card does not work.
    /// ``DesktopWorkHostModel``'s switches are hand-written computed properties
    /// over `UserDefaults`, so `@Observable` has no stored property to
    /// instrument and setting one notifies SwiftUI of nothing. The model's own
    /// `onPolicyChanged` happens to touch observed state *when a relay is
    /// attached* — which is exactly the case that does not apply to a Mac that
    /// has never been paired, i.e. every Mac the first time somebody opens this
    /// card. Measured symptom: the "Allow Juno Work on this Mac" switch travels
    /// under the pointer, the preference is written, and the switch snaps back
    /// to off on the next frame because nothing re-read it.
    @State private var switchGeneration = 0

    /// The bundle identifier being typed into the allow or block field.
    @State private var appToAllow = ""
    @State private var appToBlock = ""
    /// Confirmation for the one control here that cannot be undone from this
    /// Mac. Revoking is immediate and does not come back until the next sign-in,
    /// so it asks first — the same treatment the account's destructive actions
    /// get one tile below.
    @State private var isConfirmingRevocation = false

    /// The macOS permissions as they were when this card was last drawn.
    ///
    /// Re-read on appear and whenever the window comes back to the front, because
    /// granting Accessibility happens in *System Settings* — the reader leaves,
    /// grants it, and returns. A card that only sampled TCC once would still be
    /// telling them the permission is missing after they granted it, which is
    /// exactly the moment they conclude the feature is broken.
    @State private var permissions = DesktopWorkSystemPermissions.none

    var body: some View {
        // Establishes the dependency described on `switchGeneration`. A bump
        // with no read in *this* body re-renders nothing at all.
        _ = switchGeneration

        return JunoSettingsTile("Juno Work") {
            masterSwitch
            reasonRow
            Divider()
            capabilities
            Divider()
            approvals
            Divider()
            grantedFolders
            Divider()
            applications
            Divider()
            activity
            Divider()
            pairing
        }
        .onAppear { refreshPermissions() }
        .onReceive(
            NotificationCenter.default.publisher(
                for: NSApplication.didBecomeActiveNotification
            )
        ) { _ in refreshPermissions() }
        .alert("Revoke this Mac?", isPresented: $isConfirmingRevocation) {
            Button("Revoke", role: .destructive) {
                host.detach(reason: "Revoked on this Mac.")
                switchGeneration &+= 1
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Juno Work stops here immediately and this Mac disappears from the list of "
                    + "places a task can run. It comes back the next time you sign in on this Mac."
            )
        }
    }

    // MARK: - The master switch

    /// The switch the whole feature hangs from.
    ///
    /// Off by default, and only ever changed at the machine that would be doing
    /// the work. Signing into Juno is not consent to hand a phone the
    /// filesystem, and a Mac that started accepting instructions from elsewhere
    /// the moment somebody signed in would be a default nobody would choose if
    /// they were asked.
    private var masterSwitch: some View {
        DesktopWorkSwitchRow(
            title: "Allow Juno Work on this Mac",
            detail: "Lets tasks you start from your phone, the web or this window run here, using only what you allow below. Off, this Mac runs nothing sent to it.",
            isOn: binding { host.allowWorkOnThisMac } set: { host.allowWorkOnThisMac = $0 }
        )
        .accessibilityIdentifier("juno.desktop.settings.work-host-enabled")
    }

    /// Why a task sent here would be refused, in the model's own words.
    ///
    /// Printed verbatim and selectable. The sentence distinguishes between
    /// problems with completely different fixes — "Juno Work is switched off",
    /// "this Mac has not finished pairing", "nothing has been allowed yet" — and
    /// collapsing them into a grey control is how somebody ends up checking
    /// their network while the answer was a switch on this card.
    @ViewBuilder
    private var reasonRow: some View {
        if let reason = host.unavailabilityReason {
            Label {
                Text(reason)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } icon: {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(Color.junoCaution)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("juno.desktop.settings.work-host-reason")
        } else {
            Label {
                Text("A task sent to this Mac now would run here.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(Color.junoSuccess)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("juno.desktop.settings.work-host-ready")
        }
    }

    // MARK: - Capabilities

    /// The four things Juno Work can be allowed to do here, each its own switch.
    ///
    /// Four switches rather than one "advanced" toggle because they are not
    /// degrees of the same permission. Reading a granted folder, driving a
    /// signed-in browser, clicking around the screen and running shell commands
    /// are different powers with different worst cases, and a single control
    /// covering all four would be a control nobody could grant honestly.
    private var capabilities: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("What Juno Work may use")
                .junoCaption()

            DesktopWorkSwitchRow(
                title: "Files in folders you grant",
                detail: "Read and change files, but only inside a folder you have handed over.",
                isOn: binding { host.allowsFileWork } set: { host.allowsFileWork = $0 }
            )
            .accessibilityIdentifier("juno.desktop.settings.work-host-files")

            DesktopWorkSwitchRow(
                title: "Your signed-in browser",
                detail: "Opens pages in a profile that is already signed in, so it acts as you.",
                isOn: binding { host.allowsBrowser } set: { host.allowsBrowser = $0 }
            )
            .disabled(!permissions.accessibility)
            .accessibilityIdentifier("juno.desktop.settings.work-host-browser")

            if !permissions.accessibility {
                permissionRow(
                    "Driving a browser needs macOS Accessibility permission, which Juno does not have.",
                    pane: Self.accessibilityPane,
                    identifier: "juno.desktop.settings.work-host-accessibility-permission"
                )
            }

            DesktopWorkSwitchRow(
                title: "Screen control",
                detail: "Screenshots, clicks and typing — it sees whatever is on screen, including windows the task has nothing to do with.",
                isOn: binding { host.allowsComputerUse } set: { host.allowsComputerUse = $0 }
            )
            // Both permissions, and switched off rather than merely unadvertised
            // when either is missing. A switch that moves under the pointer and
            // changes nothing is worse than one that will not move: the reader
            // believes they have granted screen control, and finds out they have
            // not when a task fails on its first click.
            .disabled(!permissions.accessibility || !permissions.screenRecording)
            .accessibilityIdentifier("juno.desktop.settings.work-host-computer-use")

            if !permissions.screenRecording {
                permissionRow(
                    "Screen control needs macOS Screen Recording permission, which Juno does not have.",
                    pane: Self.screenRecordingPane,
                    identifier: "juno.desktop.settings.work-host-screen-permission"
                )
            }

            // Off by default and last, with the plainest warning on the card.
            // A shell is not a larger version of clicking around an app; it is
            // the least constrained thing Juno can do on this machine, and only
            // a developer workflow has any use for it.
            DesktopWorkSwitchRow(
                title: "Shell commands",
                detail: "For developer work only. A shell can reach anything your account can, including files in folders you have not granted.",
                isOn: binding { host.allowsShell } set: { host.allowsShell = $0 }
            )
            .accessibilityIdentifier("juno.desktop.settings.work-host-shell")
        }
        .disabled(!host.allowWorkOnThisMac)
    }

    // MARK: - Approvals

    private var approvals: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("When Juno should ask first")
                .junoCaption()

            // Cards rather than a menu: three options that fit on screen at once
            // are three options the reader can compare, and this is the setting
            // where comparing them is the whole decision.
            ForEach(WorkHostPolicy.ApprovalPolicy.allCases, id: \.self) { policy in
                JunoChoiceCard(
                    title: LocalizedStringKey(Self.approvalTitle(policy)),
                    detail: LocalizedStringKey(Self.approvalDetail(policy)),
                    isSelected: host.approvalPolicy == policy,
                    isEnabled: host.allowWorkOnThisMac,
                    select: {
                        host.approvalPolicy = policy
                        switchGeneration &+= 1
                    }
                )
            }
            .accessibilityIdentifier("juno.desktop.settings.work-host-approval")

            // Said once, here, because it is the property that makes every other
            // switch on this card meaningful: nothing a task, a schedule or a
            // skill carries can loosen what is set here.
            Text(
                "A task, a schedule or a skill can ask for less than this. None of them can ask for more."
            )
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)

            DesktopWorkSwitchRow(
                title: "Run while you are away",
                detail: "Lets a task dispatched here keep going when nobody is at this Mac. Anything that needs your approval still waits for it.",
                isOn: binding { host.allowsBackground } set: { host.allowsBackground = $0 }
            )
            .disabled(!host.allowWorkOnThisMac)
            .accessibilityIdentifier("juno.desktop.settings.work-host-background")
        }
    }

    // MARK: - Grants

    /// The folders this Mac has handed over, by the name the user gave them.
    ///
    /// A grant is created by choosing a folder in a panel — an act of pointing at
    /// something — never by naming one. There is no text field here and there
    /// must not be: a list that could conjure a grant from a typed name is a list
    /// that could be talked into granting the wrong folder, which is precisely
    /// what routing this through `NSOpenPanel` prevents.
    ///
    /// The mode is offered at the moment of choosing, and again per row, because
    /// "Juno may read this" and "Juno may move things out of this" are different
    /// consents and a single Share button would have to assume one of them.
    private var grantedFolders: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Folders Juno Work may use")
                    .junoCaption()
                Spacer(minLength: JunoSpace.snug)
                if let actions = host.grantActions {
                    Menu("Add folder…") {
                        ForEach(Self.grantableModes, id: \.self) { mode in
                            Button(Self.accessLabel(mode.rawValue)) {
                                actions.addFolder(mode)
                                switchGeneration &+= 1
                            }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .disabled(!host.allowsFileWork)
                    .accessibilityIdentifier("juno.desktop.settings.work-host-grants-add")
                }
            }

            if host.grants.isEmpty {
                Text("No folders have been granted on this Mac.")
                    .junoRowLabel()
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(host.grants) { grant in
                    grantRow(grant)
                }
                .accessibilityIdentifier("juno.desktop.settings.work-host-grants")
            }
        }
    }

    @ViewBuilder
    private func grantRow(_ grant: WorkGrantSummary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: Self.grantSymbol(grant))
                .foregroundStyle(Color.junoMutedForeground)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(grant.displayName)
                    .junoRowLabel()
                    .lineLimit(1)
                Text(Self.accessLabel(grant.accessMode))
                    .junoCaption()
            }
            Spacer(minLength: JunoSpace.snug)
            if !grant.isActive {
                Text("Revoked")
                    .junoCodeSmall()
                    .foregroundStyle(Color.junoDanger)
            } else if let actions = host.grantActions {
                if let lastUsed = grant.lastUsedAt {
                    Text("used \(lastUsed.formatted(.relative(presentation: .named)))")
                        .junoCodeSmall()
                        .foregroundStyle(.secondary)
                }
                Menu("Change…") {
                    ForEach(Self.grantableModes, id: \.self) { mode in
                        Button(Self.accessLabel(mode.rawValue)) {
                            actions.setMode(mode, WorkGrantID(value: grant.grantID))
                            switchGeneration &+= 1
                        }
                        .disabled(grant.accessMode == mode.rawValue)
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityLabel("Change what Juno may do in \(grant.displayName)")

                // Immediate, and deliberately without a confirmation. Taking
                // access back is the safe direction — the folder can be shared
                // again in two clicks — and a sheet in front of it is a sheet
                // between somebody and the button they reached for because they
                // had changed their mind.
                Button {
                    actions.revoke(WorkGrantID(value: grant.grantID))
                    switchGeneration &+= 1
                } label: {
                    Image(systemName: "minus.circle")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Stop sharing \(grant.displayName) with Juno")
                .accessibilityLabel("Stop sharing \(grant.displayName)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The modes a person can choose from.
    ///
    /// Every case, in widening order, so the narrowest is the first thing the
    /// pointer lands on. There is no case that permits a permanent delete, and
    /// adding one would not be enough to enable it — see ``WorkAccessMode``.
    private static let grantableModes: [WorkAccessMode] = [
        .read, .readWriteNoDelete, .readWrite,
    ]

    /// One missing macOS permission, and the way to grant it.
    ///
    /// The button opens System Settings rather than prompting. A TCC prompt
    /// raised from a settings card appears behind whatever the reader was
    /// looking at and, once refused, never appears again — leaving a switch that
    /// cannot be turned on and no way at all to find out why.
    @ViewBuilder
    private func permissionRow(
        _ message: String, pane: String, identifier: String
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Label {
                Text(message)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "lock")
                    .foregroundStyle(Color.junoCaution)
            }
            Spacer(minLength: JunoSpace.snug)
            Button("Open Settings") {
                if let url = URL(string: pane) { NSWorkspace.shared.open(url) }
            }
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(identifier)
    }

    private func refreshPermissions() {
        let current = DesktopWorkSystemPermissions.current
        guard current != permissions else { return }
        permissions = current
        // The advertised manifest is derived from these, so the relay has to be
        // told: a permission granted while Juno is open makes this Mac routable
        // for work it was being passed over for.
        switchGeneration &+= 1
    }

    private static let accessibilityPane =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    private static let screenRecordingPane =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"

    // MARK: - Applications

    /// Which applications may be driven, and which may never be.
    ///
    /// Two lists rather than one with a mode, because they do not behave alike:
    /// a block beats an allow, so removing something from the blocked list has
    /// to be a deliberate act rather than a side effect of adding it to the
    /// allowed one. An empty allowed list means *none* — never "all" — which is
    /// what stops this feature shipping switched on for everybody who never
    /// opened this card.
    private var applications: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            DesktopWorkBundleList(
                title: "Apps Juno Work may drive",
                emptyMessage: "No apps allowed, so Juno Work cannot drive any of them — a browser included.",
                identifiers: host.allowedApps,
                draft: $appToAllow,
                addPrompt: "com.apple.Notes",
                accessibilityPrefix: "juno.desktop.settings.work-host-allowed-apps",
                add: { identifier in
                    host.allowedApps = Self.adding(identifier, to: host.allowedApps)
                    switchGeneration &+= 1
                },
                remove: { identifier in
                    host.allowedApps = host.allowedApps.filter { $0 != identifier }
                    switchGeneration &+= 1
                }
            )
            // Granting is meaningless with both switches off, and it is *not*
            // meaningless with only the browser one on. Driving Safari or Chrome
            // means sending Apple events to an application, so the browser's own
            // bundle identifier has to be on this list before anything happens —
            // and while this row followed screen control alone, somebody who had
            // turned on only the browser had no way to allow one, so browser
            // control drove nothing and said nothing about why.
            .disabled(!host.allowsComputerUse && !host.allowsBrowser)

            // Named only when it is the thing standing in the way: the browser
            // is switched on and nothing on the list is a browser Juno can
            // drive. A standing note about bundle identifiers on a card nobody
            // has turned browser control on for is a note they learn to skip.
            if host.allowsBrowser, !Self.listsADriveableBrowser(host.allowedApps) {
                Label(
                    "Driving a browser needs its own identifier here: "
                        + Self.driveableBrowserIdentifiers,
                    systemImage: "info.circle"
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("juno.desktop.settings.work-host-browser-identifier")
            }

            DesktopWorkBundleList(
                title: "Apps Juno Work may never drive",
                emptyMessage: "Nothing has been refused by name. Password managers, banking apps and system settings are refused regardless.",
                identifiers: host.blockedApps,
                draft: $appToBlock,
                addPrompt: "com.example.app",
                accessibilityPrefix: "juno.desktop.settings.work-host-blocked-apps",
                add: { identifier in
                    host.blockedApps = Self.adding(identifier, to: host.blockedApps)
                    switchGeneration &+= 1
                },
                remove: { identifier in
                    host.blockedApps = host.blockedApps.filter { $0 != identifier }
                    switchGeneration &+= 1
                }
            )
            // Refusing is not. Somebody who has not yet turned screen control on
            // may still want to say in advance what it must never touch, and a
            // block written before the capability exists is a block that is
            // already there when it does.

            // Named only when it applies to something the reader actually typed.
            // A standing warning about password managers on a card nobody has
            // added one to is a warning they learn to scroll past.
            if let refused = Self.permanentlyRefused(in: host.allowedApps) {
                Label(
                    "\(refused) is never driven automatically, whatever this list says.",
                    systemImage: "hand.raised"
                )
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .disabled(!host.allowWorkOnThisMac)
    }

    // MARK: - Activity

    /// What this Mac is doing for Juno Work right now.
    ///
    /// Counts rather than a list: the tasks themselves live in the Work product,
    /// and a second, thinner copy of that list here would be a second thing to
    /// keep in step with the relay. What settings owes the reader is the number
    /// that tells them whether the kill switch below has anything to stop.
    private var activity: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.regular) {
                DesktopWorkCount(label: "Running", value: host.activeRunCount)
                DesktopWorkCount(label: "Queued", value: host.queuedRunCount)
                Spacer(minLength: JunoSpace.snug)
            }

            if let lastActivity = host.lastActivityAt {
                Text("Last activity \(lastActivity.formatted(.relative(presentation: .named)))")
                    .junoCaption()
            } else {
                Text("Nothing has run here yet.")
                    .junoCaption()
            }

            if let error = host.lastError {
                // Verbatim and selectable. A host that cannot say why it stopped
                // serving is a host nobody can report.
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("juno.desktop.settings.work-host-error")
            }

            // The kill switch is present whenever the switch above is on, not
            // only while something is running: reaching for it is how somebody
            // says "stop, I have changed my mind", and a button that appears
            // only once a task exists is a button that is missing at the moment
            // it is wanted.
            if host.allowWorkOnThisMac {
                Button(role: .destructive) {
                    host.stopServingWork()
                    switchGeneration &+= 1
                } label: {
                    Text("Stop serving Juno Work now")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 1)
                }
                .accessibilityIdentifier("juno.desktop.settings.work-host-kill")
            }
        }
    }

    // MARK: - Pairing

    private var pairing: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text("Pairing")
                    .junoCaption()
                Spacer(minLength: JunoSpace.snug)
                Text(Self.phaseLabel(host.phase))
                    .junoCodeSmall()
                    .foregroundStyle(Self.phaseTint(host.phase))
                    .textSelection(.enabled)
            }

            if let advertised = host.lastAdvertisedAt {
                Text(
                    "Juno was last told what this Mac can do "
                        + advertised.formatted(.relative(presentation: .named))
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            }

            Button(role: .destructive) {
                isConfirmingRevocation = true
            } label: {
                Text("Revoke this Mac")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 1)
            }
            .accessibilityIdentifier("juno.desktop.settings.work-host-revoke")
        }
    }

    // MARK: - Plumbing

    /// A switch bound to one of the model's `UserDefaults`-backed properties.
    ///
    /// The bump in the setter is the point — see ``switchGeneration``. Written
    /// as one helper so no row can be added that writes the model and forgets to
    /// tell the view, which would leave exactly one switch on this card that
    /// does not move.
    /// `@MainActor` on both closures, not an incidental annotation.
    ///
    /// `Binding`'s accessors are `@Sendable` in the macOS 26 SDK. A plain
    /// `() -> Bool` parameter erases the isolation the closure literal has at
    /// the call site, and the compiler then reports passing a non-`Sendable`
    /// closure where a `@Sendable` one is wanted — a warning locally and a red
    /// build under `-warnings-as-errors`. Stating the isolation keeps the
    /// literal's own guarantee intact through the helper.
    @MainActor
    private func binding(
        _ get: @escaping @MainActor () -> Bool,
        set: @escaping @MainActor (Bool) -> Void
    ) -> Binding<Bool> {
        // Both accessors are closure LITERALS that call through, never the
        // isolated closures themselves. Passing `get` directly emits the
        // reabstraction thunk that the CI toolchain crashes on in IRGen — with
        // no diagnostic at all, just a failed compile command, which is how
        // this reached CI green locally and red there. JunoMobileTasksView
        // carries the same note beside the same construction.
        Binding(
            get: { get() },
            set: { value in
                set(value)
                switchGeneration &+= 1
            }
        )
    }

    /// Appends a trimmed identifier, refusing blanks and duplicates.
    ///
    /// A duplicate is not harmless here: the lists are rendered by identifier,
    /// so a second copy is a row whose Remove button appears to do nothing.
    private static func adding(_ identifier: String, to existing: [String]) -> [String] {
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !existing.contains(trimmed) else { return existing }
        return existing + [trimmed]
    }

    /// The first allowed identifier that ``WorkHostPolicy/restrictedCategories``
    /// refuses regardless, or nil.
    private static func permanentlyRefused(in allowed: [String]) -> String? {
        allowed.first { WorkHostPolicy.restrictedCategories.contains($0) }
    }

    /// Whether anything on the allowed list is a browser Juno has a driver for.
    ///
    /// Asked of ``AutomatableBrowser`` rather than by comparing strings here, so
    /// the card and the driver agree on both the list and the case it is
    /// compared in — the same case-folding `SystemBrowserDriver` uses, for the
    /// reason commit e0bb1e8 records.
    private static func listsADriveableBrowser(_ allowed: [String]) -> Bool {
        allowed.contains { AutomatableBrowser.named(bundleIdentifier: $0) != nil }
    }

    private static let driveableBrowserIdentifiers = AutomatableBrowser.allCases
        .map(\.bundleIdentifier)
        .joined(separator: " or ")

    private static func approvalTitle(_ policy: WorkHostPolicy.ApprovalPolicy) -> String {
        switch policy {
        case .conservative: "Ask before anything that changes"
        case .balanced: "Ask before anything sensitive"
        case .permissive: "Ask only when it must"
        }
    }

    private static func approvalDetail(_ policy: WorkHostPolicy.ApprovalPolicy) -> String {
        switch policy {
        case .conservative:
            "Anything that changes something outside the task's own scratch space waits for you."
        case .balanced:
            "Reversible changes happen. Sending, publishing, paying and deleting wait for you."
        case .permissive:
            "Most things happen without asking. What can never be undone still waits for you."
        }
    }

    private static func accessLabel(_ rawValue: String) -> String {
        switch JunoWorkAccessMode(rawValue: rawValue) {
        case .read: "Read only"
        case .readWriteNoDelete: "Read and change, never remove"
        case .readWrite: "Read, change, and move to the Trash"
        // A mode this build has not shipped. Named as the unreadable thing it
        // is rather than shown as the narrowest one, which would tell the reader
        // a grant is safer than it is.
        case .none: "Access mode \(rawValue), which this version cannot describe"
        }
    }

    private static func grantSymbol(_ grant: WorkGrantSummary) -> String {
        switch JunoWorkGrantKind(rawValue: grant.kind) {
        case .localFolder: "folder"
        case .localFile: "doc"
        case .cloudFolder: "folder.badge.gearshape"
        case .cloudFile: "doc.badge.gearshape"
        case .connectorScope: "app.connected.to.app.below.fill"
        case .none: "questionmark.folder"
        }
    }

    private static func phaseLabel(_ phase: DesktopWorkHostModel.Phase) -> String {
        switch phase {
        case .off: "Not serving"
        case .announcing: "Telling Juno what this Mac can do…"
        case .serving: "Serving"
        case .failed: "Last attempt failed"
        case .stopped(let reason): reason
        }
    }

    private static func phaseTint(_ phase: DesktopWorkHostModel.Phase) -> Color {
        switch phase {
        case .off, .announcing: .secondary
        case .serving: Color.junoSuccess
        case .failed: Color.junoDanger
        case .stopped: Color.junoCaution
        }
    }
}

// MARK: - Rows

/// A switch with exactly one line of explanation.
///
/// The same shape as the settings page's own switch row, which is `private` to
/// that file. Duplicated rather than made shared because the two will diverge:
/// this one carries longer, blunter copy — a sentence about what a shell can
/// reach is not the register "Email me at 80% of my budget" is written in.
private struct DesktopWorkSwitchRow: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(title)
                    .junoRowLabel()
                Text(detail)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The label claims the row so the switch sits on the trailing edge.
            // Without it a `Toggle` hugs its label and rows with different
            // sentence lengths put their switches at different x positions.
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .tint(Color.junoAccent)
        // The explanation is a hint, not part of the name: VoiceOver reads the
        // name on every focus and the hint only when the reader waits for it.
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }
}

/// One number this Mac is currently responsible for.
private struct DesktopWorkCount: View {
    let label: LocalizedStringKey
    let value: Int

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text("\(value)")
                .font(.system(.title3, design: .default, weight: .semibold))
                .monospacedDigit()
            Text(label)
                .junoCaption()
        }
        .accessibilityElement(children: .combine)
    }
}

/// An editable list of bundle identifiers.
///
/// A typed identifier rather than an app picker, and that is a deliberate floor
/// rather than a design: what the policy compares is a bundle identifier, so
/// that is what the card stores and shows. A picker that resolved a chosen
/// application to its identifier would be a better front end for the same list
/// and is the direction this grows.
private struct DesktopWorkBundleList: View {
    let title: LocalizedStringKey
    let emptyMessage: LocalizedStringKey
    let identifiers: [String]
    @Binding var draft: String
    let addPrompt: LocalizedStringKey
    let accessibilityPrefix: String
    let add: (String) -> Void
    let remove: (String) -> Void

    private var canAdd: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func commit() {
        guard canAdd else { return }
        add(draft)
        draft = ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(title)
                .junoCaption()

            if identifiers.isEmpty {
                Text(emptyMessage)
                    .junoRowLabel()
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(identifiers, id: \.self) { identifier in
                    HStack(spacing: JunoSpace.snug) {
                        Text(identifier)
                            .junoCode()
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        Spacer(minLength: JunoSpace.snug)
                        Button {
                            remove(identifier)
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .help("Remove \(identifier)")
                        .accessibilityLabel("Remove \(identifier)")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            HStack(spacing: JunoSpace.snug) {
                TextField(addPrompt, text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(commit)
                    .accessibilityIdentifier("\(accessibilityPrefix).field")
                Button("Add", action: commit)
                    .disabled(!canAdd)
                    .accessibilityIdentifier("\(accessibilityPrefix).add")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(accessibilityPrefix)
    }
}
