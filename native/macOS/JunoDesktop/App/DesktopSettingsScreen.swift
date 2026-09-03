import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// **Settings** — one section at a time, as a native grouped form.
///
/// The website's settings modal is a rail on the left and a pane on the right;
/// this is that pane. Every section that holds preferences is a `Form` in the
/// platform's grouped style — real `Toggle`, `Picker` and `TextField` rows,
/// section headers in the secondary caption, no tile grid, no card-in-a-card,
/// no chevrons except the ones a native disclosure draws itself. The three
/// sections that are whole screens elsewhere in the app (Connectors, Plan &
/// billing, Code) are those screens, wrapped, so there is one of each.
///
/// Two things this page deliberately does *not* do:
///
/// - **It does not report an ideal height.** A `Form` scrolls and takes the
///   height it is given, which is what stops a settings pane resizing the
///   window's split view.
/// - **It does not paint the reading canvas.** The shell around it does, once.
struct DesktopSettingsScreen: View {
    let section: DesktopSettingsSection
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let accountDataClient: NativeAccountDataClient?
    /// Lists and revokes the account's public links.
    let shareClient: NativeShareClient?
    /// The account's model catalog, for the default-model and favourites rows.
    /// Empty until the signed-in manifest arrives, and those rows say so rather
    /// than offering an empty menu.
    var modelCatalog: [NativeChatModelOption] = []
    /// The account photo's bytes, already fetched through the authenticated file
    /// route by `NativeAvatarModel`.
    var avatarData: Data?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    var connectorModel: NativeConnectorModel?
    var requestSender: (any NativeAuthenticatedRequestSending)?
    var codeWorkbench: WorkbenchModel?
    var codeModels: [ModelOption] = []
    /// Hosting for Juno Code Remote. Nil where the window has no host — the
    /// tile is absent rather than showing a switch that controls nothing.
    var codeHostModel: DesktopCodeHostModel?
    /// Whether this Mac serves Juno Work, and on what terms. Nil for the same
    /// reason `codeHostModel` is.
    var workHostModel: DesktopWorkHostModel?
    /// What ``MemoryExtractionEngine`` has proposed and not yet been answered on.
    /// Nil where nothing runs the engine, and the review control is absent then.
    var learningModel: MemoryLearningModel<SQLiteAccountRepository>?

    @State private var sheet: DesktopSettingsSheet?
    /// Whether the memory manager has taken over the pane, behind a back
    /// control — one page swapping for another, not a nested navigation.
    @State private var isShowingMemory = false
    @State private var isReviewingProposals = false

    var body: some View {
        Group {
            if section == .memory, isShowingMemory {
                DesktopMemoryScreen(model: model, back: { isShowingMemory = false })
            } else if section == .memory, isReviewingProposals, let learningModel {
                proposalReview(learningModel)
            } else {
                pane
            }
        }
        .overlay(alignment: .bottom) { statusChrome }
        .sheet(item: $sheet) { sheet in
            DesktopSettingsSheetHost(sheet: sheet) {
                switch sheet {
                case .sharedLinks:
                    NativeSharedLinksView(client: shareClient, accountID: session.profile.id)
                case .diagnostics:
                    NativeDiagnosticsView(
                        syncModel: syncModel,
                        outbox: outbox,
                        accountID: StorageAccountID(session.profile.id.rawValue)
                    )
                    .formStyle(.grouped)
                    .scrollContentBackground(.hidden)
                }
            }
        }
        // Diagnostics rather than Shared links: it is the taller of the two and
        // fills the host's fixed frame, which is what makes the ground under the
        // content — the thing the overlay contract is about — visible at all.
        .desktopPreviewOverlays(sheet: { sheet = .diagnostics })
        .accessibilityIdentifier("juno.desktop.settings")
    }

    // MARK: - Sections

    @ViewBuilder
    private var pane: some View {
        switch section {
        case .general:
            settingsForm { settings in
                DesktopSettingsGeneralSections(
                    settings: settings,
                    disabled: model.isMutating,
                    update: updateHandler,
                    openDiagnostics: { sheet = .diagnostics }
                )
            }
        case .personalization:
            settingsForm { settings in
                DesktopSettingsPersonalizationSections(
                    settings: settings,
                    disabled: model.isMutating,
                    update: updateHandler
                )
            }
        case .memory:
            settingsForm { _ in
                memorySections
            }
        case .models:
            settingsForm { settings in
                DesktopSettingsModelSections(
                    settings: settings,
                    modelCatalog: modelCatalog,
                    disabled: model.isMutating,
                    update: updateHandler
                )
            }
        case .voice:
            settingsForm { settings in
                DesktopSettingsVoiceSections(
                    settings: settings,
                    disabled: model.isMutating,
                    update: updateHandler
                )
            }
        case .connectors:
            if let connectorModel {
                DesktopConnectionsScreen(model: connectorModel)
            } else {
                JunoEmptyState(
                    title: "Connectors",
                    message: "The connector service is unavailable in this window.",
                    icon: .connections
                )
            }
        case .code:
            DesktopCodeSettingsScreen(
                workbench: codeWorkbench,
                availableModels: codeModels,
                codeHostModel: codeHostModel,
                workHostModel: workHostModel
            )
        case .data:
            DesktopSettingsForm {
                DesktopSettingsDataSections(
                    session: session,
                    accountDataClient: accountDataClient,
                    showsSharedLinks: shareClient != nil,
                    openSharedLinks: { sheet = .sharedLinks },
                    openDiagnostics: { sheet = .diagnostics }
                )
            }
        case .account:
            settingsForm { settings in
                DesktopSettingsAccountSections(
                    settings: settings,
                    session: session,
                    avatarData: avatarData,
                    authModel: authModel,
                    accountDataClient: accountDataClient,
                    disabled: model.isMutating,
                    update: updateHandler
                )
            }
        case .billing:
            if let requestSender {
                DesktopUsageScreen(
                    session: session,
                    requestSender: requestSender,
                    modelCatalog: modelCatalog
                )
            } else {
                JunoEmptyState(
                    title: "Plan & billing",
                    message: "Usage is unavailable in this window. Open Settings from the application menu (⌘,) to see your plan.",
                    icon: .usage
                )
            }
        }
    }

