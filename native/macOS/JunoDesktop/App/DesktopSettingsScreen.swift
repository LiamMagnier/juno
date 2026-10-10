import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - The pane switch

/// **Settings**, one section at a time: the section's pane, in the web's order
/// and with the web's rows (Phase 3, brief §C1–C3).
///
/// Each pane is its own file (`DesktopSettings…Pane.swift`) over one
/// ``DesktopSettingsContext``, which holds the account, the clients, every
/// row's save status and the window's toasts.
struct DesktopSettingsScreen: View {
    let section: DesktopSettingsSection
    let context: DesktopSettingsContext

    var body: some View {
        // The pane's form is the column's only child: it takes the column's
        // height and scrolls (see ``DesktopSettingsShell``). The hero card
        // reaches the form through the environment, as its first section.
        pane
            .environment(\.desktopSettingsLead, .section(section))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // A conflict, or a save queued behind the network, in the Settings
            // window's toast host (§7.7).
            .junoToastStatus(id: "settings.status", context.statusKey) { _ in context.statusToast }
            .accessibilityIdentifier("juno.desktop.settings")
    }

    @ViewBuilder
    private var pane: some View {
        switch section {
        case .general: DesktopSettingsGeneralPane(context: context)
        case .personalization: DesktopSettingsPersonalizationPane(context: context)
        case .memory: DesktopSettingsMemoryPane(context: context)
        case .models: DesktopSettingsModelsPane(context: context)
        case .connectors: DesktopSettingsConnectorsPane(context: context)
        case .devices: DesktopSettingsDevicesPane(context: context)
        case .voice: DesktopSettingsVoicePane(context: context)
        case .data: DesktopSettingsDataPane(context: context)
        case .account: DesktopSettingsAccountPane(context: context)
        case .billing: DesktopSettingsPlanPane(context: context)
        case .code:
            DesktopCodeSettingsScreen(
                workbench: context.services.codeWorkbench,
                availableModels: context.services.codeModels,
                codeHostModel: context.services.codeHostModel
            )
        }
    }
}

/// What a settings form opens on, above its own sections.
enum DesktopSettingsLead: Equatable {
    /// A Settings section: its hero card (tile, name, one sentence).
    case section(DesktopSettingsSection)
    /// A page in the main window that reuses a pane (Customize ›
    /// Instructions): the page's title and lede, unboxed.
    case page(title: String, lede: String)
}

extension EnvironmentValues {
    /// The lead the next ``DesktopSettingsForm`` down draws first. Nil draws
    /// none.
    @Entry var desktopSettingsLead: DesktopSettingsLead? = nil
}

/// The pane's opening, as System Settings opens a pane: the section's tile
/// on the accent, its name and one sentence on what it holds, in a card of
/// its own at the top of the form. It scrolls with the rows, so it can never
/// sit under the toolbar's title.
struct DesktopSettingsPaneHero: View {
    let section: DesktopSettingsSection

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            DesktopSettingsSectionTile(icon: section.icon)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(section.label)
                    .junoType(JunoType.ui.weight(.semibold))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(section.summary)
                    .junoType(JunoType.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, JunoSpace.tight)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.desktop.settings.pane-header")
        .desktopLayoutProbe("settings.lead")
    }
}

/// A page's title and lede above a reused pane's rows, on the rows' own
/// leading edge.
struct DesktopSettingsPageLead: View {
    let title: String
    let lede: String

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoType(.title)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text(lede)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textCase(nil)
        .accessibilityIdentifier("juno.desktop.settings.page-lead")
        .desktopLayoutProbe("page.lead")
    }
}

/// The grouped form every pane is drawn in: the platform's grouped `Form`,
/// its own background hidden so the window's canvas shows through, its lead
/// first, and its cards held to a readable measure, centred, however wide
/// the window gets.
struct DesktopSettingsForm<Content: View>: View {
    @ViewBuilder let content: Content

    @Environment(\.desktopSettingsLead) private var lead
    @State private var width: CGFloat = 0

    /// The side margin that keeps the cards at ``DesktopSettingsMetrics/paneMeasure``.
    private var sideMargin: CGFloat {
        max(0, (width - DesktopSettingsMetrics.paneMeasure) / 2)
    }

