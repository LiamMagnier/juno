import AppKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// **One Mac** (`/permissions/{hostId}`, Phase 4 C2): what it may do, what it
/// has offered, what it can reach — and taking its access away.
///
/// A reading-measure page under the caption "Permissions". The sections
/// follow the web's `WorkHostSettings`, with their headings on the `heading`
/// rung rather than the web's mono labels (register #71). For this Mac only,
/// an "On this Mac" group comes first (register #68): the local switches, the
/// macOS permissions they need and the folder picker — the web's "a folder is
/// chosen in Juno on the Mac" is this group.
struct DesktopHostPage: View {
    let hostID: String
    let model: NativeWorkHostsModel
    let accountID: AccountID
    /// This Mac's host id, when it is paired.
    var thisMac: String?
    /// This Mac's own Work host, for the "On this Mac" group.
    var localHost: DesktopWorkHostModel?

    @Environment(\.junoToast) private var toast
    @State private var confirmation: JunoConfirmation?

    private var isThisMac: Bool { hostID == thisMac }
    private var busy: Bool { model.busyIDs.contains(hostID) }

    var body: some View {
        page
            .junoConfirmation($confirmation)
            .navigationTitle(model.host(id: hostID)?.displayName ?? "Mac")
            .task(id: hostID) {
                await model.start(for: accountID)
                await model.loadHost(id: hostID)
                while !Task.isCancelled {
                    try? await Task.sleep(for: NativeWorkHostsModel.pollInterval)
                    guard !Task.isCancelled else { return }
                    await model.loadHost(id: hostID)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                Task { await model.loadHost(id: hostID) }
            }
            .accessibilityIdentifier("juno.desktop.host")
    }

    @ViewBuilder
    private var page: some View {
        if model.missingIDs.contains(hostID) {
            frame("Mac not found") {
                DesktopWorkNote(.error, "This Mac is no longer registered with Alevr Work. Signing out of Alevr on a Mac, or removing the app, takes it off this list.")
            }
        } else if let detail = model.details[hostID] {
            loaded(detail)
        } else if model.failedDetailIDs.contains(hostID) {
            frame("Mac") {
                JunoEmptyState(
                    title: "Couldn’t load this Mac",
                    message: "Nothing has been changed by the attempt — it still has whatever permissions it had, and this page not loading has not taken any of them away.",
                    icon: .error,
                    actionLabel: "Try again",
                    action: { Task { await model.loadHost(id: hostID) } },
                    size: .panel,
                    tone: .error
                )
            }
        } else {
            frame(model.host(id: hostID)?.displayName ?? "Mac") {
                VStack(spacing: JunoSpace.cozy) {
                    ForEach(0..<4, id: \.self) { _ in
                        JunoSkeleton(height: 64, cornerRadius: JunoRadius.card)
                    }
                }
                .accessibilityLabel("Loading")
            }
        }
    }

    private func frame<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        JunoPage(measure: .reading) {
            JunoPageHeader(title, caption: "Permissions")
        } content: {
            content()
        }
    }

    // MARK: Loaded

