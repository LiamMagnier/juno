import AppKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// **Permissions** (`/permissions`, Phase 4 C2): what Juno may do on the
/// reader's behalf, what it always stops to ask about first, and which of
/// their Macs it can reach.
///
/// A wide page in the web's order: "Juno always asks first" as calm tiles,
/// "How much it asks otherwise" as the three modes, then "Your Macs", this
/// Mac first. A Mac's row opens its page (``DesktopHostPage``).
///
/// Not in More: it is reached through ``DesktopPageRouter`` (⌘K and Settings ›
/// Devices, Track A) — the web moved it out of the sidebar too.
struct DesktopPermissionsScreen: View {
    let model: NativeWorkHostsModel
    let accountID: AccountID
    /// This Mac's host id, when it is paired: its row comes first.
    var thisMac: String?

    @Environment(\.desktopPush) private var push
    @State private var refreshing = false

    var body: some View {
        JunoPage(measure: .wide) {
            JunoPageHeader(
                "Permissions",
                lede: "What Juno may do on your behalf, what it always stops to ask about first, and which of your Macs it can reach."
            )
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.region) {
                DesktopPermissionsAlwaysAsks()
                DesktopPermissionsModes()
                yourMacs
            }
        }
        .task {
            await model.start(for: accountID)
            // The web's `WORK_POLL_MS`, only while the page is up: the task
            // ends with the page.
            while !Task.isCancelled {
                try? await Task.sleep(for: NativeWorkHostsModel.pollInterval)
                guard !Task.isCancelled else { return }
                await model.refresh()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.refresh() }
        }
        .accessibilityIdentifier("juno.desktop.permissions")
    }

    // MARK: Your Macs

    private var yourMacs: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .bottom, spacing: JunoSpace.cozy) {
                DesktopWorkSectionHeading(
                    "Your Macs",
                    lede: "Anything a task needs a real machine for — a folder on disk, an app, your signed-in browser — happens on one of these. Open one to say what it may do, or to take its access away."
                )
                if model.phase == .ready {
                    Button {
                        Task {
                            refreshing = true
                            await model.refresh()
                            refreshing = false
                        }
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            if refreshing {
                                ProgressView()
                                    .controlSize(.mini)
                                    .frame(width: 12, height: 12)
                            } else {
                                JunoIconView(.refresh, size: 12)
                            }
                            Text("Refresh")
                        }
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(height: 28)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .fixedSize()
                    .help("Check your Macs again")
                    .accessibilityLabel("Refresh your Macs")
                }
            }
            macs
        }
    }

    @ViewBuilder
    private var macs: some View {
        switch model.phase {
        case .idle, .loading:
            DesktopWorkSkeletonRows(count: 2)
        case .failed:
            JunoEmptyState(
                title: "Couldn’t load your Macs",
                message: "This section is empty because the request failed, not because you have none — anything already signed in is still reachable by Juno, with whatever permissions it had.",
                icon: .error,
                actionLabel: "Try again",
                action: { Task { await model.refresh() } },
                size: .panel,
                tone: .error
            )
        case .ready:
            if model.hosts.isEmpty {
                JunoEmptyState(
                    title: "No Macs yet",
                    message: "A Mac appears here on its own once you install Juno on it, sign in and switch Work on from the app. Until one does, every task runs in the cloud — which means a task that needs a folder on your disk, an app or your signed-in browser cannot run at all.",
                    icon: .device,
                    size: .panel
                )
            } else {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    if model.lastRefreshFailed {
                        DesktopWorkNote(
                            .warning,
                            "These are the last answers Juno got. The most recent check failed, so a Mac may have woken or gone away since."
                        )
                    }
                    DesktopWorkRowList(items: model.ordered(thisMac: thisMac)) { host, _ in
                        DesktopWorkHostRow(
                            host: host,
                            isThisMac: host.hostID == thisMac,
                            open: { push(.host(host.hostID)) }
                        )
                    }
                }
            }
        }
    }
}

// MARK: - A Mac

/// One Mac (`WorkHostRow`): its name and state in words — an awake Mac with
/// the live dot beside the word — what it is doing, and a meta line. It opens
/// the Mac's page.
///
/// Exposed for Track A's Settings › Devices, which lists the same rows.
struct DesktopWorkHostRow: View {
    let host: WorkHostSummary
    var isThisMac = false
    /// Opens the Mac's page. Nil draws the row as static content, with no
    /// chevron and no hover: a row that looks like a door must open one.
    let open: (() -> Void)?
    /// Inside a grouped Form (Settings › Devices) the Form supplies the
    /// insets and the row's rungs are the form's: title, then the 13pt
    /// description every other Settings row uses. On the Permissions page the
    /// row pads itself and hovers.
    var inForm = false

    @State private var isHovering = false

    private var revoked: Bool { host.revokedAt != nil }

    private var sentence: String {
        if let revokedAt = host.revokedAt {
            return "Revoked \(NativeWorkScheduleCopy.timeAgo(revokedAt)). It cannot claim anything."
        }
        return NativeWorkPermissionsCopy.workloadSentence(host) ?? "Nothing running on it right now."
    }

    private var meta: String {
        var parts = [DesktopHostCopy.platform(host.platform)]
        if !host.appVersion.isEmpty { parts.append("Juno \(host.appVersion)") }
        parts.append("last seen \(NativeWorkScheduleCopy.timeAgo(host.lastSeenAt))")
        return parts.joined(separator: " · ")
    }