    var body: some View {
        Form {
            switch lead {
            case .section(let section):
                Section {
                    DesktopSettingsPaneHero(section: section)
                }
            case .page(let title, let lede):
                Section {
                } header: {
                    DesktopSettingsPageLead(title: title, lede: lede)
                }
            case nil:
                EmptyView()
            }
            // A sheet opened from a row is not this pane: it draws no lead.
            content
                .environment(\.desktopSettingsLead, nil)
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.horizontal, sideMargin, for: .scrollContent)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// A pane over the account's settings record, or the reason it is missing,
/// with Reload.
struct DesktopSettingsRecordForm<Content: View>: View {
    let context: DesktopSettingsContext
    @ViewBuilder let content: (NativeAccountSettings) -> Content

    var body: some View {
        DesktopSettingsForm {
            if let settings = context.settings {
                content(settings)
            } else {
                Section {
                    DesktopSettingRow(title: context.unavailableMessage) {
                        DesktopOutlineButton(title: "Reload") {
                            Task { await context.settingsModel.refresh() }
                        }
                        .accessibilityIdentifier("juno.desktop.settings.reload")
                    }
                }
            }
        }
    }
}

// MARK: - Loading

/// A resource a pane reads from the server: not yet, here, or why not.
enum DesktopSettingsLoad<Value> {
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}

/// One public link the account has made (`GET /api/share`).
struct DesktopSharedLink: Identifiable, Equatable, Sendable {
    let id: String
    /// `CHAT` or `ARTIFACT`.
    let kind: String
    let url: URL
    let title: String
    let snapshotAt: Date?
    let views: Int

    var isChat: Bool { kind.uppercased() == "CHAT" }
}

// MARK: - Context

/// Everything a Settings pane reads and writes, for one window.
@MainActor
@Observable
final class DesktopSettingsContext {
    typealias SettingsModel = NativeMemorySettingsModel<SQLiteAccountRepository>

    /// The clients and models Settings reaches through. Every one is optional:
    /// a row whose client is absent says so, or is absent itself.
    struct Services {
        var sender: (any NativeAuthenticatedRequestSending)?
        var accountData: NativeAccountDataClient?
        var shareClient: NativeShareClient?
        var messageActions: NativeMessageActionsClient?
        var connectorModel: NativeConnectorModel?
        var workHostModel: DesktopWorkHostModel?
        var hostsLoader: (@Sendable (AccountID) async throws -> [WorkHostSummary])?
        var syncModel: NativeSyncModel<SQLiteAccountRepository>?
        var outbox: (any MutationOutboxRepository)?
        var learningModel: MemoryLearningModel<SQLiteAccountRepository>?
        var avatarModel: NativeAvatarModel?
        var codeWorkbench: WorkbenchModel?
        var codeModels: [ModelOption] = []
        var codeHostModel: DesktopCodeHostModel?

        var billing: NativeBillingClient? { sender.map(NativeBillingClient.init(sender:)) }
        var security: NativeAccountSecurityClient? { sender.map(NativeAccountSecurityClient.init(sender:)) }
        var importer: NativeImportClient? { sender.map(NativeImportClient.init(sender:)) }
        var usage: NativeUsageClient? { sender.map(NativeUsageClient.init(sender:)) }
    }

    let profile: NativeAccountProfile
    let settingsModel: SettingsModel
    let services: Services
    let saves: DesktopSaveStates
    let toasts: JunoToastCenter
    /// Signs this Mac out. Nil in previews and snapshots.
    let signOut: (@MainActor () async -> Void)?
    var modelCatalog: [NativeChatModelOption]

    var plan: DesktopSettingsLoad<NativeUsagePlan> = .loading
    var history: DesktopSettingsLoad<NativeUsageBreakdown> = .loading
    var sharedLinks: DesktopSettingsLoad<[DesktopSharedLink]> = .loading
    var hosts: DesktopSettingsLoad<[WorkHostSummary]> = .loading
    /// The latest hosts check failed while an older answer is still shown.
    var hostsAreStale = false
    var security: DesktopSettingsLoad<NativeAccountSecurityStatus> = .loading

    init(
        profile: NativeAccountProfile,
        settingsModel: SettingsModel,
        services: Services,
        modelCatalog: [NativeChatModelOption],
        saves: DesktopSaveStates = DesktopSaveStates(),
        toasts: JunoToastCenter = JunoToastCenter(),
        signOut: (@MainActor () async -> Void)? = nil
    ) {
        self.profile = profile
        self.settingsModel = settingsModel
        self.services = services
        self.modelCatalog = modelCatalog
        self.saves = saves
        self.toasts = toasts
        self.signOut = signOut
    }

    /// A record drawn instead of the model's — previews and snapshots only.
    var previewSettings: NativeAccountSettings?

    var accountID: AccountID { profile.id }
    var settings: NativeAccountSettings? { previewSettings ?? settingsModel.settings }

    /// What Juno calls you: a name saved from Settings, else the profile's.
    var displayName: String? {
        let saved = settings?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let saved, !saved.isEmpty { return saved }
        return profile.name
    }

    /// The plan in force, once the usage route has answered.
    var planID: String? { plan.value?.planID.uppercased() }

    // MARK: Writing

    /// Writes a change the web's way: optimistic, the row's status beside its
    /// label, and a refusal toasted with its reason.
    func save(_ key: String, _ patch: NativeSettingsPatch, failure: String = "Couldn’t save settings.") {
        let model = settingsModel
        let toasts = toasts
        Task {
            await saves.track(key) {
                let result = await model.saveSettings(patch)
                if case .failed(let reason) = result {
                    toasts.post(.error(failure, detail: reason.isEmpty ? nil : reason))
                }
                return result.succeeded
            }
        }
    }

    // MARK: Reading

    /// `GET /api/settings`, for the fields the sync record does not carry.
    func loadServerSettings() async {
        await settingsModel.refreshServerSettings()
    }

    func loadPlan() async {
        guard let sender = services.sender else {
            plan = .failed("Usage is unavailable in this window.")
            return
        }
        do {
            let response = try await sender.send(
                try NativeBearerRequest(path: "/api/profile/usage", headers: try HTTPHeaders(["accept": "application/json"])),
                for: accountID
            )
            guard (200...299).contains(response.statusCode) else {
                plan = .failed("Your plan couldn’t be loaded.")
                return
            }
            let loaded = try NativeUsagePlan.decode(response.body)
            plan = .loaded(loaded)
            DesktopPlanGate.shared.update(planID: loaded.planID)
        } catch {
            plan = .failed("Your plan couldn’t be loaded.")
        }
    }

    func loadHistory() async {
        guard let sender = services.sender else {
            history = .failed("Your usage history couldn’t be loaded.")
            return
        }
        history = .loading
        do {
            let response = try await sender.send(
                try NativeBearerRequest(
                    path: "/api/profile/usage/breakdown",
                    queryItems: [URLQueryItem(name: "days", value: "30")],
                    headers: try HTTPHeaders(["accept": "application/json"])
                ),
                for: accountID
            )
            guard (200...299).contains(response.statusCode) else {
                history = .failed("Your usage history couldn’t be loaded.")
                return
            }
            history = .loaded(try NativeUsageBreakdown.decode(response.body))
        } catch {
            history = .failed("Your usage history couldn’t be loaded.")
        }
    }

    func loadSharedLinks() async {
        guard let sender = services.sender else {
            sharedLinks = .failed("Couldn’t load your shared links.")
            return
        }
        sharedLinks = .loading
        do {
            let response = try await sender.send(
                try NativeBearerRequest(path: "/api/share", headers: try HTTPHeaders(["accept": "application/json"])),
                for: accountID
            )
            guard (200...299).contains(response.statusCode) else {
                sharedLinks = .failed("Couldn’t load your shared links.")
                return
            }
            sharedLinks = .loaded(try Self.decodeShares(response.body))
        } catch {
            sharedLinks = .failed("Couldn’t load your shared links.")
        }
    }

    func revoke(_ link: DesktopSharedLink) async {
        guard let shareClient = services.shareClient else { return }
        do {
            try await shareClient.revoke(shareID: link.id, for: accountID)
            if case .loaded(let links) = sharedLinks {
                sharedLinks = .loaded(links.filter { $0.id != link.id })
            }
            toasts.post(.success("Link revoked. It no longer opens."))
        } catch {
            toasts.post(.error("Couldn’t revoke the link."))
        }
    }

    func loadHosts() async {
        guard let loader = services.hostsLoader else {
            hosts = .loaded([])
            return
        }
        do {
            hosts = .loaded(try await loader(accountID))
            hostsAreStale = false
        } catch {
            if hosts.value != nil {
                hostsAreStale = true
            } else {
                hosts = .failed("Couldn’t load your Macs. Anything already signed in can still be reached, with the permissions it had.")
            }
        }
    }

    func loadSecurity() async {
        guard let client = services.security else {
            security = .failed("")
            return
        }
        do {
            security = .loaded(try await client.status(for: accountID))
        } catch {
            security = .failed(NativeFailureMessage.presentable(error))
        }
    }

    static func decodeShares(_ data: Data) throws -> [DesktopSharedLink] {
        struct Wire: Decodable {
            struct Share: Decodable {
                let id: String
                let kind: String?
                let url: String
                let title: String?
                let snapshotAt: String?
                let views: Int?
            }

            let shares: [Share]
        }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return try JSONDecoder().decode(Wire.self, from: data).shares.compactMap { share in
            guard let url = URL(string: share.url) else { return nil }
            let date = share.snapshotAt.flatMap { precise.date(from: $0) ?? plain.date(from: $0) }
            return DesktopSharedLink(
                id: share.id,
                kind: share.kind ?? "CHAT",
                url: url,
                title: share.title ?? "",
                snapshotAt: date,
                views: share.views ?? 0
            )
        }
    }

    // MARK: The window's status

    /// Why a pane has no rows yet, in the model's own words.
    var unavailableMessage: String {
        switch settingsModel.phase {
        case .idle, .loading:
            "Loading your account settings…"
        case .offline:
            DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(settingsModel.lastErrorDescription, fallback: "Your settings will appear once Alevr reconnects.")
        case .failed:
            DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(settingsModel.lastErrorDescription, fallback: "Alevr could not load your settings.")
        case .ready:
            "Account settings have not finished synchronizing."
        }
    }

    /// What the status toast is keyed on: a conflict arriving is a new post.
    var statusKey: String? {
        settingsModel.conflictedMutationCount > 0 ? "conflict" : nil
    }

    /// A conflict that needs a decision, which stays until it is answered.
    var statusToast: JunoToast {
        JunoToast(
            tone: .warning,
            title: "Memory or settings changed on another device.",
            action: JunoToast.Action("Keep Mine") {
                Task { await self.settingsModel.resolveConflicts(keepLocalChanges: true) }
            },
            cancel: JunoToast.Action("Use Server Version") {
                Task { await self.settingsModel.resolveConflicts(keepLocalChanges: false) }
            },
            duration: nil
        )
    }
}

// MARK: - Shared furniture

enum DesktopSettingsMetrics {
    /// The sections column: the web sidebar's 260, resizable a little either
    /// way.
    static let railMinimum: CGFloat = JunoSidebarMetrics.minimum
    static let railWidth: CGFloat = JunoSidebarMetrics.ideal
    static let railMaximum: CGFloat = 300
    /// The ⌘, window: opens at 900 × 660, never smaller than 760 × 520, so
    /// the sidebar keeps its 260 and a pane keeps 500 for a label and its
    /// control.
    static let windowMinimum = CGSize(width: 760, height: 520)
    static let windowIdeal = CGSize(width: 900, height: 660)
    /// The pane's readable measure: cards never run wider, however wide the
    /// window.
    static let paneMeasure: CGFloat = 720
    /// A grouped card's corner, as the grouped form draws its sections.
    static let cardRadius: CGFloat = 10
    /// The signed-in account's photo in Account.
    static let avatarSize: CGFloat = 56
    /// A presented surface's size. Explicit: a sheet that negotiates its own
    /// size re-lays out the window underneath it as it appears.
    static let sheetWidth: CGFloat = 480
    static let sheetHeight: CGFloat = 520
    /// The narrow confirmation sheets: a paragraph and a field, nothing more.
    static let confirmWidth: CGFloat = 460
    /// A multi-line editor's floor: a short paragraph visible without scrolling.
    static let editorMinHeight: CGFloat = 132
    /// An accent swatch.
    static let swatchSize: CGFloat = 24
    /// The text size slider's track, wide enough for six ticks to read as
    /// six stops.
    static let sliderWidth: CGFloat = 168
    /// A trailing value beside a slider ("16 pt").
    static let valueWidth: CGFloat = 40
    /// A provider mark beside a model's name.
    static let providerMark: CGFloat = 20
    /// A trailing control's width in a wide row (the web's `w-52`).
    static let menuWidth: CGFloat = 208
}

/// A snapshot on its way to a file the reader chooses — the account export,
/// or the memory export written locally.
///
/// Write-only: reading one back into the app is not a thing Juno does, so the
/// read initializer refuses rather than pretending to import.
struct DesktopSettingsExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .commaSeparatedText, .zip] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        throw CocoaError(.fileReadUnsupportedScheme)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

/// Keeps a stored value the picker does not recognize selectable, so opening a
/// menu can never silently rewrite a preference this build has not shipped.
func junoKnownOrCurrent(_ known: [String], current: String) -> [String] {
    known.contains(current) ? known : [current] + known
}

/// A system sheet over a Settings pane: the title, the content, and the
/// buttons in a footer. No ground of its own — the system draws the sheet —
/// and an explicit frame (§C1).
struct DesktopSettingsSheet<Content: View, Buttons: View>: View {
    let title: String
    var message: String?
    var width: CGFloat = DesktopSettingsMetrics.sheetWidth
    @ViewBuilder var content: Content
    @ViewBuilder var buttons: Buttons

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(title)
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                if let message {
                    Text(message)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            content
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                buttons
            }
        }
        .padding(JunoSpace.section)
        .frame(width: width)
        .fixedSize(horizontal: false, vertical: true)
        .presentationSizing(.form)
    }
}