    private func loaded(_ detail: NativeWorkHostDetail) -> some View {
        let host = detail.host
        return JunoPage(measure: .reading) {
            JunoPageHeader(host.displayName, caption: "Permissions", lede: meta(host)) {
                if host.revokedAt != nil {
                    Button {
                        Task { await apply(NativeWorkHostPatch(restore: true)) }
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            if busy {
                                ProgressView().controlSize(.small).frame(width: 14, height: 14)
                            } else {
                                JunoIconView(.restore, size: 14)
                            }
                            Text("Restore access")
                        }
                    }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .disabled(busy)
                } else {
                    Button(role: .destructive) {
                        confirmRevoke(detail)
                    } label: {
                        Label("Revoke", icon: .shieldOff)
                    }
                    .buttonStyle(.junoGlass)
                    .tint(Color.junoDestructive)
                    .disabled(busy)
                    .accessibilityIdentifier("juno.desktop.host.revoke")
                }
            }
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.region) {
                status(detail)
                if isThisMac, let localHost, host.revokedAt == nil {
                    onThisMac(localHost)
                }
                DesktopHostSettings(
                    detail: detail,
                    locked: busy || host.revokedAt != nil,
                    isThisMac: isThisMac && localHost != nil
                ) { patch in
                    Task { await apply(patch) }
                }
            }
        }
    }

    private func meta(_ host: WorkHostSummary) -> String {
        var parts = [DesktopHostCopy.platform(host.platform)]
        if !host.appVersion.isEmpty { parts.append("Alevr \(host.appVersion)") }
        parts.append("last seen \(NativeWorkScheduleCopy.timeAgo(host.lastSeenAt))")
        return parts.joined(separator: " · ")
    }

    /// The state in words, what it is doing, and the one note that explains
    /// why nothing will be sent here, when something explains it.
    private func status(_ detail: NativeWorkHostDetail) -> some View {
        let host = detail.host
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.close) {
                DesktopHostState(host: host)
                Text(
                    host.revokedAt.map { "Revoked \(NativeWorkScheduleCopy.timeAgo($0))." }
                        ?? NativeWorkPermissionsCopy.workloadSentence(host)
                        ?? "Nothing running on it right now."
                )
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                if host.revokedAt == nil, detail.pendingCommands > 0 {
                    Text(
                        detail.pendingCommands == 1
                            ? "1 instruction waiting to be picked up"
                            : "\(detail.pendingCommands) instructions waiting to be picked up"
                    )
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            if host.revokedAt != nil {
                DesktopWorkNote(.blocked, "Access to this Mac was revoked. It cannot claim any command, nothing already queued for it survived, and no task will be sent here while it stays this way. It keeps heartbeating and stays on this list so you can put it back — restoring access brings back the settings below exactly as they were, and does not re-queue anything that was cancelled.")
            } else if let reason = NativeWorkPermissionsCopy.unavailableReason(host) {
                DesktopWorkNote(.warning, "\(reason) Work will not be sent here until it checks in again. Nothing below has been lost — these settings are what this Mac comes back to.")
            }
            if model.failedDetailIDs.contains(hostID) {
                DesktopWorkNote(.warning, "This is what Alevr last knew about this Mac. The most recent check failed, so it may have woken, gone away or been changed from another device since.") {
                    Button {
                        Task { await model.loadHost(id: hostID) }
                    } label: {
                        Label("Retry", icon: .refresh)
                    }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .controlSize(.small)
                    .fixedSize()
                }
            }
        }
    }

    /// This Mac's own switches, permissions and folders: the Work host tile's
    /// local sections, drawn once, here and in Settings.
    private func onThisMac(_ localHost: DesktopWorkHostModel) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            DesktopWorkSectionHeading(
                "On this Mac",
                lede: "What this Mac offers, the macOS permissions those need, and the folders and apps it shares. These are set here, on this Mac. The switches below can be narrowed from any of your devices."
            )
            DesktopWorkHostTile(host: localHost, layout: .onThisMac)
                // The tile's plain buttons (Open Settings, Add) in the neutral
                // ink; its switches carry the accent themselves.
                .tint(nil)
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, alignment: .leading)
                .junoCard(cornerRadius: JunoRadius.card)
        }
    }

    // MARK: Changes

    private func apply(_ patch: NativeWorkHostPatch) async {
        switch await model.update(id: hostID, patch) {
        case .done, .missing:
            break
        case .refused(let toggles):
            toast(.error(NativeWorkPermissionsCopy.refusal(toggles)))
        case .declined(let sentence):
            toast(.error(sentence))
        case .failed:
            toast(.error("Couldn’t change that. This Mac is exactly as it was — nothing was half-applied."))
        }
    }

    private func confirmRevoke(_ detail: NativeWorkHostDetail) {
        let host = detail.host
        var message = "This Mac stops being able to claim any command, from the moment you confirm. Work already queued for it is cancelled rather than left waiting, and running work on it stops. Anything it has already changed on your disk stays changed — revoking cannot reach back into work that has finished."
        if let workload = NativeWorkPermissionsCopy.workloadSentence(host) {
            message += " Right now: \(workload.lowercased())."
        }
        if detail.pendingCommands > 0 {
            message += detail.pendingCommands == 1
                ? " 1 instruction is waiting to be picked up and will be cancelled."
                : " \(detail.pendingCommands) instructions are waiting to be picked up and will be cancelled."
        }
        message += " You can restore access from this page afterwards, and the Mac keeps its settings."
        confirmation = JunoConfirmation(
            title: "Revoke access for “\(host.displayName)”?",
            message: message,
            confirmTitle: "Revoke Access"
        ) {
            Task {
                let (outcome, cancelled) = await model.revoke(id: hostID)
                switch outcome {
                case .done:
                    toast(.success(
                        cancelled == 0
                            ? "Revoked. This Mac can no longer claim anything."
                            : cancelled == 1
                                ? "Revoked. One instruction that was on its way to this Mac has been cancelled."
                                : "Revoked. \(cancelled) instructions that were on their way to this Mac have been cancelled."
                    ))
                case .declined(let sentence):
                    toast(.error(sentence))
                case .missing:
                    break
                case .refused, .failed:
                    toast(.error("Couldn’t revoke this Mac. Its access is unchanged, so it is safe to try again."))
                }
            }
        }
    }
}