    /// A grouped form over the account's settings record, or the reason it is
    /// missing with the model's retry attached.
    @ViewBuilder
    private func settingsForm<Content: View>(
        @ViewBuilder _ content: @escaping (NativeAccountSettings) -> Content
    ) -> some View {
        DesktopSettingsForm {
            if let settings = model.settings {
                content(settings)
            } else {
                Section {
                    LabeledContent {
                        Button("Reload") { Task { await model.refresh() } }
                            .accessibilityIdentifier("juno.desktop.settings.reload")
                    } label: {
                        Text(settingsUnavailableMessage)
                            .junoRowLabel()
                            .junoSecondaryInk()
                    }
                } header: {
                    DesktopSettingsHeader("Preferences")
                }
            }
        }
    }

    /// Why a settings section has no controls yet, in the model's own words.
    private var settingsUnavailableMessage: String {
        switch model.phase {
        case .idle, .loading:
            "Loading your account settings…"
        case .offline:
            DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(
                    model.lastErrorDescription,
                    fallback: "Offline — your settings will appear once Juno reconnects."
                )
        case .failed:
            DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(
                    model.lastErrorDescription,
                    fallback: "Juno could not load your settings."
                )
        case .ready:
            "Account settings have not finished synchronizing."
        }
    }

    // MARK: - Memory

    /// The switch, the count and the two doors, then who may process what the
    /// switch enables.
    @ViewBuilder
    private var memorySections: some View {
        Section {
            Toggle(isOn: memoryBinding) {
                DesktopSettingsLabel(
                    "Reference saved memories",
                    detail: "Juno keeps helpful details from your chats and uses them as context."
                )
            }
            .toggleStyle(.switch)
            .tint(Color.junoAccent)
            .disabled(model.isMutating || model.settings == nil)
            .accessibilityLabel("Reference saved memories")
            .accessibilityIdentifier("juno.desktop.settings.memory-enabled")

            LabeledContent {
                Button("Open memory manager") { isShowingMemory = true }
                    .accessibilityIdentifier("juno.desktop.settings.memory-manager")
            } label: {
                DesktopSettingsLabel(
                    "Saved memories",
                    detail: "^[\(model.memories.count) saved fact](inflect: true)"
                )
            }

            if let learningModel {
                let waiting = learningModel.proposals.count
                LabeledContent {
                    Button(waiting == 0 ? "Review" : "Review (\(waiting))") {
                        isReviewingProposals = true
                    }
                    .accessibilityIdentifier("juno.desktop.settings.memory-proposals")
                } label: {
                    DesktopSettingsLabel(
                        "What Juno noticed",
                        detail: "Keep or discard details picked up in your chats. Nothing is saved until you keep it."
                    )
                }
            }
        } header: {
            DesktopSettingsHeader("Memory")
        }

        Section {
            Picker(
                selection: Binding(
                    get: { model.settings?.backgroundProviderMode ?? .default },
                    set: { update(NativeSettingsPatch(backgroundProviderMode: $0)) }
                )
            ) {
                ForEach(BackgroundProviderMode.allCases, id: \.self) { mode in
                    Text(mode.title).tag(mode)
                }
            } label: {
                DesktopSettingsLabel(
                    "Background processing",
                    detail: LocalizedStringKey((model.settings?.backgroundProviderMode ?? .default).explanation)
                )
            }
            .disabled(model.isMutating || model.settings == nil)
            .accessibilityIdentifier("juno.desktop.settings.background-provider")

            // Only the mode that can actually cross is flagged. A caution on
            // every option would train the reader to ignore the one that means
            // something.
            if (model.settings?.backgroundProviderMode ?? .default).permitsCrossProvider {
                JunoIconLabel(
                    "Content may reach a provider you did not pick.",
                    icon: .error,
                    size: 13
                )
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
            }
        } header: {
            DesktopSettingsHeader("Who may process your chats")
        }
    }

