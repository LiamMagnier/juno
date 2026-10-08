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
                        title: "Allow Alevr Work on this Mac",
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
                        description: "Files, your browser, screen control, when Alevr asks first, and the folders and apps a task may use."
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
                // A plain row inside the Form's section, not a dashed tile in
                // a box (§10.2.8).
                DesktopSettingRow(
                    title: "No Macs yet",
                    description: "Turn on Alevr Work for this Mac and it appears here on its own."
                )
            } else {
                if context.hostsAreStale {
                    DesktopSettingsNote(
                        text: "These are the last answers Alevr got. The latest check failed, so a Mac may have woken or gone away since.",
                        tone: .warning
                    )
                }
                // Phase 4 C's row, the web's `WorkHostRow`, as the Permissions
                // page draws it (seam 11); it opens the Mac's page in the main
                // window.
                ForEach(Self.ordered(hosts)) { host in
                    DesktopWorkHostRow(
                        host: host,
                        isThisMac: host.hostID == context.services.workHostModel?.pairedHostID,
                        open: links.openHost.map { openHost in { openHost(host.hostID) } },
                        inForm: true
                    )
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
                    Text("See what Alevr always asks first")
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