// MARK: - The server's switches

/// The sections of the web's `WorkHostSettings`: what this Mac may do, when
/// Juno stops to ask, what it has offered, the folders it can reach, and the
/// apps and sites it was given.
struct DesktopHostSettings: View {
    let detail: NativeWorkHostDetail
    let locked: Bool
    /// This Mac's own page, where the local offer is drawn above: an
    /// unoffered switch points there, not at "Juno on the Mac itself".
    var isThisMac = false
    let patch: (NativeWorkHostPatch) -> Void

    private var host: WorkHostSummary { detail.host }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.region) {
            mayDo
            asks
            offered
            folders
            appsAndSites
        }
    }

    // MARK: What this Mac may do

    private var mayDo: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            DesktopWorkSectionHeading("What this Mac may do")
            toggleRow(NativeWorkPermissionsCopy.master)
            if !host.enabled, host.revokedAt == nil {
                DesktopWorkNote(.info, "Work is switched off for this Mac, so nothing below is in force. The switches still record what it would be allowed to do when you switch it back on.")
            }
            ForEach(NativeWorkPermissionsCopy.capabilities) { spec in
                toggleRow(spec)
            }
        }
    }

    private func toggleRow(_ spec: NativeWorkPermissionsCopy.Toggle) -> some View {
        let checked = host.allows(spec.key)
        let advertised = host.advertisedToggles.contains(spec.key)
        let unofferedAndOff = !advertised && !checked
        let unofferedButOn = !advertised && checked
        let detail = advertised
            ? spec.detail
            : unofferedButOn
                ? "This Mac is no longer offering this, and it is still switched on. It will lapse on its own at the next check-in; you can switch it off here now."
                : isThisMac
                    // Mac-only copy (register #176): the reader is on the Mac.
                    ? "This Mac has not offered this. Switch it on under On this Mac, above."
                    : "This Mac has not offered this. Switch it on in Alevr on the Mac itself and it becomes available here."
        return Toggle(isOn: Binding(get: { checked }, set: { patch(.toggle(spec.key, $0)) })) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(spec.label)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                Text(detail)
                    .junoType(.caption)
                    .foregroundStyle(unofferedButOn ? Color.junoWarningInk : Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .tint(Color.junoAccent)
        .disabled(locked || unofferedAndOff)
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .opacity(unofferedAndOff ? 0.7 : 1)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(unofferedButOn ? Color.junoWarning.opacity(0.35) : Color.junoBorder.opacity(0.5), lineWidth: 1)
        )
        .accessibilityLabel(spec.label)
        .accessibilityHint(detail)
    }

    // MARK: When Juno stops to ask

    private var asks: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            DesktopWorkSectionHeading("When Juno stops to ask")
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                JunoSegmented(
                    options: JunoWorkPermissionPolicy.allCases.map { policy in
                        JunoSegmented<JunoWorkPermissionPolicy>.Option(
                            policy,
                            policy.approvalModeLabel,
                            isDisabled: locked || (host.advertisedPolicy.map { policy > $0 } ?? false)
                        )
                    },
                    selection: Binding(
                        get: { host.approvalPolicy },
                        set: { value in
                            guard value != host.approvalPolicy else { return }
                            patch(NativeWorkHostPatch(approvalPolicy: value))
                        }
                    ),
                    accessibilityLabel: "How often Alevr asks before acting on this Mac"
                )
                .fixedSize()
                Text(host.approvalPolicy.approvalModeSummary)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Anything Alevr cannot take back — a permanent delete, a message sent, a purchase, a change to a security setting — is asked about under every one of these. There is no setting that turns that off.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let advertised = host.advertisedPolicy, advertised < .permissive {
                    Text("This Mac asked for “\(advertised.approvalModeLabel)”, so that is as relaxed as it goes from here. Loosen it in Alevr on the Mac itself.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, JunoSpace.comfy)
            .padding(.vertical, JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.5), lineWidth: 1)
            )
        }
    }

    // MARK: What it has offered

    @ViewBuilder
    private var offered: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            DesktopWorkSectionHeading("What it has offered")
            if detail.routableCapabilities.isEmpty {
                JunoEmptyState(
                    title: "Nothing listed yet",
                    message: "This Mac has not listed anything it can do. That is what an older build of the app looks like from here — it will fill in on its next check-in after an update.",
                    icon: .device,
                    size: .panel
                )
            } else {
                let granted = NativeWorkPermissionsCopy.grantedCapabilities(host, offered: detail.routableCapabilities)
                DesktopHostChips(
                    items: detail.routableCapabilities.map { capability in
                        DesktopHostChip(
                            text: NativeWorkPermissionsCopy.describeCapability(capability),
                            available: granted.contains(capability)
                        )
                    }
                )
                Text("What this Mac told Alevr it can do. A struck-through one is offered by the Mac and switched off above. This list is the Mac’s to report and cannot be edited from a browser.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Folders it can reach

    @ViewBuilder
    private var folders: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            DesktopWorkSectionHeading("Folders it can reach")
            if let grants = detail.grants {
                if grants.isEmpty {
                    JunoEmptyState(
                        title: "No folders shared",
                        message: "Nothing has been shared with this Mac, so file work on it has nowhere to happen. A folder is chosen in Alevr on the Mac, where the file picker is.",
                        icon: .folderOpen,
                        size: .panel
                    )
                } else {
                    VStack(spacing: JunoSpace.tight) {
                        ForEach(grants) { grant in
                            grantRow(grant)
                        }
                    }
                    Text("Named, never located. Alevr does not send the path of a folder on your Mac to a browser — a path is a path in a screenshot, in a support ticket, and in the next thing that asks an agent to read what sits next to it.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                JunoEmptyState(
                    title: "Couldn’t read the folders",
                    message: "The folders shared with this Mac couldn’t be read just now, which says nothing about whether it has any.",
                    icon: .error,
                    size: .panel,
                    tone: .error
                )
            }
        }
    }

    private func grantRow(_ grant: NativeWorkHostGrant) -> some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(grant.kind.hasSuffix("file") ? .file : grant.kind == "connector_scope" ? .connections : .folderOpen, size: 16)
                .foregroundStyle(Color.junoMutedForeground)
                .accessibilityHidden(true)
            Text(grant.displayName)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(NativeWorkPermissionsCopy.accessLabel(grant.accessMode))
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize()
            Text(grant.lastUsedAt.map { "used \(NativeWorkScheduleCopy.timeAgo($0))" } ?? "never used")
                .junoType(.caption)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize()
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    // MARK: Apps and sites

    private var appsAndSites: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            DesktopWorkSectionHeading("Apps and sites")
            nameList(.connections, "Apps it may drive", host.allowedApps, empty: "No app is singled out, so screen control is bounded only by the switch above.")
            nameList(.circleSlash, "Apps it may never touch", host.blockedApps, empty: "Nothing is blocked by name.")
            nameList(.link, "Sites the browser may visit", host.allowedDomains, empty: "No site list, so the browser switch above is the whole answer.")
            Text("These three are set in Alevr on the Mac and are shown here as they stand. The browser cannot change them.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func nameList(_ icon: JunoIcon, _ title: String, _ names: [String], empty: String) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(icon, size: 16)
                    .foregroundStyle(Color.junoMutedForeground)
                    .accessibilityHidden(true)
                Text(title)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
            }
            if names.isEmpty {
                Text(empty)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                DesktopHostChips(items: names.map { DesktopHostChip(text: $0, available: true, isCode: true) })
            }
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.5), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Chips