    /// ``NativeMemoryManagerView``, given the same model this page is already
    /// showing and a way back.
    private func proposalReview(
        _ learningModel: MemoryLearningModel<SQLiteAccountRepository>
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.cozy) {
                Button {
                    isReviewingProposals = false
                } label: {
                    JunoIconLabel("Memory", icon: .arrowLeft, size: 13)
                        .junoRowLabel()
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .keyboardShortcut("[", modifiers: .command)
                .help("Back to settings (⌘[)")
                .accessibilityIdentifier("juno.desktop.memory-proposals.back")
                .contentShape(.rect)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.regular)

            NativeMemoryManagerView(
                model: model,
                proposals: learningModel.proposals,
                onDecideProposal: { candidate, keep in
                    Task {
                        if keep {
                            await learningModel.accept(candidate)
                        } else {
                            learningModel.decline(candidate)
                        }
                    }
                }
            )
        }
        .accessibilityIdentifier("juno.desktop.memory-proposals")
    }

    // MARK: - Plumbing

    /// A sendable main-actor closure for child sections. The model is main-actor
    /// isolated, so constructing the handler here keeps that isolation at the
    /// boundary instead of converting a plain method reference at every row.
    private var updateHandler: @MainActor (NativeSettingsPatch) -> Void {
        let settingsModel = model
        return { patch in
            Task { @MainActor in
                await settingsModel.updateSettings(patch)
            }
        }
    }

    private var memoryBinding: Binding<Bool> {
        Binding(
            get: { model.settings?.memoryEnabled ?? true },
            set: { enabled in
                Task {
                    await model.updateSettings(NativeSettingsPatch(memoryEnabled: enabled))
                }
            }
        )
    }

    @MainActor
    private func update(_ patch: NativeSettingsPatch) {
        Task { await model.updateSettings(patch) }
    }

    /// The one transient thing on this screen, and therefore the one thing that
    /// floats: a conflict that needs a decision, or a save queued behind the
    /// network. The controls inside are plain — the capsule already carries the
    /// material.
    @ViewBuilder
    private var statusChrome: some View {
        if model.conflictedMutationCount > 0 {
            floatingStatus(
                icon: .refresh,
                message: "Memory or settings changed on another device."
            ) {
                Button("Keep mine") {
                    Task { await model.resolveConflicts(keepLocalChanges: true) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoAccent)
                .accessibilityIdentifier("juno.desktop.settings.keep-local")
                .contentShape(.rect)

                Button("Use server version") {
                    Task { await model.resolveConflicts(keepLocalChanges: false) }
                }
                .buttonStyle(.plain)
                .junoSecondaryInk()
                .accessibilityIdentifier("juno.desktop.settings.use-server")
                .contentShape(.rect)
            }
        } else if model.phase == .offline || model.phase == .failed,
            let message = model.lastErrorDescription
        {
            floatingStatus(
                icon: model.phase == .offline ? .connections : .error,
                message: DesktopStatusCopy(subject: "settings", singular: "setting")
                    .humanized(
                        message,
                        fallback: "Juno couldn't sync your settings."
                    )
            ) {
                Button("Retry") { Task { await model.refresh() } }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccent)
                    .accessibilityIdentifier("juno.desktop.settings.retry")
                    .contentShape(.rect)
            }
        }
    }

    private func floatingStatus<Actions: View>(
        icon: JunoIcon,
        message: String,
        @ViewBuilder actions: () -> Actions
    ) -> some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(icon, size: 15)
                    .junoSecondaryInk()
                    .accessibilityHidden(true)
                Text(message)
                    .junoRowLabel()
                    .lineLimit(2)
                actions()
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .junoFloatingChrome()
        }
        .padding(JunoSpace.roomy)
        .frame(maxWidth: JunoSettingsMetrics.readingWidth)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.settings.status")
    }
}

// MARK: - Form furniture

/// The grouped form every preference section is drawn in.
///
/// One place for the style, so the ten sections cannot drift: the platform's
/// grouped `Form`, its own scroll background hidden so the warm canvas shows
/// through, capped at the reading measure and centred.
struct DesktopSettingsForm<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        Form {
            content
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: JunoSettingsMetrics.readingWidth)
        .frame(maxWidth: .infinity)
    }
}

/// A section header: the secondary caption at 12pt, sentence case — the web's
/// `SettingsGroup` title.
struct DesktopSettingsHeader: View {
    private let title: LocalizedStringKey

    init(_ title: LocalizedStringKey) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .junoFont(size: 12, relativeTo: .caption, weight: .medium)
            .junoSecondaryInk()
            .textCase(nil)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A row's label: what it is, and one line of explanation — the *only* line of
/// explanation, so a footer never has to say it a second time.
struct DesktopSettingsLabel: View {
    private let title: LocalizedStringKey
    private let detail: LocalizedStringKey?
    private let tone: Tone

    enum Tone { case normal, destructive }

    init(_ title: LocalizedStringKey, detail: LocalizedStringKey? = nil, tone: Tone = .normal) {
        self.title = title
        self.detail = detail
        self.tone = tone
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(title)
                .junoRowLabel()
                .foregroundStyle(tone == .destructive ? Color.junoDanger : Color.junoForeground)
            if let detail {
                Text(detail)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The two package-owned panes this page hosts rather than restyles.
///
/// Both are shared with the iPhone, which renders the same `Form`. Presenting
/// them as sheets keeps that code untouched and keeps the settings page itself a
/// single scroll.
private enum DesktopSettingsSheet: String, Identifiable {
    case sharedLinks
    case diagnostics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sharedLinks: "Shared links"
        case .diagnostics: "Diagnostics"
        }
    }
}

/// A sheet with a title and one way out.
///
/// The frame is explicit on purpose: a presented surface that negotiates its own
/// size re-lays out the window underneath it as it appears, and this shell has
/// fallen into a constraint loop over exactly that.
private struct DesktopSettingsSheetHost<Content: View>: View {
    let sheet: DesktopSettingsSheet
    @ViewBuilder var content: Content

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(sheet.title)
                    .junoTitle()
                Spacer(minLength: JunoSpace.regular)
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.cozy)
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(
            width: DesktopSettingsMetrics.sheetWidth,
            height: DesktopSettingsMetrics.sheetHeight
        )
        // Sheet contract: this host is the root of every Settings sheet, so the
        // warm ground goes on once here rather than in each pane.
        .junoSheetSurface(.fitted)
    }
}

enum DesktopSettingsMetrics {
    /// The rail's width: the web's `md:w-56` (224px) less its gutter.
    static let railWidth: CGFloat = 216
    /// The signed-in account's photo in the Account section.
    static let avatarSize: CGFloat = 44
    /// A presented surface's size. Explicit — see ``DesktopSettingsSheetHost``.
    static let sheetWidth: CGFloat = 560
    static let sheetHeight: CGFloat = 520
    /// The narrow confirmation sheets: a paragraph and a field, nothing more.
    static let confirmWidth: CGFloat = 460
    /// A multi-line editor's floor: enough that a short paragraph is visible
    /// without scrolling.
    static let editorMinHeight: CGFloat = 132
    /// An accent swatch in the appearance row.
    static let swatchSize: CGFloat = 24
    /// A provider mark beside a model's name.
    static let providerMark: CGFloat = 20
}

