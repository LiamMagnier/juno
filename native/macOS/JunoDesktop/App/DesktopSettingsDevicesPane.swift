import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// Settings › Devices (`sections/devices.tsx`): this Mac's own Work switch
/// first (moved from Settings › Code), then the web's "Your Macs" (P3-23).
///
/// Signature detail: the live dot, drawn only beside a Mac that is awake now,
/// so the one coloured mark on the pane means exactly that.
struct DesktopSettingsDevicesPane: View {
    let context: DesktopSettingsContext

    @State private var links = DesktopSettingsLinks.shared
    @State private var choosingPermissions = false

    var body: some View {
        DesktopSettingsForm {
            if let host = context.services.workHostModel {
                Section {
                    DesktopSettingToggleRow(
                        title: "Allow Juno Work on this Mac",
                        description: "Lets tasks you start from your phone, the web or this window run here. Off, this Mac runs nothing sent to it.",
                        status: context.saves.status("workHost"),
                        isOn: Binding(
                            get: { host.allowWorkOnThisMac },
                            set: {
                                host.allowWorkOnThisMac = $0
                                context.saves.mark("workHost", ok: true)
                            }
                        ),
                        identifier: "juno.desktop.settings.work-host-enabled"
                    )
                    DesktopSettingRow(
                        title: "What this Mac may do",
                        description: "Files, your browser, screen control, when Juno asks first, and the folders and apps a task may use."
                    ) {
                        DesktopOutlineButton(title: "Choose…") { choosingPermissions = true }
                            .accessibilityIdentifier("juno.desktop.settings.work-host-choose")
                    }
                } header: {
                    DesktopSettingsGroupHeader(title: "This Mac")
                }
            }

            Section {
                hostRows
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Your Macs",
                    note: "Where a task can reach a folder, an app or your signed-in browser. Open one to choose what it may do, or to revoke it."
                )
            } footer: {
                footnote
            }
        }
        .task { await context.loadHosts() }
        .sheet(isPresented: $choosingPermissions) {
            if let host = context.services.workHostModel {
                DesktopWorkHostSheet(host: host)
            }
        }
    }

    @ViewBuilder
    private var hostRows: some View {
        switch context.hosts {
        case .loading:
            DesktopSettingRowSkeleton()
            DesktopSettingRowSkeleton()
        case .failed(let message):
            DesktopSettingsNote(text: message, tone: .error)
            DesktopOutlineButton(title: "Try Again") {
                Task { await context.loadHosts() }
            }
        case .loaded(let hosts):
            if hosts.isEmpty {
                JunoEmptyState(
                    title: "No Macs yet",
                    message: "Turn on Juno Work for this Mac and it appears here on its own.",
                    icon: .device,
                    size: .panel
                )
            } else {
                if context.hostsAreStale {
                    DesktopSettingsNote(
                        text: "These are the last answers Juno got. The latest check failed, so a Mac may have woken or gone away since.",
                        tone: .warning
                    )
                }
                ForEach(Self.ordered(hosts)) { host in
                    DesktopSettingsHostRow(host: host, open: links.openHost.map { open in { open(host.hostID) } })
                }
            }
        }
    }

    private var footnote: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text("Some actions wait for you on every Mac, whatever it is allowed to do.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
            if let openPermissions = links.openPermissions {
                Button(action: openPermissions) {
                    Text("See what Juno always asks first")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoAccentInk)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, JunoSpace.snug)
    }

    /// Live Macs first, revoked ones last, each in the server's order.
    static func ordered(_ hosts: [WorkHostSummary]) -> [WorkHostSummary] {
        hosts.filter { $0.revokedAt == nil } + hosts.filter { $0.revokedAt != nil }
    }
}

/// One Mac in "Your Macs": its name, its state in words, the live dot only
/// while it is awake, and a chevron when it can be opened (seam 11 — Phase 4
/// C's `DesktopWorkHostRow` replaces this row at integration).
struct DesktopSettingsHostRow: View {
    let host: WorkHostSummary
    /// Opens the Mac's page. Nil until the page router is merged; the row is
    /// then plain text, with no chevron.
    var open: (() -> Void)?

    var body: some View {
        let content = HStack(spacing: JunoSpace.cozy) {
            JunoIconView(.device, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(host.displayName)
                    .junoType(JunoType.ui.weight(.medium))
                    .foregroundStyle(host.revokedAt == nil ? Color.junoForeground : Color.junoSecondaryInk)
                    .lineLimit(1)
                HStack(spacing: JunoSpace.tight) {
                    if Self.isAwake(host) {
                        Circle()
                            .fill(Color.junoAccent)
                            .frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                    }
                    Text(Self.stateSentence(host))
                        .junoType(JunoType.label.weight(.regular))
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if open != nil {
                JunoIconView(.chevronRight, size: 12)
                    .foregroundStyle(Color.junoTertiaryInk)
            }
        }
        .frame(minHeight: 36)
        .contentShape(.rect)

        if let open {
            Button(action: open) { content }
                .buttonStyle(.plain)
                .contentShape(.rect)
                .accessibilityLabel("\(host.displayName), \(Self.stateSentence(host))")
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }

    static func isAwake(_ host: WorkHostSummary) -> Bool {
        host.revokedAt == nil && host.state == "online"
    }

    /// The Mac's state in words.
    static func stateSentence(_ host: WorkHostSummary) -> String {
        if host.revokedAt != nil { return "Revoked" }
        if !host.enabled { return "Work is off on this Mac" }
        switch host.state {
        case "online":
            let running = host.activeRunCount
            return running == 0 ? "Awake" : "Awake, running \(running)"
        case "idle": return "Idle"
        case "stale": return "Not answering"
        default: return "Asleep or offline"
        }
    }
}

/// This Mac's full Juno Work card (the Code section's old tile), in a system
/// sheet with an explicit frame, reached from Devices › This Mac › Choose….
struct DesktopWorkHostSheet: View {
    let host: DesktopWorkHostModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                DesktopWorkHostTile(host: host)
                    .padding(JunoSpace.section)
            }
            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
            }
            .padding(JunoSpace.regular)
        }
        .frame(width: 600, height: 640)
        .presentationSizing(.form)
    }
}