struct DesktopHostChip: Identifiable, Hashable {
    let text: String
    let available: Bool
    /// A bundle identifier or a domain: set in mono, because it is an id.
    var isCode = false
    var id: String { text }
}

/// A wrapping row of quiet chips; one the Mac offers but is switched off is
/// struck through, in the warning ink.
struct DesktopHostChips: View {
    let items: [DesktopHostChip]

    var body: some View {
        DesktopHostFlow(spacing: JunoSpace.tight) {
            ForEach(items) { item in
                Text(item.text)
                    .junoType(item.isCode ? .micro : .label)
                    .strikethrough(!item.available, color: Color.junoWarningInk.opacity(0.6))
                    .foregroundStyle(item.available ? Color.junoSecondaryInk : Color.junoWarningInk)
                    .lineLimit(1)
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, 3)
                    .background(
                        Capsule().fill(item.available ? Color.junoSecondary : Color.junoWarning.opacity(0.1))
                    )
                    .overlay(
                        Capsule().strokeBorder(
                            item.available ? Color.junoBorder.opacity(0.7) : Color.junoWarning.opacity(0.35),
                            lineWidth: 1
                        )
                    )
                    .help(item.available ? "" : "\(item.text) is not available on this run.")
                    .accessibilityLabel(item.available ? item.text : "\(item.text), switched off")
            }
        }
    }
}

/// Children left to right, wrapping when the next one would not fit.
struct DesktopHostFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > limit {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            line = max(line, size.height)
        }
        return CGSize(width: min(widest, limit), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
