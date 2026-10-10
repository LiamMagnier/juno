import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Settings › Connectors (`sections/connectors.tsx`): one switch per connected
/// app — off blocks everything Juno would do in it — then the permission
/// policy and Lockdown. The embedded Connections page is gone; "Browse Apps"
/// leads to it once the page router is merged (seam 10).
struct DesktopSettingsConnectorsPane: View {
    let context: DesktopSettingsContext

    @State private var links = DesktopSettingsLinks.shared

    /// The web's `POLICY_COPY`, in `ACTION_PERMISSION_POLICIES` order.
    static let policies: [(id: String, label: String, description: String)] = [
        ("always_ask", "Ask every time", "Alevr asks before every action in a connected app, including ones that only read."),
        ("ask_for_any_change", "Ask before any change", "Reading runs on its own. Anything that writes, sends or deletes waits for you."),
        ("ask_for_important_actions", "Ask for important actions", "Reading and reversible changes (labels, archiving, renaming) run on their own. Anything that leaves your account, deletes, or can’t be classified waits for you."),
        ("allow_selected_low_risk", "Allow what I’ve approved", "Reading runs on its own, and so do the reversible actions you chose to always allow."),
        ("block", "Block everything", "Every action in a connected app is refused, and nothing can be approved."),
    ]

    var body: some View {
        DesktopSettingsRecordForm(context: context) { settings in
            // Its own group, first: the Codex-style "Control this Mac
            // remotely" (docs/code-v2/REMOTE-CONTROL.md §1).
            DesktopRemoteControlSection(host: context.services.codeHostModel)

            Section {
                appRows(settings)
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Connected apps",
                    note: "Turn one off to block everything Alevr would do in it, reading included."
                ) {
                    if let openConnections = links.openConnections {
                        DesktopOutlineButton(title: "Browse Apps", action: openConnections)
                    }
                }
            }

            Section {
                permissionRows(settings)
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Permissions",
                    note: "Alevr checks these before every action in a connected app, so a change applies to chats already open."
                )
            }
        }
        .task {
            if let model = context.services.connectorModel, model.phase == .idle {
                await model.start(for: context.accountID)
            }
        }
    }

    // MARK: Connected apps

    private struct AppRow: Identifiable {
        let id: String
        let label: String
        let account: String?
        let connected: Bool
    }

    private func rows(_ settings: NativeAccountSettings, linked: [NativeConnector]) -> [AppRow] {
        var list = linked.filter(\.connected).map {
            AppRow(id: $0.id, label: $0.label, account: $0.accountLabel, connected: true)
        }
        let listed = Set(list.map(\.id))
        for id in settings.blockedConnectors ?? [] where !listed.contains(id) {
            let known = linked.first { $0.id == id }
            list.append(AppRow(id: id, label: known?.label ?? id, account: nil, connected: false))
        }
        return list
    }

    @ViewBuilder
    private func appRows(_ settings: NativeAccountSettings) -> some View {
        if let model = context.services.connectorModel {
            if model.phase == .failed, model.linked.isEmpty {
                JunoEmptyState(
                    title: "Couldn’t load your apps",
                    message: "The list didn’t come back. Nothing has been disconnected.",
                    icon: .error,
                    actionLabel: "Try Again",
                    action: { Task { await model.refresh() } },
                    size: .panel,
                    tone: .error
                )
            } else if model.phase == .idle || model.phase == .loading, model.linked.isEmpty {
                DesktopSettingRowSkeleton()
                DesktopSettingRowSkeleton()
            } else {
                let list = rows(settings, linked: model.linked)
                if list.isEmpty {
                    // A plain row inside the Form's section, not a dashed
                    // tile in a box (§10.2.8), at the form's own rungs.
                    // No control of its own: the section's header already
                    // carries Browse Apps, and one intent gets one button.
                    DesktopSettingRow(
                        title: "No apps connected",
                        description: "Connect GitHub, your calendar, mail or notes and Alevr can work inside them."
                    )
                } else {
                    ForEach(list) { row in
                        appRow(row, settings: settings)
                    }
                }
            }
        } else {
            DesktopSettingsNote(text: "The connector service is unavailable in this window.")
        }
    }

    private func appRow(_ row: AppRow, settings: NativeAccountSettings) -> some View {
        let blocked = settings.blockedConnectors?.contains(row.id) ?? false
        let description: String? = !row.connected
            ? "Not connected. Still blocked if you connect it again."
            : blocked ? "Blocked. Alevr can’t use this app." : row.account
        return LabeledContent {
            if let current = settings.blockedConnectors {
                Toggle(row.label, isOn: Binding(
                    get: { !blocked },
                    set: { allowed in
                        let next = allowed
                            ? current.filter { $0 != row.id }
                            : Array(Set(current + [row.id])).sorted()
                        context.save(
                            "app:\(row.id)",
                            NativeSettingsPatch(blockedConnectors: next),
                            failure: "Couldn’t save. Your permissions are unchanged."
                        )
                    }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(Color.junoAccent)
                .accessibilityLabel(row.label)
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.close) {
                JunoConnectorMark(connectorID: row.id, connectorName: row.label, size: 16)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                DesktopSettingLabel(
                    title: row.label,
                    description: description,
                    status: context.saves.status("app:\(row.id)")
                )
            }
        }
    }

    // MARK: Permissions

    @ViewBuilder
    private func permissionRows(_ settings: NativeAccountSettings) -> some View {
        if let policy = settings.actionApprovalPolicy {
            let lockdown = settings.lockdownMode == true
            let current = Self.policies.first { $0.id == policy }
            DesktopSettingRow(
                title: "When Alevr acts in an app",
                description: lockdown
                    ? "Lockdown is on, so every action is refused. This applies again when you turn it off."
                    : current?.description,
                status: context.saves.status("policy")
            ) {
                Picker("When Alevr acts in an app", selection: Binding(
                    get: { policy },
                    set: { value in
                        guard value != policy else { return }
                        context.save(
                            "policy",
                            NativeSettingsPatch(actionApprovalPolicy: value),
                            failure: "Couldn’t save. Your permissions are unchanged."
                        )
                    }
                )) {
                    ForEach(Self.policies, id: \.id) { option in
                        Text(option.label.desktopMenuTitle).tag(option.id)
                    }
                }
                .labelsHidden()
                .junoGlassMenuPicker(current: current?.label.desktopMenuTitle ?? "")
                .accessibilityIdentifier("juno.desktop.settings.action-policy")
            }
            DesktopSettingToggleRow(
                title: "Lockdown",
                description: "Refuse every action, reading included, whatever the choice above and every approval already given.",
                status: context.saves.status("lockdown"),
                isOn: Binding(
                    get: { lockdown },
                    set: {
                        context.save(
                            "lockdown",
                            NativeSettingsPatch(lockdownMode: $0),
                            failure: "Couldn’t save. Your permissions are unchanged."
                        )
                    }
                ),
                identifier: "juno.desktop.settings.lockdown"
            )
        } else if context.settingsModel.serverSettingsPhase == .failed {
            JunoEmptyState(
                title: "Couldn’t load your permissions",
                message: "Nothing is shown rather than a guess.",
                icon: .error,
                actionLabel: "Try Again",
                action: { Task { await context.loadServerSettings() } },
                size: .panel,
                tone: .error
            )
        } else {
            DesktopSettingRowSkeleton()
            DesktopSettingRowSkeleton()
        }
    }
}
