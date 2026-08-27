import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// The tab sections in the Juno Desktop Settings pop-up modal.
enum DesktopSettingsTab: String, CaseIterable, Identifiable {
    case profile
    case usage
    case appearance
    case chat
    case code
    case memory
    case account
    case danger
    case diagnostics

    var id: Self { self }

    var label: String {
        switch self {
        case .profile: "Profile"
        case .usage: "Plan & Usage"
        case .appearance: "Appearance"
        case .chat: "Chat & Models"
        case .code: "Code & Agent"
        case .memory: "Memory"
        case .account: "Connected Apps"
        case .danger: "Data & Privacy"
        case .diagnostics: "Diagnostics"
        }
    }

    var junoIcon: JunoIcon {
        switch self {
        case .profile: .user
        case .usage: .usage
        case .appearance: .palette
        case .chat: .chat
        case .code: .code
        case .memory: .memory
        case .account: .connections
        case .danger: .trash
        case .diagnostics: .settings
        }
    }
}

/// The pop-up Settings dialog on macOS, matching the website's modal design
/// while using native Liquid Glass components and system keyboard shortcuts.
struct DesktopSettingsModal: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let configuration: JunoDesktopConfiguration?
    let accountDataClient: NativeAccountDataClient?
    let shareClient: NativeShareClient?
    var modelCatalog: [NativeChatModelOption] = []
    var avatarData: Data?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    var openUsage: (() -> Void)?
    var codeHostModel: DesktopCodeHostModel?
    var workHostModel: DesktopWorkHostModel?
    var learningModel: MemoryLearningModel<SQLiteAccountRepository>?
    let onDismiss: () -> Void

    @State private var activeTab: DesktopSettingsTab = .profile
    @State private var innerSheet: DesktopSettingsSheet?

    // Code & Agent Engine Settings (Codex & Claude Code parity)
    @AppStorage("juno.code.approvalPolicy") private var approvalPolicy = "autoSafe"
    @AppStorage("juno.code.preferredShell") private var preferredShell = "/bin/zsh"
    @AppStorage("juno.code.diffMode") private var diffMode = "split"
    @AppStorage("juno.code.autoStage") private var autoStage = true
    @AppStorage("juno.code.autoCommitMessage") private var autoCommitMessage = true
    @AppStorage("juno.code.mcpEnabled") private var mcpEnabled = true
    @AppStorage("juno.code.mcpConfigPath") private var mcpConfigPath = "~/.juno/mcp.json"
    @AppStorage("juno.chat.thinkingBudget") private var thinkingBudget = "auto"
    @AppStorage("juno.voice.vadSensitivity") private var vadSensitivity = "normal"

    var body: some View {
        HStack(spacing: 0) {
            // Sidebar Navigation
            sidebarRail
                .frame(width: 220)
                .background(Color.junoSidebar)

            Divider()
                .overlay(Color.junoSeparator)

            // Content Area
            VStack(spacing: 0) {
                modalHeader
                Divider()
                    .overlay(Color.junoSeparator)
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: JunoSpace.section) {
                        tabContent
                    }
                    .padding(JunoSpace.loose)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Color.junoCanvas)
            }
        }
        .frame(minWidth: 840, idealWidth: 880, maxWidth: 960, minHeight: 560, idealHeight: 620, maxHeight: 760)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.sheet, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.sheet, style: .continuous)
                .strokeBorder(Color.junoGlassEdge, lineWidth: 0.5)
        )
        .sheet(item: $innerSheet) { sheet in
            DesktopSettingsSheetHost(sheet: sheet) {
                switch sheet {
                case .sharedLinks:
                    NativeSharedLinksView(client: shareClient, accountID: session.profile.id)
                case .diagnostics:
                    NativeDiagnosticsView(
                        session: session,
                        syncModel: syncModel,
                        outbox: outbox,
                        accountDataClient: accountDataClient
                    )
                }
            }
        }
    }

    // MARK: - Sidebar Rail

    private var sidebarRail: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("Settings")
                .font(.headline)
                .foregroundStyle(Color.junoForeground)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.regular)
                .padding(.bottom, JunoSpace.tight)

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 2) {
                    ForEach(DesktopSettingsTab.allCases) { tab in
                        let isSelected = activeTab == tab
                        Button {
                            withAnimation(JunoMotion.standard) {
                                activeTab = tab
                            }
                        } label: {
                            HStack(spacing: JunoSpace.snug) {
                                JunoIconView(tab.junoIcon, size: 15)
                                    .foregroundStyle(isSelected ? Color.junoForeground : Color.junoSidebarForeground)
                                Text(tab.label)
                                    .font(.callout.weight(isSelected ? .semibold : .regular))
                                    .foregroundStyle(isSelected ? Color.junoForeground : Color.junoSidebarForeground)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, JunoSpace.snug)
                            .padding(.vertical, 7)
                            .background(
                                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                                    .fill(isSelected ? Color.junoSidebarSelection : Color.clear)
                            )
                            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(tab.label)
                    }
                }
                .padding(.horizontal, JunoSpace.tight)
            }

            Spacer(minLength: 0)

            // Account snippet in footer
            HStack(spacing: JunoSpace.snug) {
                JunoAvatar(
                    imageData: avatarData,
                    imageURL: session.profile.imageURL,
                    name: session.profile.name ?? session.profile.email,
                    size: 24
                )
                VStack(alignment: .leading, spacing: 0) {
                    Text(session.profile.name ?? "Juno account")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                    Text(session.profile.email)
                        .font(.caption2)
                        .junoSecondaryInk()
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
        }
    }

    // MARK: - Header

    private var modalHeader: some View {
        HStack(alignment: .center, spacing: JunoSpace.regular) {
            Text(activeTab.label)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.junoForeground)

            Spacer(minLength: 0)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.junoSecondaryForeground)
                    .frame(width: 24, height: 24)
                    .background(Color.junoMuted.opacity(0.5), in: Circle())
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Circle())
            .keyboardShortcut(.cancelAction)
            .help("Close settings (Esc)")
            .accessibilityLabel("Close settings")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoRaised.opacity(0.5))
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch activeTab {
        case .profile:
            profileSection
        case .usage:
            usageSection
        case .appearance:
            appearanceSection
        case .chat:
            chatSection
        case .code:
            codeSection
        case .memory:
            memorySection
        case .account:
            accountSection
        case .danger:
            dangerSection
        case .diagnostics:
            diagnosticsSection
        }
    }

    // MARK: - Sections

    private var profileSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            JunoSettingsTile("Account details") {
                HStack(spacing: JunoSpace.regular) {
                    JunoAvatar(
                        imageData: avatarData,
                        imageURL: session.profile.imageURL,
                        name: session.profile.name ?? session.profile.email,
                        size: 48
                    )
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.profile.name ?? "User")
                            .font(.headline)
                        Text(session.profile.email)
                            .font(.callout)
                            .junoSecondaryInk()
                    }
                }
            }

            if let settings = model.settings {
                DesktopSettingsInstructionsTile(
                    settings: settings,
                    disabled: model.isMutating,
                    update: updateHandler
                )
            }
        }
    }

    private var usageSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            JunoSettingsTile("Plan & Subscription") {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Current Plan: Pro")
                            .font(.headline)
                        Text("Unlimited fast requests, Gemini 3.7 Flash thinking, and Juno Code Remote.")
                            .font(.caption)
                            .junoSecondaryInk()
                    }
                    Spacer()
                    Button("Manage Billing") {
                        let url = JunoBackend.productionURL.appendingPathComponent("settings")
                        NSWorkspace.shared.open(url)
                    }
                    .buttonStyle(.borderedProminent)
                    .contentShape(.rect)
                }
            }

            if let openUsage {
                JunoSettingsTile("Usage Breakdown") {
                    Text("View real-time token spend, allowance reset dates, and usage analytics.")
                        .font(.caption)
                        .junoSecondaryInk()
                    Button("Open Usage Dashboard") {
                        onDismiss()
                        openUsage()
                    }
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
                }
            }
        }
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if let settings = model.settings {
                DesktopSettingsAppearanceTile(
                    settings: settings,
                    disabled: model.isMutating,
                    update: updateHandler
                )
                DesktopSettingsStyleTile(
                    settings: settings,
                    disabled: model.isMutating,
                    update: updateHandler
                )
            }
        }
    }

    private var chatSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if let settings = model.settings {
                DesktopSettingsModelTile(
                    settings: settings,
                    modelCatalog: modelCatalog,
                    disabled: model.isMutating,
                    update: updateHandler
                )

                if !modelCatalog.isEmpty {
                    DesktopSettingsFavoritesTile(
                        settings: settings,
                        modelCatalog: modelCatalog,
                        disabled: model.isMutating,
                        update: updateHandler
                    )
                }

                JunoSettingsTile("Thinking Budget & Reasoning Effort") {
                    Text("Controls reasoning tokens budget for hybrid thinking models like Gemini 3.7 Flash and Claude 3.7 Sonnet.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)

                    Picker("Thinking Budget", selection: $thinkingBudget) {
                        Text("Dynamic (Auto)").tag("auto")
                        Text("Low (1,024 tokens)").tag("low")
                        Text("Medium (4,096 tokens)").tag("medium")
                        Text("High (16,384 tokens)").tag("high")
                        Text("Extended (32,768 tokens)").tag("max")
                    }
                    .labelsHidden()
                }

                JunoSettingsTile("Voice & Audio Interruption") {
                    Text("Voice Activity Detection sensitivity and real-time server barge-in.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)

                    Picker("VAD Sensitivity", selection: $vadSensitivity) {
                        Text("High (Instant Interruption)").tag("sensitive")
                        Text("Normal (Balanced)").tag("normal")
                        Text("Relaxed (Longer Pause)").tag("relaxed")
                    }
                    .labelsHidden()
                }
            }
        }
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            JunoSettingsTile("Execution Approval Policy") {
                Text("Controls how Juno Code runs commands and edits files (Codex & Claude Code parity).")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)

                Picker("Approval Policy", selection: $approvalPolicy) {
                    Text("Auto-approve Safe Commands (Recommended)").tag("autoSafe")
                    Text("Always Ask before Execution").tag("alwaysAsk")
                    Text("Full Autonomous Mode (Auto-run)").tag("autonomous")
                }
                .labelsHidden()
            }

            JunoSettingsTile("Shell & Environment") {
                Text("Default terminal shell used for local tool execution.")
                    .junoCaption()

                Picker("Preferred Shell", selection: $preferredShell) {
                    Text("Zsh (/bin/zsh)").tag("/bin/zsh")
                    Text("Bash (/bin/bash)").tag("/bin/bash")
                    Text("Fish (/opt/homebrew/bin/fish)").tag("/opt/homebrew/bin/fish")
                }
                .labelsHidden()
            }

            JunoSettingsTile("Editor & Git Integration") {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    Picker("Diff Display", selection: $diffMode) {
                        Text("Side-by-Side Split").tag("split")
                        Text("Unified Inline").tag("inline")
                    }
                    .pickerStyle(.segmented)

                    Toggle("Auto-stage modified files on task completion", isOn: $autoStage)
                    Toggle("Auto-generate conventional commit messages", isOn: $autoCommitMessage)
                }
            }

            JunoSettingsTile("Model Context Protocol (MCP)") {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    Toggle("Enable Model Context Protocol (MCP) Host", isOn: $mcpEnabled)
                    HStack {
                        Text("Config:")
                            .font(.caption)
                            .junoSecondaryInk()
                        TextField("MCP Config Path", text: $mcpConfigPath)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }

            if codeHostModel != nil {
                DesktopSettingsHostTile(model: codeHostModel)
            }
            if workHostModel != nil {
                DesktopSettingsWorkHostTile(model: workHostModel)
            }
        }
    }

    private var memorySection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopSettingsMemoryTile(
                model: model,
                openManager: {
                    let url = JunoBackend.productionURL.appendingPathComponent("memory")
                    NSWorkspace.shared.open(url)
                },
                reviewProposals: nil,
                update: updateHandler
            )
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopSettingsAccountTile(
                session: session,
                authModel: authModel,
                openSharedLinks: { innerSheet = .sharedLinks },
                openDiagnostics: { innerSheet = .diagnostics }
            )
        }
    }

    private var dangerSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            DesktopSettingsDangerTile(
                authModel: authModel,
                session: session,
                accountDataClient: accountDataClient,
                outbox: outbox
            )
        }
    }

    private var diagnosticsSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            JunoSettingsTile("System & Diagnostics") {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.3.2 (Build 73)")
                            .junoSecondaryInk()
                    }
                    HStack {
                        Text("Channel")
                        Spacer()
                        Text("Stable")
                            .junoSecondaryInk()
                    }
                    HStack {
                        Text("Contract")
                        Spacer()
                        Text("1.3.0")
                            .junoSecondaryInk()
                    }
                    Divider()
                    Button("Open Diagnostics Details…") {
                        innerSheet = .diagnostics
                    }
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
                }
            }
        }
    }

    private var updateHandler: @MainActor (NativeSettingsPatch) async -> Void {
        { patch in
            await model.updateSettings(patch)
        }
    }
}