    var body: some View {
        if let open {
            Button(action: open) { content(chevron: true) }
                .buttonStyle(.plain)
                .contentShape(.rect)
                .modifier(DesktopWorkRowSurface(isHovering: isHovering && !inForm))
                .onHover { isHovering = $0 }
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens what this Mac may do")
                .accessibilityIdentifier("juno.desktop.permissions.host.\(host.hostID)")
        } else {
            content(chevron: false)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("juno.desktop.permissions.host.\(host.hostID)")
        }
    }

    private func content(chevron: Bool) -> some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.snug) {
                    Text(host.displayName)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    DesktopHostState(host: host)
                    if isThisMac {
                        DesktopWorkTag("This Mac")
                    }
                    if !revoked, !host.enabled {
                        DesktopWorkTag("Work off")
                    }
                }
                Text(sentence)
                    .junoType(inForm ? JunoType.label.weight(.regular) : .ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                Text(meta)
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .padding(.top, JunoSpace.micro)
            }
            .opacity(revoked || !host.enabled ? 0.75 : 1)
            Spacer(minLength: JunoSpace.snug)
            if chevron {
                JunoIconView(.chevronRight, size: 14)
                    .foregroundStyle(Color.junoMutedForeground)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, inForm ? 0 : JunoSpace.comfy)
        .padding(.vertical, inForm ? 0 : JunoSpace.cozy)
        .contentShape(.rect)
    }
}

/// A Mac's state as a word. Only an awake Mac — working or ready — carries
/// the dot, because only that is live; revoked is a word in the destructive
/// ink, and nothing is colour alone.
struct DesktopHostState: View {
    let host: WorkHostSummary

    private var isAwake: Bool {
        host.revokedAt == nil && host.enabled && (host.state == "online" || host.state == "idle")
    }

    private var ink: Color {
        if host.revokedAt != nil { return Color.junoDestructiveInk }
        if host.state == "stale" { return Color.junoWarningInk }
        return Color.junoSecondaryInk
    }

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if isAwake {
                Circle()
                    .fill(Color.junoAccent)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
            Text(NativeWorkPermissionsCopy.stateLabel(host))
                .junoType(JunoType.label)
                .foregroundStyle(ink)
        }
        .fixedSize()
        .help(NativeWorkPermissionsCopy.unavailableReason(host) ?? "This Mac is checking in and will take work.")
    }
}

/// The Mac-only words the host pages add.
enum DesktopHostCopy {
    /// The platform as a person says it; the wire says `macos`.
    static func platform(_ raw: String) -> String {
        raw == "macos" ? "macOS" : raw
    }
}

// MARK: - The floor and the modes

/// "Juno always asks first": the actions no setting turns off, as calm opaque
/// tiles, each with the shield in the warning ink — the page's signature.
struct DesktopPermissionsAlwaysAsks: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopWorkSectionHeading(
                "Juno always asks first",
                lede: "These stop and wait for you every time, under every setting on this page and every setting on a task. There is nothing anywhere that turns them off."
            )
            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: JunoSpace.snug, alignment: .leading),
                    GridItem(.flexible(), spacing: JunoSpace.snug, alignment: .leading),
                ],
                alignment: .leading,
                spacing: JunoSpace.snug
            ) {
                ForEach(NativeWorkPermissionsCopy.alwaysAsks) { floor in
                    HStack(spacing: JunoSpace.snug) {
                        JunoIconView(.shieldCheck, size: 16)
                            .foregroundStyle(Color.junoWarningInk)
                            .accessibilityHidden(true)
                        Text(floor.verb)
                            .junoType(JunoType.ui.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                            .fixedSize()
                        Text(floor.object)
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, JunoSpace.comfy)
                    .padding(.vertical, JunoSpace.close)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .junoCard(cornerRadius: JunoRadius.card)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// "How much it asks otherwise": the three modes, the default marked.
struct DesktopPermissionsModes: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopWorkSectionHeading(
                "How much it asks otherwise",
                lede: "Below that floor, how often Juno stops is set per task — on the composer before you start it, and from the task itself while it runs. A Mac can also hold a stricter ceiling than a task asks for, and the stricter of the two always wins."
            )
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                ForEach(JunoWorkPermissionPolicy.allCases, id: \.self) { policy in
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        HStack(spacing: JunoSpace.snug) {
                            Text(policy.approvalModeLabel)
                                .junoType(JunoType.ui.weight(.medium))
                                .foregroundStyle(Color.junoForeground)
                            if policy == JunoWorkPermissionPolicy.defaultPolicy {
                                DesktopWorkTag("Default")
                            }
                        }
                        Text(policy.approvalModeSummary)
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(JunoSpace.regular)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .junoCard(cornerRadius: JunoRadius.card)
                    .accessibilityElement(children: .combine)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            // "Needs you" is plain text until Phase 5's fold can be linked.
            Text("When you answer an approval with “and stop asking”, that covers that one action for the rest of that task only, and lapses when the task ends. Nothing you allow on one task carries over to another. Anything waiting for a decision right now is in the Needs you fold at the top of the sidebar — it is there on every page in the product as soon as a run stops for you — and a task’s own decisions are listed in its conversation under Progress.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