/// A binding onto one field of the account's settings record.
///
/// The patch is only sent when the value actually changes: a `Picker` writes its
/// selection on every layout pass in some styles, and without this guard the
/// outbox filled with no-op mutations.
///
/// Every piece this captures is `Sendable`, because `Binding`'s accessors are
/// `@Sendable` in the macOS 26 SDK.
private func junoSettingsBinding<Value: Equatable & Sendable>(
    _ settings: NativeAccountSettings,
    _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
    update: @escaping @MainActor (NativeSettingsPatch) -> Void,
    patch: @escaping @Sendable (Value) -> NativeSettingsPatch
) -> Binding<Value> {
    Binding(
        get: { settings[keyPath: keyPath] },
        set: { value in
            guard value != settings[keyPath: keyPath] else { return }
            // SwiftUI drives a `Binding`'s setter on the main actor, but the
            // accessor itself is non-isolated `@Sendable` in the macOS 26 SDK,
            // so the isolation has to be re-stated rather than inferred.
            MainActor.assumeIsolated { update(patch(value)) }
        }
    )
}

/// Keeps a stored value the picker does not recognize selectable, so opening a
/// menu can never silently rewrite a preference this build has not shipped.
private func junoKnownOrCurrent(_ known: [String], current: String) -> [String] {
    known.contains(current) ? known : [current] + known
}

/// The two language lists and the voice list, mirrored from the website.
private enum DesktopSettingsCatalog {
    static let responseLanguages = [
        "auto", "English", "Spanish", "French", "German", "Portuguese",
        "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
    ]

    static let interfaceLocales = [
        "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
        "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
    ]

    /// `src/lib/voices.ts`, verbatim.
    static let voices: [(id: String, label: String, detail: String)] = [
        ("alloy", "Alloy", "Neutral and crisp"),
        ("echo", "Echo", "Even and measured"),
        ("fable", "Fable", "Bright and expressive"),
        ("onyx", "Onyx", "Low and steady"),
        ("nova", "Nova", "Rounded and friendly"),
        ("shimmer", "Shimmer", "Light and airy"),
        ("coral", "Coral", "Warm and lively"),
        ("verse", "Verse", "Animated and varied"),
        ("ballad", "Ballad", "Soft and unhurried"),
        ("ash", "Ash", "Firm and direct"),
        ("sage", "Sage", "Calm and level"),
        ("marin", "Marin", "Relaxed and conversational"),
        ("cedar", "Cedar", "Smooth and easy-going"),
    ]

    static let defaultVoice = "alloy"

    /// Each language names itself, as it does on the web — someone looking for
    /// their own language finds it written the way they write it, not translated
    /// into the one currently in force.
    static func localeLabel(_ locale: String) -> String {
        guard locale != "auto" else { return "Match system" }
        let identifier = Locale(identifier: locale)
        return identifier.localizedString(forIdentifier: locale)
            ?? Locale.current.localizedString(forIdentifier: locale)
            ?? locale
    }
}

// MARK: - General

/// Theme, accent, interface language, and which Juno this is.
private struct DesktopSettingsGeneralSections: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor (NativeSettingsPatch) -> Void
    let openDiagnostics: () -> Void

    @State private var updater = DesktopUpdateModel.shared

    private static let themes: [(value: NativeThemePreference, title: String, icon: JunoIcon)] = [
        (.system, "System", .monitor),
        (.light, "Light", .sun),
        (.dark, "Dark", .moon),
    ]

    var body: some View {
        Section {
            Picker(
                selection: junoSettingsBinding(settings, \.theme, update: update) {
                    NativeSettingsPatch(theme: $0)
                }
            ) {
                ForEach(Self.themes, id: \.value) { theme in
                    JunoIconLabel(verbatim: theme.title, icon: theme.icon, size: 13)
                        .tag(theme.value)
                }
            } label: {
                DesktopSettingsLabel("Theme", detail: "System follows this Mac's appearance.")
            }
            .disabled(disabled)
            .accessibilityLabel("Theme")
            .accessibilityIdentifier("juno.desktop.settings.theme")

            LabeledContent {
                HStack(spacing: JunoSpace.snug) {
                    ForEach(JunoAccent.allCases) { accent in
                        DesktopAccentSwatch(
                            accent: accent,
                            isSelected: JunoAccent(setting: settings.accent) == accent
                                && JunoAccent(rawValue: settings.accent.lowercased()) != nil,
                            isEnabled: !disabled,
                            select: { update(NativeSettingsPatch(accent: accent.rawValue)) }
                        )
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Accent color")
                .accessibilityIdentifier("juno.desktop.settings.accent")
            } label: {
                DesktopSettingsLabel(
                    "Accent color",
                    detail: JunoAccent(rawValue: settings.accent.lowercased()) == nil
                        ? "This account has a custom accent set on the web. Juno for Mac draws it as Coral; choosing one here replaces it."
                        : "The one saturated colour in the interface."
                )
            }
        } header: {
            DesktopSettingsHeader("Appearance")
        }

        Section {
            Picker(
                selection: junoSettingsBinding(settings, \.interfaceLocale, update: update) {
                    NativeSettingsPatch(interfaceLocale: $0)
                }
            ) {
                ForEach(
                    junoKnownOrCurrent(
                        DesktopSettingsCatalog.interfaceLocales,
                        current: settings.interfaceLocale
                    ),
                    id: \.self
                ) { locale in
                    Text(DesktopSettingsCatalog.localeLabel(locale)).tag(locale)
                }
            } label: {
                DesktopSettingsLabel(
                    "Interface language",
                    detail: "The language this app's buttons and menus are in."
                )
            }
            .disabled(disabled)
            .accessibilityLabel("Interface language")
            .accessibilityIdentifier("juno.desktop.settings.interface-language")
        } header: {
            DesktopSettingsHeader("Language")
        }

        Section {
            LabeledContent {
                Button(updateActionTitle) { updateAction() }
                    .disabled(!updateActionEnabled)
                    .accessibilityIdentifier("juno.desktop.settings.check-updates")
            } label: {
                DesktopSettingsLabel(
                    "Juno for Mac \(JunoBuildInfo.current.displayVersion)",
                    detail: LocalizedStringKey(updateStatus)
                )
            }
            LabeledContent {
                Button("Diagnostics…", action: openDiagnostics)
                    .accessibilityIdentifier("juno.desktop.settings.diagnostics")
            } label: {
                DesktopSettingsLabel(
                    "Diagnostics",
                    detail: "Channel \(JunoBuildInfo.current.channel) · contract \(JunoBuildInfo.current.contractVersion)"
                )
            }
        } header: {
            DesktopSettingsHeader("About")
        }
    }

    private var updateStatus: String {
        switch updater.phase {
        case .idle: "Updates are checked every ten minutes while Juno is open."
        case .checking: "Checking for updates…"
        case .current: "Up to date."
        case .downloading(let version, let fraction):
            if let fraction {
                "Downloading \(version) — \(Int((fraction * 100).rounded()))%"
            } else {
                "Downloading \(version)…"
            }
        case .ready(let version): "Juno \(version) is ready to install."
        case .failed(let message): message
        case .unsupported(let reason): reason
        }
    }

    private var updateActionTitle: String {
        if case .ready = updater.phase { return "Install and relaunch" }
        return "Check for updates"
    }

    private var updateActionEnabled: Bool {
        switch updater.phase {
        case .checking, .downloading, .unsupported: false
        default: true
        }
    }

    private func updateAction() {
        if case .ready = updater.phase {
            updater.installAndRelaunch()
        } else {
            updater.checkNow()
        }
    }
}

/// One accent, as the colour itself.
private struct DesktopAccentSwatch: View {
    let accent: JunoAccent
    let isSelected: Bool
    let isEnabled: Bool
    let select: () -> Void

    @State private var isHovering = false

    /// One ring, three strengths: full for the chosen accent, faint under the
    /// pointer, absent at rest.
    private var ringStrength: Double {
        if isSelected { return 0.85 }
        return isHovering && isEnabled ? 0.3 : 0
    }

    var body: some View {
        Button(action: select) {
            Circle()
                .fill(accent.color)
                .frame(
                    width: DesktopSettingsMetrics.swatchSize,
                    height: DesktopSettingsMetrics.swatchSize
                )
                .overlay {
                    if isSelected {
                        JunoIconView(.check, size: 12)
                            .foregroundStyle(accent.onAccent)
                    }
                }
                .overlay {
                    Circle()
                        .strokeBorder(Color.junoForeground.opacity(ringStrength), lineWidth: 2)
                        .padding(-3)
                }
                .animation(JunoMotion.fast, value: isHovering)
                .contentShape(Circle())
        }
        .buttonStyle(.junoPress)
        .disabled(!isEnabled)
        .onHover { isHovering = $0 }
        .help(accent.displayName)
        .accessibilityLabel(accent.displayName)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Personalization

/// How Juno writes: the response style, the standing instructions, the
/// language it replies in.
private struct DesktopSettingsPersonalizationSections: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor (NativeSettingsPatch) -> Void

    @State private var draft = ""
    /// What the field was last handed by the account record. Compared against the
    /// draft to tell "untouched" from "half-written", so a settings push landing
    /// mid-sentence cannot erase what is being typed.
    @State private var baseline: String?

    private var currentStyle: JunoResponseStyle? {
        JunoResponseStyle.named(settings.personality)
    }

    var body: some View {
        Section {
            Picker(
                selection: junoSettingsBinding(settings, \.personality, update: update) {
                    NativeSettingsPatch(personality: $0)
                }
            ) {
                // A preset this build has never heard of stays named and
                // selected, so a style chosen on the web after this app shipped
                // is not silently demoted the moment settings are opened.
                if currentStyle == nil {
                    Text(settings.personality).tag(settings.personality)
                }
                ForEach(JunoResponseStyle.all) { style in
                    Text(style.localizedLabel).tag(style.id)
                }
            } label: {
                DesktopSettingsLabel(
                    "Response style",
                    detail: currentStyle.map { LocalizedStringKey($0.detail) }
                        ?? "A style Juno for Mac does not ship. Choosing one replaces it."
                )
            }
            .disabled(disabled)
            .accessibilityLabel("Response style")
            .accessibilityIdentifier("juno.desktop.settings.personality")

            Picker(
                selection: junoSettingsBinding(settings, \.responseLanguage, update: update) {
                    NativeSettingsPatch(responseLanguage: $0)
                }
            ) {
                ForEach(
                    junoKnownOrCurrent(
                        DesktopSettingsCatalog.responseLanguages,
                        current: settings.responseLanguage
                    ),
                    id: \.self
                ) { language in
                    Text(language == "auto" ? "Auto-detect" : language).tag(language)
                }
            } label: {
                DesktopSettingsLabel("Response language", detail: "The language Juno replies in.")
            }
            .disabled(disabled)
            .accessibilityLabel("Response language")
            .accessibilityIdentifier("juno.desktop.settings.response-language")
        } header: {
            DesktopSettingsHeader("How Juno writes")
        }

        Section {
            TextEditor(text: $draft)
                .junoBody()
                .junoInk()
                .frame(minHeight: DesktopSettingsMetrics.editorMinHeight)
                .scrollContentBackground(.hidden)
                .accessibilityLabel("Custom instructions")
                .accessibilityIdentifier("juno.desktop.settings.instructions")

            HStack(spacing: JunoSpace.snug) {
                Text("\(draft.count.formatted()) chars")
                    .junoCodeSmall()
                    .junoMetaInk()
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
                Button("Revert") { draft = settings.customInstructions }
                    .disabled(draft == settings.customInstructions)
                    .contentShape(.rect)
                Button("Save") {
                    update(NativeSettingsPatch(customInstructions: draft))
                }
                .keyboardShortcut("s", modifiers: .command)
                .help("Save your custom instructions (⌘S)")
                .disabled(disabled || draft == settings.customInstructions)
                .accessibilityIdentifier("juno.desktop.settings.save-instructions")
                .contentShape(.rect)
            }
        } header: {
            DesktopSettingsHeader("Custom instructions")
        } footer: {
            Text("Juno keeps these in mind in every conversation on this account. Your response style still applies underneath them.")
                .junoCaption()
        }
        .task(id: settings.customInstructions) {
            let stored = settings.customInstructions
            if draft == (baseline ?? "") {
                draft = stored
            }
            baseline = stored
        }
    }
}

// MARK: - Models

/// The account's default model, chosen in the app's own catalog browser, and
/// the favourites pinned to the top of the composer's menu.
private struct DesktopSettingsModelSections: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: @MainActor (NativeSettingsPatch) -> Void

    @State private var isPresented = false

    private var descriptors: [JunoModelDescriptor] {
        modelCatalog.map(\.junoDescriptor)
    }

    private var selected: JunoModelDescriptor? {
        descriptors.first { $0.id == settings.defaultModel }
    }

    /// In the account's own order, not the catalog's — the order is the reader's
    /// ranking and reshuffling it on every render would erase that.
    private var favorites: [NativeChatModelOption] {
        settings.favoriteModels.compactMap { id in
            modelCatalog.first { $0.id == id }
        }
    }

    /// Provider name → its models, in catalog order, minus what is already
    /// favourited. Grouped because a flat menu of sixty is a scroll, not a choice.
    private var addable: [(provider: String, models: [NativeChatModelOption])] {
        let remaining = modelCatalog.filter { !settings.favoriteModels.contains($0.id) }
        var order: [String] = []
        var grouped: [String: [NativeChatModelOption]] = [:]
        for option in remaining {
            if grouped[option.providerName] == nil { order.append(option.providerName) }
            grouped[option.providerName, default: []].append(option)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        Section {
            LabeledContent {
                if modelCatalog.isEmpty {
                    Text(junoDisplayModelName(settings.defaultModel))
                        .junoRowLabel()
                        .junoSecondaryInk()
                } else {
                    modelTrigger
                }
            } label: {
                DesktopSettingsLabel(
                    "Default model",
                    detail: modelCatalog.isEmpty
                        ? "Juno is still loading your model catalog."
                        : "New chats start here. Any chat can still be moved to another model from the composer."
                )
            }
        } header: {
            DesktopSettingsHeader("Defaults")
        }

        if !modelCatalog.isEmpty {
            Section {
                if favorites.isEmpty {
                    Text("None yet — the menu shows the whole catalog until you pin something.")
                        .junoCaption()
                } else {
                    ForEach(favorites) { option in
                        LabeledContent {
                            Button {
                                setFavorite(option.id, false)
                            } label: {
                                JunoIconView(.close, size: 12)
                                    .junoMetaInk()
                                    .frame(width: 24, height: 24)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .disabled(disabled)
                            .help("Remove \(option.displayName) from favorites")
                            .accessibilityLabel("Remove \(option.displayName) from favorites")
                        } label: {
                            HStack(spacing: JunoSpace.cozy) {
                                JunoProviderMark(
                                    providerID: option.providerID,
                                    providerName: option.providerName,
                                    size: DesktopSettingsMetrics.providerMark
                                )
                                DesktopSettingsLabel(
                                    LocalizedStringKey(option.displayName),
                                    detail: LocalizedStringKey(option.providerName)
                                )
                            }
                        }
                    }
                    .accessibilityIdentifier("juno.desktop.settings.favorite-models")
                }

                if !addable.isEmpty {
                    Menu("Add a favorite…") {
                        ForEach(addable, id: \.provider) { group in
                            Menu(group.provider) {
                                ForEach(group.models) { option in
                                    Button(option.displayName) { setFavorite(option.id, true) }
                                }
                            }
                        }
                    }
                    .fixedSize()
                    .disabled(disabled)
                    .accessibilityIdentifier("juno.desktop.settings.add-favorite")
                    .contentShape(.rect)
                }
            } header: {
                DesktopSettingsHeader("Favorites")
            } footer: {
                Text("Favorites sit at the top of the composer's model menu, ahead of the full catalog.")
                    .junoCaption()
            }
        }
    }

    private var modelTrigger: some View {
        Button {
            isPresented = true
        } label: {
            HStack(spacing: JunoSpace.snug) {
                JunoProviderMark(
                    providerID: selected?.providerID ?? "juno",
                    providerName: selected?.providerName ?? "Juno",
                    size: DesktopSettingsMetrics.providerMark
                )
                Text(selected?.displayName ?? junoDisplayModelName(settings.defaultModel))
                    .junoRowLabel()
                    .junoInk()
                    .lineLimit(1)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        }
        .buttonStyle(.bordered)
        .disabled(disabled)
        .accessibilityLabel("Default model")
        .accessibilityValue(selected?.displayName ?? settings.defaultModel)
        .accessibilityIdentifier("juno.desktop.settings.default-model")
        // Dismissed with its anchor, always. A `.popover` whose anchor leaves
        // the hierarchy while it is presented makes SwiftUI re-run
        // `showRelativeToRect:` against a window already being ordered, and the
        // process takes SIGTRAP.
        .onDisappear { isPresented = false }
        .popover(
            isPresented: $isPresented,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .bottom
        ) {
            // Explicit frame, twice over: the selector sizes itself and the
            // popover is told the same numbers. A self-sizing popover over a
            // split view has crashed this app before.
            JunoModelSelector(
                models: descriptors,
                selectedModelID: settings.defaultModel,
                select: { descriptor in
                    isPresented = false
                    guard descriptor.id != settings.defaultModel else { return }
                    update(NativeSettingsPatch(defaultModel: descriptor.id))
                }
            )
            .frame(
                width: JunoModelSelectorMetrics.standard.width,
                height: JunoModelSelectorMetrics.standard.height
            )
        }
    }

    private func setFavorite(_ modelID: String, _ isFavorite: Bool) {
        var favorites = settings.favoriteModels
        if isFavorite {
            guard !favorites.contains(modelID) else { return }
            favorites.append(modelID)
        } else {
            guard favorites.contains(modelID) else { return }
            favorites.removeAll { $0 == modelID }
        }
        update(NativeSettingsPatch(favoriteModels: favorites))
    }
}

// MARK: - Voice

/// The voice Juno reads answers in — the web's list, as a picker.
private struct DesktopSettingsVoiceSections: View {
    let settings: NativeAccountSettings
    let disabled: Bool
    let update: @MainActor (NativeSettingsPatch) -> Void

    private var current: String {
        settings.voiceID ?? DesktopSettingsCatalog.defaultVoice
    }

    private var currentDetail: String {
        DesktopSettingsCatalog.voices.first { $0.id == current }?.detail
            ?? "A voice Juno for Mac does not list. Choosing one replaces it."
    }

    var body: some View {
        Section {
            Picker(
                selection: Binding(
                    get: { current },
                    set: { id in
                        guard id != current else { return }
                        update(NativeSettingsPatch(voiceID: .some(id)))
                    }
                )
            ) {
                if !DesktopSettingsCatalog.voices.contains(where: { $0.id == current }) {
                    Text(current).tag(current)
                }
                ForEach(DesktopSettingsCatalog.voices, id: \.id) { voice in
                    Text(voice.label).tag(voice.id)
                }
            } label: {
                DesktopSettingsLabel("Voice", detail: LocalizedStringKey(currentDetail))
            }
            .disabled(disabled)
            .accessibilityLabel("Read-aloud voice")
            .accessibilityIdentifier("juno.desktop.settings.voice")
        } header: {
            DesktopSettingsHeader("Read aloud")
        } footer: {
            Text("The same voice on every device signed into this account. Dictation uses this Mac's own speech recognition and needs no setting.")
                .junoCaption()
        }
    }
}

// MARK: - Data & privacy

/// Everything Juno holds for you, in a format you can take elsewhere — and the
/// links you have handed out.
private struct DesktopSettingsDataSections: View {
    let session: NativeAuthenticatedSession
    let accountDataClient: NativeAccountDataClient?
    let showsSharedLinks: Bool
    let openSharedLinks: () -> Void
    let openDiagnostics: () -> Void

    @State private var isExporting = false
    @State private var exportDocument: DesktopSettingsExportDocument?
    @State private var exportContentType: UTType = .json
    @State private var exportFilename = ""
    @State private var showingExporter = false
    @State private var exportError: String?

    var body: some View {
        Section {
            if accountDataClient != nil {
                LabeledContent {
                    HStack(spacing: JunoSpace.snug) {
                        if isExporting {
                            ProgressView().controlSize(.small)
                        }
                        Button("JSON…") { export(.json) }
                            .disabled(isExporting)
                            .accessibilityIdentifier("juno.desktop.settings.export-json")
                            // Attached to the control that starts it rather than
                            // to the section: two presentations on one view is
                            // where SwiftUI drops one.
                            .fileExporter(
                                isPresented: $showingExporter,
                                document: exportDocument,
                                contentType: exportContentType,
                                defaultFilename: exportFilename
                            ) { result in
                                if case .failure(let error) = result {
                                    exportError = error.localizedDescription
                                }
                                exportDocument = nil
                            }
                        Button("CSV…") { export(.csv) }
                            .disabled(isExporting)
                            .accessibilityIdentifier("juno.desktop.settings.export-csv")
                    }
                } label: {
                    DesktopSettingsLabel(
                        "Export your data",
                        detail: "Every conversation, project, file and memory on this account."
                    )
                }
                if let exportError {
                    JunoIconLabel(verbatim: exportError, icon: .error, size: 13)
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Export is unavailable on this Mac.")
                    .junoCaption()
            }
        } header: {
            DesktopSettingsHeader("Your data")
        }

        if showsSharedLinks {
            Section {
                LabeledContent {
                    Button("Manage…", action: openSharedLinks)
                        .accessibilityIdentifier("juno.desktop.settings.shared-links")
                } label: {
                    DesktopSettingsLabel(
                        "Shared links",
                        detail: "What you have made public, and how to take it back."
                    )
                }
            } header: {
                DesktopSettingsHeader("Sharing")
            }
        }

        Section {
            LabeledContent {
                Button("Open…", action: openDiagnostics)
            } label: {
                DesktopSettingsLabel(
                    "Diagnostics",
                    detail: "What this Mac has synced, what is queued, and what failed."
                )
            }
        } header: {
            DesktopSettingsHeader("On this Mac")
        }
    }

    /// Downloads the export, then hands it to `.fileExporter`.
    ///
    /// Two steps rather than one because the file does not exist until the
    /// request comes back: a save panel opened first would be asking where to
    /// put something Juno might fail to fetch.
    private func export(_ format: NativeAccountDataClient.ExportFormat) {
        guard let accountDataClient else { return }
        isExporting = true
        exportError = nil
        Task {
            defer { isExporting = false }
            do {
                let url = try await accountDataClient.export(
                    format: format,
                    for: session.profile.id
                )
                let data = try Data(contentsOf: url)
                try? FileManager.default.removeItem(at: url)
                exportDocument = DesktopSettingsExportDocument(data: data)
                exportContentType = format == .csv ? .commaSeparatedText : .json
                // Stem only: the save panel appends the extension for the
                // content type.
                exportFilename = URL(fileURLWithPath: format.fileName(on: Date()))
                    .deletingPathExtension()
                    .lastPathComponent
                showingExporter = true
            } catch {
                exportError = error.localizedDescription
            }
        }
    }
}

// MARK: - Account

/// Who you are to Juno, how you leave, what it may email you, and the one
/// thing that cannot be undone.
private struct DesktopSettingsAccountSections: View {
    let settings: NativeAccountSettings
    let session: NativeAuthenticatedSession
    let avatarData: Data?
    let authModel: NativeAuthModel
    let accountDataClient: NativeAccountDataClient?
    let disabled: Bool
    let update: @MainActor (NativeSettingsPatch) -> Void

    @State private var showingSignOut = false
    @State private var showingDelete = false
    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var deleteError: String?

    var body: some View {
        Section {
            HStack(spacing: JunoSpace.regular) {
                JunoAvatar(
                    imageData: avatarData,
                    imageURL: session.profile.imageURL,
                    name: session.profile.name ?? session.profile.email,
                    size: DesktopSettingsMetrics.avatarSize
                )
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(session.profile.name ?? "Juno account")
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .junoInk()
                    Text(session.profile.email)
                        .junoCaption()
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, JunoSpace.hairline)
        } header: {
            DesktopSettingsHeader("Profile")
        } footer: {
            Text("Your name and photo are changed on the web, and follow you here.")
                .junoCaption()
        }

        Section {
            LabeledContent {
                Button("Sign out…") { showingSignOut = true }
                    .accessibilityIdentifier("juno.desktop.settings.sign-out")
                    .confirmationDialog("Sign out of Juno?", isPresented: $showingSignOut) {
                        Button("Sign out", role: .destructive) {
                            Task { await authModel.signOut() }
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Juno removes this Mac's local copy of your conversations and settings. Nothing is deleted on the server.")
                    }
            } label: {
                DesktopSettingsLabel(
                    "This Mac",
                    detail: "Signed in as \(session.profile.email)."
                )
            }
        } header: {
            DesktopSettingsHeader("Sign-in")
        }

        Section {
            Toggle(
                isOn: junoSettingsBinding(settings, \.emailBudgetAlerts, update: update) {
                    NativeSettingsPatch(emailBudgetAlerts: $0)
                }
            ) {
                DesktopSettingsLabel("Budget alerts", detail: "Email me at 80% of my monthly budget.")
            }
            .toggleStyle(.switch)
            .tint(Color.junoAccent)
            .disabled(disabled)
            .accessibilityLabel("Budget alerts")
            .accessibilityIdentifier("juno.desktop.settings.budget-alerts")

            Toggle(
                isOn: junoSettingsBinding(settings, \.emailWeeklyDigest, update: update) {
                    NativeSettingsPatch(emailWeeklyDigest: $0)
                }
            ) {
                DesktopSettingsLabel("Weekly digest", detail: "Usage recap every Monday.")
            }
            .toggleStyle(.switch)
            .tint(Color.junoAccent)
            .disabled(disabled)
            .accessibilityLabel("Weekly digest")
            .accessibilityIdentifier("juno.desktop.settings.weekly-digest")
        } header: {
            DesktopSettingsHeader("Email notifications")
        }

        Section {
            LabeledContent {
                if accountDataClient == nil {
                    Text("Unavailable on this Mac")
                        .junoCaption()
                } else {
                    Button("Delete account…", role: .destructive) {
                        confirmation = ""
                        deleteError = nil
                        showingDelete = true
                    }
                    .disabled(isDeleting)
                    .accessibilityIdentifier("juno.desktop.settings.delete-account")
                    .sheet(isPresented: $showingDelete) { confirmSheet }
                }
            } label: {
                DesktopSettingsLabel(
                    "Delete account",
                    detail: "Permanently removes your account, conversations, projects, files and memories — everywhere, not just on this Mac.",
                    tone: .destructive
                )
            }
        } header: {
            DesktopSettingsHeader("Danger zone")
        } footer: {
            Text("Irreversible. There is no undo and no grace period.")
                .junoCaption()
        }
    }

    private var confirmSheet: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Delete your account?")
                .junoEmptyTitle()
            Text("This permanently deletes every conversation, project, file and memory on this account. It cannot be undone.")
                .junoBody()
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            Text("Type \(session.profile.email) to confirm.")
                .junoCaption()
            TextField("Email", text: $confirmation)
                .accessibilityLabel("Confirm your email address")
                .accessibilityIdentifier("juno.desktop.settings.delete-confirm")
            if let deleteError {
                JunoIconLabel(verbatim: deleteError, icon: .error, size: 13)
                    .junoCaption()
                    .foregroundStyle(Color.junoCaution)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { showingDelete = false }
                    .keyboardShortcut(.cancelAction)
                    .contentShape(.rect)
                if isDeleting {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Delete account", role: .destructive, action: deleteAccount)
                        .disabled(!confirmationMatches)
                        .contentShape(.rect)
                }
            }
        }
        .padding(JunoSpace.roomy)
        // An explicit width. A presented surface that negotiates its own width
        // re-lays out the window underneath it while it appears.
        .frame(width: DesktopSettingsMetrics.confirmWidth)
        .junoSheetSurface(.fitted)
    }

    /// The same comparison the server makes, so the button is dead until the
    /// confirmation is right rather than live and then refused —
    /// `/api/account/delete` allows three attempts an hour.
    private var confirmationMatches: Bool {
        !session.profile.email.isEmpty
            && confirmation
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(session.profile.email) == .orderedSame
    }

    private func deleteAccount() {
        guard let accountDataClient else { return }
        isDeleting = true
        deleteError = nil
        Task {
            defer { isDeleting = false }
            do {
                try await accountDataClient.deleteAccount(
                    confirmEmail: confirmation,
                    accountEmail: session.profile.email,
                    for: session.profile.id
                )
                showingDelete = false
                // The account is gone; the local mirror has to go too, and
                // signing out is what tears down every model holding a copy.
                await authModel.signOut()
            } catch {
                deleteError = error.localizedDescription
            }
        }
    }
}

// MARK: - Export document

/// A snapshot on its way to a file the reader chooses — the account export from
/// the server, or the memory export written locally.
///
/// Write-only: reading one back into the app is not a thing Juno does, so the
/// read initializer refuses rather than pretending to import.
struct DesktopSettingsExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .commaSeparatedText] }

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
