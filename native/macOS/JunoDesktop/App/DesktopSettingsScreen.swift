import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// **Settings**, as a Mac settings window rather than one long scroll.
///
/// The previous build was a single `Form` inside a `ScrollView` holding
/// Appearance, response preferences, memory and the account one after another —
/// every group visible at once, none of them findable. A Mac settings surface is
/// a small number of named panes, and the platform has a component for that, so
/// the six groups are `Tab`s in a `TabView` styled `.tabBarOnly`.
///
/// Three constraints shaped the rest:
///
/// - **It has to stand alone.** This view is also hosted in a `Settings` scene
///   at 520×460, where there is no workspace sidebar, no window toolbar of ours
///   and far less width. Nothing here reads the shell: each pane is a
///   self-contained grouped `Form` with its own reading width, so the same code
///   is correct at 520pt and at 1240pt.
/// - **No pane may report an ideal height.** A grouped `Form` is a scroll view,
///   and a scroll view propagates its content's ideal height rather than
///   clamping it — which is how a detail surface ends up resizing the window's
///   split view instead of being scrolled. Every pane therefore goes through
///   ``DesktopSettingsClamp``. See the comment there.
/// - **Every control is backed by a real call.** Theme, accent, default model,
///   favourites, response style, both languages, custom instructions and the two
///   email switches all go through `NativeMemorySettingsModel.updateSettings`.
///   Memory rows are the account's real memories with a real delete. Usage is
///   read from `/api/profile/usage` — the JSON mirror of the web's bootstrap —
///   and shows nothing at all if that request has not come back.
struct DesktopSettingsScreen: View {
    /// The panes, in the order the tab bar shows them.
    enum Pane: String, CaseIterable, Identifiable, Hashable {
        case general
        case appearance
        case memory
        /// Live public links. Beside Memory because both answer "what does the
        /// world already have of mine?", which is the question a settings screen
        /// exists to let someone act on.
        case sharedLinks
        case account
        case usage
        case diagnostics

        var id: String { rawValue }

        var label: String {
            switch self {
            case .general: "General"
            case .appearance: "Appearance"
            case .memory: "Memory"
            case .sharedLinks: "Shared links"
            case .account: "Account"
            case .usage: "Usage"
            case .diagnostics: "Diagnostics"
            }
        }

        var symbol: String {
            switch self {
            case .general: "gearshape"
            case .appearance: "paintpalette"
            case .memory: "brain"
            case .sharedLinks: "link"
            case .account: "person.crop.circle"
            case .usage: "chart.bar"
            case .diagnostics: "stethoscope"
            }
        }
    }

    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let accountDataClient: NativeAccountDataClient?
    /// Lists and revokes the account's public links.
    let shareClient: NativeShareClient?
    /// The account's model catalog, for the default-model and favourites
    /// controls. Empty until the signed-in manifest arrives, and those two
    /// sections are absent until it does rather than offering an empty menu.
    var modelCatalog: [NativeChatModelOption] = []
    /// The account photo's bytes, already fetched through the authenticated file
    /// route by `NativeAvatarModel`.
    var avatarData: Data?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    /// Backs the Usage pane. Nil where the app could not be composed, in which
    /// case that pane says so instead of showing meters with no numbers behind
    /// them.
    var requestSender: (any NativeAuthenticatedRequestSending)?

    @SceneStorage("juno.desktop.settings.pane") private var storedPane = Pane.general.rawValue
    /// Loaded once for the whole screen: the Usage pane draws the meters and the
    /// Account pane states the plan, and two fetches of the same route would be
    /// two answers to "what plan is this".
    @State private var usage: DesktopUsageSnapshot?
    @State private var usageError: String?
    @State private var isLoadingUsage = false

    private var pane: Binding<Pane> {
        Binding(
            get: { Pane(rawValue: storedPane) ?? .general },
            set: { storedPane = $0.rawValue }
        )
    }

    var body: some View {
        TabView(selection: pane) {
            Tab(Pane.general.label, systemImage: Pane.general.symbol, value: Pane.general) {
                DesktopSettingsGeneralPane(
                    settings: model.settings,
                    modelCatalog: modelCatalog,
                    disabled: model.isMutating,
                    unavailableMessage: settingsUnavailableMessage,
                    retry: { Task { await model.refresh() } },
                    update: update
                )
            }

            Tab(Pane.appearance.label, systemImage: Pane.appearance.symbol, value: Pane.appearance) {
                DesktopSettingsAppearancePane(
                    settings: model.settings,
                    disabled: model.isMutating,
                    unavailableMessage: settingsUnavailableMessage,
                    retry: { Task { await model.refresh() } },
                    update: update
                )
            }

            Tab(Pane.memory.label, systemImage: Pane.memory.symbol, value: Pane.memory) {
                DesktopSettingsMemoryPane(model: model)
            }

            Tab(Pane.sharedLinks.label, systemImage: Pane.sharedLinks.symbol, value: Pane.sharedLinks) {
                NativeSharedLinksView(client: shareClient, accountID: session.profile.id)
            }

            Tab(Pane.account.label, systemImage: Pane.account.symbol, value: Pane.account) {
                DesktopSettingsAccountPane(
                    authModel: authModel,
                    session: session,
                    avatarData: avatarData,
                    accountDataClient: accountDataClient,
                    usage: usage
                )
            }

            Tab(Pane.usage.label, systemImage: Pane.usage.symbol, value: Pane.usage) {
                DesktopSettingsUsagePane(
                    usage: usage,
                    errorDescription: usageError,
                    isLoading: isLoadingUsage,
                    isConfigured: requestSender != nil,
                    reload: { Task { await loadUsage() } }
                )
            }

            Tab(
                Pane.diagnostics.label,
                systemImage: Pane.diagnostics.symbol,
                value: Pane.diagnostics
            ) {
                // The shared pane, not a second copy of it. The whole value of
                // Diagnostics is that the Mac, the phone and the server report
                // the same facts in the same words — build, contract, server,
                // channel, sync phase, cursor and the outbox counts.
                DesktopSettingsClamp {
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
        .tabViewStyle(.tabBarOnly)
        .navigationTitle("Settings")
        .overlay(alignment: .bottom) { statusChrome }
        .task { await loadUsage() }
        .accessibilityIdentifier("juno.desktop.settings")
    }

    /// Why a settings pane has no controls yet, in the model's own words. Nil
    /// once the account's settings record has arrived.
    private var settingsUnavailableMessage: String? {
        guard model.settings == nil else { return nil }
        switch model.phase {
        case .idle, .loading:
            return "Loading your account settings…"
        case .offline:
            return DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(
                    model.lastErrorDescription,
                    fallback: "Offline — your settings will appear once Juno reconnects."
                )
        case .failed:
            return DesktopStatusCopy(subject: "settings", singular: "setting")
                .humanized(
                    model.lastErrorDescription,
                    fallback: "Juno could not load your settings."
                )
        case .ready:
            return "Account settings have not finished synchronizing."
        }
    }

    private func update(_ patch: NativeSettingsPatch) {
        Task { await model.updateSettings(patch) }
    }

    /// The one transient thing on this screen, and therefore the one thing that
    /// floats: a conflict that needs a decision, or a save that is queued behind
    /// the network. The controls inside it are plain — the capsule already
    /// carries the material.
    @ViewBuilder
    private var statusChrome: some View {
        if model.conflictedMutationCount > 0 {
            floatingStatus(
                symbol: "exclamationmark.arrow.triangle.2.circlepath",
                message: "Memory or settings changed on another device."
            ) {
                Button("Keep mine") {
                    Task { await model.resolveConflicts(keepLocalChanges: true) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoAccent)
                .accessibilityIdentifier("juno.desktop.settings.keep-local")

                Button("Use server version") {
                    Task { await model.resolveConflicts(keepLocalChanges: false) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("juno.desktop.settings.use-server")
            }
        } else if model.phase == .offline || model.phase == .failed,
            let message = model.lastErrorDescription
        {
            floatingStatus(
                symbol: model.phase == .offline ? "wifi.slash" : "exclamationmark.circle",
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
            }
        }
    }

    private func floatingStatus<Actions: View>(
        symbol: String,
        message: String,
        @ViewBuilder actions: () -> Actions
    ) -> some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: symbol)
                    .foregroundStyle(.secondary)
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
        .frame(maxWidth: DesktopSettingsMetrics.readingWidth)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.settings.status")
    }

    /// Reads the plan, the rolling windows and the billing period from the same
    /// route the website's own meters are built from.
    private func loadUsage() async {
        guard let requestSender, !isLoadingUsage else { return }
        isLoadingUsage = true
        defer { isLoadingUsage = false }
        do {
            let response = try await requestSender.send(
                try NativeBearerRequest(
                    path: "/api/profile/usage",
                    headers: try HTTPHeaders(["accept": "application/json"])
                ),
                for: session.profile.id
            )
            guard (200...299).contains(response.statusCode) else {
                let object = try? JSONSerialization.jsonObject(with: response.body)
                    as? [String: Any]
                throw DesktopUsageError.server(
                    message: (object?["error"] as? String)
                        ?? "Juno could not load your usage (\(response.statusCode))."
                )
            }
            let wire = try JSONDecoder().decode(DesktopUsageWire.self, from: response.body)
            usage = DesktopUsageSnapshot(wire)
            usageError = nil
        } catch {
            // The previous snapshot is dropped on purpose: a stale plan and a
            // stale percentage beside a fresh error message is the combination
            // that makes a reader trust the number.
            usage = nil
            usageError = error.localizedDescription
        }
    }
}

// MARK: - Shared pane furniture

private enum DesktopSettingsMetrics {
    /// The width a grouped form stays readable at. System Settings' detail pane
    /// is about this wide; a settings row stretched across a 1240pt window puts
    /// its label and its control at opposite ends of the screen.
    static let readingWidth: CGFloat = 720
    /// An embedded list inside a form section — the Login Items idiom.
    static let embeddedListHeight: CGFloat = 210
    /// A multi-line editor's floor: enough that a short paragraph is visible
    /// without scrolling, small enough to fit the 460pt settings window.
    static let editorMinHeight: CGFloat = 120
    /// A presented surface's width. Explicit, because a sheet that negotiates
    /// its own width re-lays out the window underneath it as it appears.
    static let sheetWidth: CGFloat = 460
    /// The signed-in account's photo in the Account pane.
    static let avatarSize: CGFloat = 48
    /// An accent swatch beside its name in the accent picker.
    static let swatchSize: CGFloat = JunoSpace.cozy
}

/// Bounds a settings pane to the space it was given, and to nothing more.
///
/// **This is what stops a pane from resizing the window.** `NavigationSplitView`
/// asks its detail for an ideal size and grows its AppKit split view to satisfy
/// it, and the `Settings` scene sizes its window the same way — so a pane that
/// reports the full height of its content does not get scrolled, it *resizes the
/// window*. A grouped `Form` is a scroll view and a scroll view propagates its
/// content's ideal height rather than clamping it; `.frame(maxHeight: .infinity)`
/// and `.frame(idealHeight: 0)` were both measured and neither clamped either.
///
/// `Color.clear` has no intrinsic size and accepts whatever height it is
/// proposed, and an `.overlay` is sized *by its base* and never reports back. So
/// the pane fills its column exactly, overflow scrolls, and the six panes cannot
/// disagree with each other about how tall the settings window should be. Same
/// mechanism as `JunoDetailPage`, without its outer `ScrollView` — the `Form` is
/// already one, and nesting two would give the pane two scrollers.
private struct DesktopSettingsClamp<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Color.clear
            .overlay {
                content
                    .frame(maxWidth: DesktopSettingsMetrics.readingWidth)
                    .frame(maxWidth: .infinity)
            }
            .junoReadingCanvas()
    }
}

/// One settings pane: a grouped `Form` on Juno's own canvas.
///
/// `.scrollContentBackground(.hidden)` is what lets the warm canvas show through
/// behind the section boxes. Without it the form paints the system's own grey
/// over the canvas and the pane reads as a different app from the window it is
/// in.
private struct DesktopSettingsPane<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        DesktopSettingsClamp {
            Form { content }
                .formStyle(.grouped)
                .scrollContentBackground(.hidden)
        }
    }
}

/// Why the controls are missing, with the model's retry attached.
private struct DesktopSettingsUnavailable: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        Section {
            Label(message, systemImage: "clock.arrow.circlepath")
                .junoRowLabel()
                .foregroundStyle(.secondary)
            Button("Reload settings", action: retry)
                .accessibilityIdentifier("juno.desktop.settings.reload")
        }
    }
}

/// A toggle with the web's one-line explanation under it — the System Settings
/// idiom, and the only way two switches in a row read as different promises.
private struct DesktopSettingsToggle: View {
    let title: String
    let explanation: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(title)
                Text(explanation)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // The explanation is a hint, not part of the name: VoiceOver reads the
        // name on every focus and the hint only when the reader waits for it.
        .accessibilityLabel(title)
        .accessibilityHint(explanation)
    }
}

/// A binding onto one field of the account's settings record.
///
/// The patch is only sent when the value actually changes: a `Picker` writes its
/// selection on every layout pass in some styles, and without this guard the
/// outbox filled with no-op mutations.
/// Every piece this captures is `Sendable`, because `Binding`'s accessors are
/// `@Sendable` in the macOS 26 SDK. Without the constraints the four captures —
/// the key path, the metatype, and the two closures — are each rejected under
/// Swift 6. They read as warnings on some toolchains and as errors on the one CI
/// builds with, which is how this reached `main` looking clean.
private func junoSettingsBinding<Value: Equatable & Sendable>(
    _ settings: NativeAccountSettings,
    _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
    update: @escaping @MainActor @Sendable (NativeSettingsPatch) -> Void,
    patch: @escaping @Sendable (Value) -> NativeSettingsPatch
) -> Binding<Value> {
    Binding(
        get: { settings[keyPath: keyPath] },
        set: { value in
            guard value != settings[keyPath: keyPath] else { return }
            // SwiftUI drives a `Binding`'s setter on the main actor, but the
            // accessor itself is non-isolated `@Sendable` in the macOS 26 SDK,
            // so the isolation has to be re-stated rather than inferred.
            // `assumeIsolated` records that invariant instead of hiding it in a
            // `Task`, which would also make the write land a turn late — long
            // enough for a `Picker` to read back its old value and flicker.
            MainActor.assumeIsolated { update(patch(value)) }
        }
    )
}

/// Keeps a stored value the picker does not recognize selectable, so opening a
/// menu can never silently rewrite a preference this build has not shipped.
private func junoKnownOrCurrent(_ known: [String], current: String) -> [String] {
    known.contains(current) ? known : [current] + known
}

// MARK: - General

/// The response-style presets, mirrored from the website's single source of
/// truth (`src/lib/personalities.ts`).
///
/// Only the *id* travels — that is what the server turns into a system-prompt
/// section. The label and the sentence under it are how the choice is described,
/// and they are copied verbatim so a preset chosen on the web is recognisable
/// here rather than appearing as a bare capitalised word.
private struct DesktopResponseStyle: Identifiable, Hashable {
    let id: String
    let label: String
    let explanation: String

    static let all: [DesktopResponseStyle] = [
        DesktopResponseStyle(
            id: "default",
            label: "Default",
            explanation: "Juno's natural voice — warm, clear, and adapts to the question."
        ),
        DesktopResponseStyle(
            id: "concise",
            label: "Concise",
            explanation: "Answer first, no preamble. Expands only when the topic needs it."
        ),
        DesktopResponseStyle(
            id: "encouraging",
            label: "Encouraging",
            explanation: "Supportive and motivating, without sugar-coating the truth."
        ),
        DesktopResponseStyle(
            id: "socratic",
            label: "Socratic",
            explanation: "Leads with questions so you reach the answer yourself."
        ),
        DesktopResponseStyle(
            id: "formal",
            label: "Formal",
            explanation: "Professional register suited to work and formal writing."
        ),
        DesktopResponseStyle(
            id: "nerdy",
            label: "Nerdy",
            explanation: "Precise and detail-loving, with the mechanism behind the answer."
        ),
    ]

    static func named(_ id: String) -> DesktopResponseStyle? {
        all.first { $0.id == id }
    }
}

private struct DesktopSettingsGeneralPane: View {
    let settings: NativeAccountSettings?
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let unavailableMessage: String?
    let retry: () -> Void
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    @State private var instructionsDraft = ""
    /// What the field was last handed by the account record. Compared against the
    /// draft to tell "untouched" from "half-written", so a settings push landing
    /// mid-sentence cannot erase what is being typed.
    @State private var instructionsBaseline: String?

    private static let responseLanguages = [
        "auto", "English", "Spanish", "French", "German", "Portuguese",
        "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
    ]
    private static let interfaceLocales = [
        "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
        "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
    ]

    var body: some View {
        DesktopSettingsPane {
            if let settings {
                modelSection(settings)
                favoritesSection(settings)
                styleSection(settings)
                languageSection(settings)
                instructionsSection(settings)
                notificationsSection(settings)
            } else if let unavailableMessage {
                DesktopSettingsUnavailable(message: unavailableMessage, retry: retry)
            }
        }
        .task(id: settings?.customInstructions) {
            let stored = settings?.customInstructions ?? ""
            if instructionsDraft == (instructionsBaseline ?? "") {
                instructionsDraft = stored
            }
            instructionsBaseline = stored
        }
    }

    @ViewBuilder
    private func modelSection(_ settings: NativeAccountSettings) -> some View {
        if !modelCatalog.isEmpty {
            Section {
                Picker(
                    "Default model",
                    selection: junoSettingsBinding(
                        settings, \.defaultModel, update: update
                    ) { NativeSettingsPatch(defaultModel: $0) }
                ) {
                    if !modelCatalog.contains(where: { $0.id == settings.defaultModel }) {
                        Text(junoDisplayModelName(settings.defaultModel))
                            .tag(settings.defaultModel)
                    }
                    ForEach(modelCatalog) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
                .disabled(disabled)
                .accessibilityIdentifier("juno.desktop.settings.default-model")
            } header: {
                Text("Default model")
            } footer: {
                Text("New chats start with this model. You can change it per chat from the composer.")
            }
        }
    }

    /// Favourites drive the composer's model menu. This is the only place in the
    /// Mac app that can set them, which is why the pane carries the whole
    /// catalog rather than a link to somewhere else.
    @ViewBuilder
    private func favoritesSection(_ settings: NativeAccountSettings) -> some View {
        if !modelCatalog.isEmpty {
            Section {
                Table(modelCatalog) {
                    TableColumn("Favorite") { option in
                        Toggle("Favorite", isOn: favoriteBinding(settings, option.id))
                            .labelsHidden()
                            .disabled(disabled)
                            .accessibilityLabel("Favorite \(option.displayName)")
                    }
                    .width(58)
                    TableColumn("Model", value: \.displayName)
                    TableColumn("Provider", value: \.providerName)
                }
                .frame(height: DesktopSettingsMetrics.embeddedListHeight)
                .accessibilityIdentifier("juno.desktop.settings.favorite-models")
            } header: {
                Text("Favorite models")
            } footer: {
                Text("^[\(settings.favoriteModels.count) favorite](inflect: true) — these appear at the top of the model menu.")
            }
        }
    }

    private func styleSection(_ settings: NativeAccountSettings) -> some View {
        Section {
            Picker(
                "Response style",
                selection: junoSettingsBinding(
                    settings, \.personality, update: update
                ) { NativeSettingsPatch(personality: $0) }
            ) {
                // A preset this build has never heard of stays selectable, so
                // opening the menu cannot silently rewrite a style chosen on the
                // web after this app shipped.
                if DesktopResponseStyle.named(settings.personality) == nil {
                    Text(settings.personality.capitalized).tag(settings.personality)
                }
                ForEach(DesktopResponseStyle.all) { style in
                    Text(style.label).tag(style.id)
                }
            }
            .disabled(disabled)
            .accessibilityIdentifier("juno.desktop.settings.personality")
        } header: {
            Text("Response style")
        } footer: {
            if let style = DesktopResponseStyle.named(settings.personality) {
                Text("\(style.explanation) Your custom instructions still take priority.")
            } else {
                Text("This account uses a response style Juno for Mac does not know. Choosing one here replaces it.")
            }
        }
    }

    private func languageSection(_ settings: NativeAccountSettings) -> some View {
        Section {
            Picker(
                "Responses",
                selection: junoSettingsBinding(
                    settings, \.responseLanguage, update: update
                ) { NativeSettingsPatch(responseLanguage: $0) }
            ) {
                ForEach(
                    junoKnownOrCurrent(
                        Self.responseLanguages, current: settings.responseLanguage
                    ),
                    id: \.self
                ) { language in
                    Text(language == "auto" ? "Auto-detect" : language).tag(language)
                }
            }
            .disabled(disabled)
            .accessibilityIdentifier("juno.desktop.settings.response-language")

            Picker(
                "Interface",
                selection: junoSettingsBinding(
                    settings, \.interfaceLocale, update: update
                ) { NativeSettingsPatch(interfaceLocale: $0) }
            ) {
                ForEach(
                    junoKnownOrCurrent(
                        Self.interfaceLocales, current: settings.interfaceLocale
                    ),
                    id: \.self
                ) { locale in
                    Text(
                        locale == "auto"
                            ? "Match system"
                            : (Locale.current.localizedString(forIdentifier: locale) ?? locale)
                    )
                    .tag(locale)
                }
            }
            .disabled(disabled)
            .accessibilityIdentifier("juno.desktop.settings.interface-language")
        } header: {
            Text("Language")
        } footer: {
            Text("Responses is the language Juno replies in. Interface is the language this app's buttons and menus are in.")
        }
    }

    private func instructionsSection(_ settings: NativeAccountSettings) -> some View {
        Section {
            TextEditor(text: $instructionsDraft)
                .junoBody()
                .frame(minHeight: DesktopSettingsMetrics.editorMinHeight)
                .scrollContentBackground(.hidden)
                .padding(JunoSpace.snug)
                .junoPanel(cornerRadius: JunoRadius.control)
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .strokeBorder(Color.junoBorder)
                )
                .accessibilityLabel("Custom instructions")
                .accessibilityIdentifier("juno.desktop.settings.instructions")

            HStack {
                // The web shows the same count. It is not a cap — it is the one
                // number that tells you a paste actually landed.
                Text("\(instructionsDraft.count) chars")
                    .junoMono()
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Revert") { instructionsDraft = settings.customInstructions }
                    .disabled(instructionsDraft == settings.customInstructions)
                Button("Save") {
                    update(NativeSettingsPatch(customInstructions: instructionsDraft))
                }
                .keyboardShortcut("s", modifiers: .command)
                .help("Save your custom instructions (⌘S)")
                .disabled(disabled || instructionsDraft == settings.customInstructions)
                .accessibilityIdentifier("juno.desktop.settings.save-instructions")
            }
        } header: {
            Text("Custom instructions")
        } footer: {
            Text("Juno keeps these in mind in every conversation on this account. There is no character cap — the model's context window is the only real limit.")
        }
    }

    private func notificationsSection(_ settings: NativeAccountSettings) -> some View {
        Section {
            DesktopSettingsToggle(
                title: "Budget alerts",
                explanation: "Email me at 80% of my monthly budget.",
                isOn: junoSettingsBinding(
                    settings, \.emailBudgetAlerts, update: update
                ) { NativeSettingsPatch(emailBudgetAlerts: $0) }
            )
            .disabled(disabled)
            .accessibilityIdentifier("juno.desktop.settings.budget-alerts")

            DesktopSettingsToggle(
                title: "Weekly digest",
                explanation: "Usage recap every Monday.",
                isOn: junoSettingsBinding(
                    settings, \.emailWeeklyDigest, update: update
                ) { NativeSettingsPatch(emailWeeklyDigest: $0) }
            )
            .disabled(disabled)
            .accessibilityIdentifier("juno.desktop.settings.weekly-digest")
        } header: {
            Text("Email notifications")
        } footer: {
            Text("Both are sent to your account's email address, and both are stored on the account — turning one off here turns it off on the web too.")
        }
    }

    private func favoriteBinding(
        _ settings: NativeAccountSettings,
        _ modelID: String
    ) -> Binding<Bool> {
        Binding(
            get: { settings.favoriteModels.contains(modelID) },
            set: { isFavorite in
                var favorites = settings.favoriteModels
                if isFavorite {
                    guard !favorites.contains(modelID) else { return }
                    favorites.append(modelID)
                } else {
                    favorites.removeAll { $0 == modelID }
                }
                update(NativeSettingsPatch(favoriteModels: favorites))
            }
        )
    }
}

// MARK: - Appearance

private struct DesktopSettingsAppearancePane: View {
    let settings: NativeAccountSettings?
    let disabled: Bool
    let unavailableMessage: String?
    let retry: () -> Void
    let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

    var body: some View {
        DesktopSettingsPane {
            if let settings {
                Section {
                    Picker(
                        "Theme",
                        selection: junoSettingsBinding(
                            settings, \.theme, update: update
                        ) { NativeSettingsPatch(theme: $0) }
                    ) {
                        Text("System").tag(NativeThemePreference.system)
                        Text("Light").tag(NativeThemePreference.light)
                        Text("Dark").tag(NativeThemePreference.dark)
                    }
                    .pickerStyle(.segmented)
                    .disabled(disabled)
                    .accessibilityIdentifier("juno.desktop.settings.theme")
                } header: {
                    Text("Theme")
                } footer: {
                    Text("Light and Dark override this Mac's appearance for Juno only. System follows it. The choice is stored on your account, so it travels to the web and to your phone.")
                }

                Section {
                    Picker("Accent", selection: accentBinding(settings)) {
                        ForEach(JunoAccent.allCases) { accent in
                            Label {
                                Text(accent.displayName)
                            } icon: {
                                Circle()
                                    .fill(accent.color)
                                    .frame(
                                        width: DesktopSettingsMetrics.swatchSize,
                                        height: DesktopSettingsMetrics.swatchSize
                                    )
                            }
                            .tag(accent)
                        }
                    }
                    .pickerStyle(.radioGroup)
                    .disabled(disabled)
                    .accessibilityIdentifier("juno.desktop.settings.accent")
                } header: {
                    Text("Accent color")
                } footer: {
                    // Only said when it is true: the web can store an arbitrary
                    // hex accent, and this app ships five. Resolving that to
                    // Coral without saying so would look like the picker had
                    // silently changed the account's colour.
                    if JunoAccent(rawValue: settings.accent.lowercased()) == nil {
                        Text("This account has a custom accent set on the web. Juno for Mac uses Coral for it; choosing one here replaces it.")
                    } else {
                        Text("Used for selection, links and the send button across the app. Each one is defined in both light and dark, so switching theme keeps the same colour readable.")
                    }
                }
            } else if let unavailableMessage {
                DesktopSettingsUnavailable(message: unavailableMessage, retry: retry)
            }
        }
    }

    /// Bound to the resolved accent rather than to the stored string, so an
    /// unrecognized value cannot leave the picker with nothing selected.
    private func accentBinding(_ settings: NativeAccountSettings) -> Binding<JunoAccent> {
        Binding(
            get: { JunoAccent(setting: settings.accent) },
            set: { accent in
                guard accent.rawValue != settings.accent else { return }
                update(NativeSettingsPatch(accent: accent.rawValue))
            }
        )
    }
}

// MARK: - Memory

private struct DesktopSettingsMemoryPane: View {
    let model: NativeMemorySettingsModel<SQLiteAccountRepository>

    @State private var newMemory = ""
    @State private var selection: Set<String> = []
    @State private var pendingDeletion: Set<String> = []
    @State private var showingEraseAll = false
    @State private var editingMemoryID: String?
    @State private var editingContent = ""
    @State private var exportDocument: DesktopSettingsExportDocument?
    @State private var showingExporter = false
    @State private var exportError: String?

    private var isPaused: Bool { !(model.settings?.memoryEnabled ?? true) }

    /// Whether there is anything to export or erase. Both buttons are dead
    /// without it — an "Erase all" that succeeds on an empty account teaches the
    /// reader that the button works, which is exactly the wrong lesson.
    private var hasMemoryContent: Bool {
        !model.memories.isEmpty || model.summary != nil
    }

    var body: some View {
        DesktopSettingsPane {
            Section {
                Toggle("Remember details from chats", isOn: memoryBinding)
                    .disabled(model.isMutating || model.settings == nil)
                    .accessibilityIdentifier("juno.desktop.settings.memory-enabled")
                LabeledContent("Saved facts", value: "\(model.memories.count)")
            } header: {
                Text("Memory")
            } footer: {
                Text("Pausing stops Juno from saving or using memories. Private chats are never remembered, and memory is never used to train models.")
            }

            Section {
                summaryContent
                Button("Refresh summary") { Task { await model.refresh() } }
                    .disabled(model.isRefreshingSummary)
                    .accessibilityIdentifier("juno.desktop.settings.refresh-summary")
            } header: {
                Text("What Juno remembers")
            } footer: {
                Text(summaryFootnote)
            }

            Section {
                facts
                HStack(spacing: JunoSpace.snug) {
                    TextField("Something Juno should remember", text: $newMemory)
                        .onSubmit(addMemory)
                        .accessibilityIdentifier("juno.desktop.settings.memory-field")
                    Button("Add", action: addMemory)
                        .disabled(model.isMutating || trimmedNewMemory.isEmpty)
                        .accessibilityIdentifier("juno.desktop.settings.memory-add")
                    // The same two actions the context menu offers, as buttons,
                    // because a context menu is unreachable without a pointer.
                    Button("Edit…") {
                        guard let memory = singleMemory(in: selection) else { return }
                        beginEditing(memory)
                    }
                    .disabled(model.isMutating || singleMemory(in: selection) == nil)
                    .accessibilityIdentifier("juno.desktop.settings.memory-edit")
                    Button("Remove") { pendingDeletion = selection }
                        .disabled(model.isMutating || selection.isEmpty)
                        .help("Delete the selected memories (⌘⌫)")
                        .keyboardShortcut(.delete, modifiers: .command)
                        .accessibilityIdentifier("juno.desktop.settings.memory-remove")
                }
            } header: {
                Text("Individual facts")
            } footer: {
                Text("Each of these is a line Juno can quote. The summary above is written from them.")
            }

            Section {
                // Written here from the memories already loaded, in the same
                // shape the web's Export button produces — no request, so it
                // works offline and cannot report a success it did not have.
                Button("Export memory…", action: exportMemory)
                    .disabled(!hasMemoryContent)
                    .accessibilityIdentifier("juno.desktop.settings.memory-export")
                    // Attached to the button, not to the pane: the delete dialog
                    // and the edit sheet already live there, and a third
                    // presentation on one view is where SwiftUI drops one.
                    .fileExporter(
                        isPresented: $showingExporter,
                        document: exportDocument,
                        contentType: .json,
                        defaultFilename: "juno-memory"
                    ) { result in
                        if case .failure(let error) = result {
                            exportError = error.localizedDescription
                        }
                        exportDocument = nil
                    }

                Button("Erase all memory…", role: .destructive) { showingEraseAll = true }
                    .disabled(model.isErasing || !hasMemoryContent)
                    .accessibilityIdentifier("juno.desktop.settings.memory-erase")
                    .confirmationDialog(
                        "Erase everything Juno remembers?",
                        isPresented: $showingEraseAll
                    ) {
                        Button("Erase everything", role: .destructive) {
                            Task { await model.eraseAllMemory() }
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This permanently removes every saved fact and the consolidated summary.")
                    }

                if let exportError {
                    Label(exportError, systemImage: "exclamationmark.circle")
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                }
            } header: {
                Text("Your memory")
            } footer: {
                Text("Export writes the summary, every fact and the never-remember list to a JSON file. Erasing removes all of it. Old chats are not re-learned, and it cannot be undone.")
            }
        }
        .confirmationDialog(
            pendingDeletion.count == 1
                ? "Delete this memory?"
                : "Delete \(pendingDeletion.count) memories?",
            isPresented: Binding(
                get: { !pendingDeletion.isEmpty },
                set: { if !$0 { pendingDeletion = [] } }
            )
        ) {
            Button("Delete", role: .destructive) {
                let ids = pendingDeletion
                pendingDeletion = []
                selection.subtract(ids)
                Task {
                    for id in ids { await model.deleteMemory(id: id) }
                }
            }
            Button("Cancel", role: .cancel) { pendingDeletion = [] }
        } message: {
            Text("Juno will no longer use these facts in conversations.")
        }
        .sheet(
            isPresented: Binding(
                get: { editingMemoryID != nil },
                set: { if !$0 { editingMemoryID = nil } }
            )
        ) {
            editSheet
        }
    }

    /// Editing one fact, full width and multi-line. A memory is a sentence —
    /// "Prefers short explanations with code examples." — and a single-line field
    /// in a table cell shows about a third of one.
    private var editSheet: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Edit memory")
                .junoEmptyTitle()
            TextEditor(text: $editingContent)
                .junoBody()
                .frame(minHeight: DesktopSettingsMetrics.editorMinHeight)
                .scrollContentBackground(.hidden)
                .padding(JunoSpace.snug)
                .junoPanel(cornerRadius: JunoRadius.control)
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .strokeBorder(Color.junoBorder)
                )
                .accessibilityLabel("Memory")
                .accessibilityIdentifier("juno.desktop.settings.memory-edit-field")
            Text("Write it as a short, durable statement — Juno quotes these back as facts.")
                .junoCaption()
            HStack {
                Spacer()
                Button("Cancel") { editingMemoryID = nil }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    guard let id = editingMemoryID else { return }
                    editingMemoryID = nil
                    Task { await model.updateMemory(id: id, content: editingContent) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    model.isMutating
                        || editingContent
                            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
                .accessibilityIdentifier("juno.desktop.settings.memory-edit-save")
            }
        }
        .padding(JunoSpace.roomy)
        .frame(width: DesktopSettingsMetrics.sheetWidth)
    }

    /// The consolidated profile, as prose. It is the only long-form reading on
    /// this screen, so it sits on an opaque panel and stays selectable.
    @ViewBuilder
    private var summaryContent: some View {
        if model.isRefreshingSummary, model.summary == nil {
            HStack(spacing: JunoSpace.snug) {
                ProgressView().controlSize(.small)
                Text("Consolidating what Juno has learned…")
                    .junoCaption()
            }
        } else if let summary = model.summary, !summary.content.isEmpty {
            JunoMarkdownText(summary.content)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(
                isPaused
                    ? "Memory is paused, so nothing new is being learned."
                    : "Nothing yet — Juno writes this from your chats once there is enough to say."
            )
            .junoCaption()
        }
    }

    private var summaryFootnote: String {
        guard let summary = model.summary, !summary.content.isEmpty else {
            return isPaused
                ? "Nothing new is being learned while memory is paused."
                : "Distilled from your chats, projects and connections, and used as context whenever you talk to Juno."
        }
        let facts = summary.entryCount == 1 ? "1 fact" : "\(summary.entryCount) facts"
        return "Built from \(facts) · updated \(summary.updatedAt.formatted(date: .abbreviated, time: .shortened))"
    }

    /// A real `Table`: three columns the reader genuinely wants to sort by eye —
    /// the sentence, where it came from, and when. Provenance is a column and
    /// not a badge because "you told Juno this" and "Juno worked this out" are
    /// different claims, and only one of them is worth auditing.
    @ViewBuilder
    private var facts: some View {
        if model.memories.isEmpty {
            Text("Nothing saved yet. What Juno learns in chats appears here.")
                .junoCaption()
        } else {
            Table(model.memories, selection: $selection) {
                TableColumn("Memory") { memory in
                    HStack(spacing: JunoSpace.tight) {
                        // A suppression is not a fact — it is an instruction to
                        // stop using one, and it reads as a contradiction unless
                        // it is marked.
                        if memory.kind == .suppression {
                            Image(systemName: "hand.raised")
                                .foregroundStyle(.secondary)
                                .help("Juno has been told never to remember this")
                                .accessibilityLabel("Never remember")
                        }
                        Text(memory.content)
                            .lineLimit(2)
                        if memory.isPending {
                            Text("waiting to sync")
                                .junoCaption()
                        }
                    }
                }
                TableColumn("Source") { memory in
                    Text(memory.source == .manual ? "Added by you" : "Learned from chats")
                        .foregroundStyle(.secondary)
                }
                .width(min: 110, ideal: 130)
                TableColumn("Added") { memory in
                    Text(memory.createdAt.formatted(date: .abbreviated, time: .omitted))
                        .foregroundStyle(.secondary)
                }
                .width(min: 90, ideal: 100)
            }
            .frame(height: DesktopSettingsMetrics.embeddedListHeight)
            .contextMenu(forSelectionType: String.self) { ids in
                let target = ids.isEmpty ? selection : ids
                if let memory = singleMemory(in: target) {
                    Button("Edit…") { beginEditing(memory) }
                }
                Button("Delete", role: .destructive) { pendingDeletion = target }
            }
            .onDeleteCommand {
                guard !selection.isEmpty else { return }
                pendingDeletion = selection
            }
            .accessibilityIdentifier("juno.desktop.settings.memories")
        }
    }

    private var trimmedNewMemory: String {
        newMemory.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The one memory a selection refers to, or nil when it names none or many —
    /// editing is a single-row action and the control that offers it says so by
    /// being disabled.
    private func singleMemory(in ids: Set<String>) -> NativeMemoryEntry? {
        guard ids.count == 1, let id = ids.first else { return nil }
        return model.memories.first { $0.id == id }
    }

    private func beginEditing(_ memory: NativeMemoryEntry) {
        editingContent = memory.content
        editingMemoryID = memory.id
    }

    private func addMemory() {
        let content = trimmedNewMemory
        guard !content.isEmpty else { return }
        newMemory = ""
        Task { await model.createMemory(content: content) }
    }

    /// The same payload the website's Export button writes, field for field, so
    /// one account's memory reads the same whichever client wrote the file.
    /// Suppressions are separated out because they are a block-list, not facts.
    private func exportMemory() {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        var payload: [String: Any] = [
            "exportedAt": iso.string(from: Date()),
            "facts": model.memories.filter { $0.kind == .fact }.map { memory in
                [
                    "id": memory.id,
                    "content": memory.content,
                    "source": memory.source.rawValue,
                    "createdAt": iso.string(from: memory.createdAt),
                    "updatedAt": iso.string(from: memory.updatedAt),
                ]
            },
            "neverRemember": model.memories
                .filter { $0.kind == .suppression }
                .map(\.content),
        ]
        // `null` rather than an absent key, matching the web's payload: a reader
        // can tell "no summary yet" from "this file predates summaries". Unwrapped
        // deliberately — an `Optional` inside the dictionary is not a JSON value
        // and `JSONSerialization` would throw on it.
        if let summary = model.summary?.content, !summary.isEmpty {
            payload["summary"] = summary
        } else {
            payload["summary"] = NSNull()
        }
        do {
            let data = try JSONSerialization.data(
                withJSONObject: payload,
                options: [.prettyPrinted, .sortedKeys]
            )
            exportError = nil
            exportDocument = DesktopSettingsExportDocument(data: data)
            showingExporter = true
        } catch {
            exportError = error.localizedDescription
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
}

// MARK: - Account

private struct DesktopSettingsAccountPane: View {
    let authModel: NativeAuthModel
    let session: NativeAuthenticatedSession
    let avatarData: Data?
    let accountDataClient: NativeAccountDataClient?
    let usage: DesktopUsageSnapshot?

    @State private var isExporting = false
    @State private var exportDocument: DesktopSettingsExportDocument?
    @State private var exportContentType: UTType = .json
    @State private var exportFilename = ""
    @State private var showingExporter = false
    @State private var showingSignOut = false
    @State private var showingDeleteAccount = false
    @State private var deleteConfirmation = ""
    @State private var isDeletingAccount = false
    @State private var accountError: String?

    var body: some View {
        DesktopSettingsPane {
            Section {
                HStack(spacing: JunoSpace.cozy) {
                    JunoAvatar(
                        imageData: avatarData,
                        imageURL: session.profile.imageURL,
                        name: session.profile.name ?? session.profile.email,
                        size: DesktopSettingsMetrics.avatarSize
                    )
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text(session.profile.name ?? session.profile.email)
                            .junoTitle()
                        Text(session.profile.email)
                            .junoCaption()
                            .textSelection(.enabled)
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)

                // Stated only once it is known. A plan row that reads "—" while
                // the request is in flight is a number the reader will remember
                // having seen.
                if let usage {
                    LabeledContent("Plan", value: usage.planName)
                    if let renewsAt = usage.renewsAt {
                        LabeledContent(
                            usage.renewalLabel,
                            value: renewsAt.formatted(date: .abbreviated, time: .omitted)
                        )
                    }
                }
            } header: {
                Text("Signed in")
            } footer: {
                if let tagline = usage?.planTagline {
                    Text(tagline)
                }
            }

            Section {
                if accountDataClient == nil {
                    Text("Data export is unavailable because Juno could not compose an authenticated client.")
                        .junoCaption()
                } else {
                    HStack(spacing: JunoSpace.snug) {
                        Button("Export as JSON…") { export(.json) }
                            .disabled(isExporting)
                            .accessibilityIdentifier("juno.desktop.settings.export-json")
                        Button("Export as CSV…") { export(.csv) }
                            .disabled(isExporting)
                            .accessibilityIdentifier("juno.desktop.settings.export-csv")
                        if isExporting {
                            ProgressView().controlSize(.small)
                        }
                        Spacer(minLength: 0)
                    }
                    // Attached here rather than to the pane: the save panel and
                    // the delete sheet are both presentations, and two of those
                    // on one view is where SwiftUI drops one of them.
                    .fileExporter(
                        isPresented: $showingExporter,
                        document: exportDocument,
                        contentType: exportContentType,
                        defaultFilename: exportFilename
                    ) { result in
                        if case .failure(let error) = result {
                            accountError = error.localizedDescription
                        }
                        exportDocument = nil
                    }
                }
            } header: {
                Text("Your data")
            } footer: {
                Text("Every conversation, project, file and memory on this account. Juno downloads it, then you choose where it goes.")
            }

            Section {
                Button("Sign out") { showingSignOut = true }
                    .accessibilityIdentifier("juno.desktop.settings.sign-out")
                    .confirmationDialog("Sign out of Juno?", isPresented: $showingSignOut) {
                        Button("Sign out", role: .destructive) {
                            Task { await authModel.signOut() }
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Juno will remove this Mac's local copy of your conversations and settings. Nothing is deleted on the server.")
                    }
                if accountDataClient != nil {
                    Button("Delete account…", role: .destructive) {
                        deleteConfirmation = ""
                        showingDeleteAccount = true
                    }
                    .disabled(isDeletingAccount)
                    .accessibilityIdentifier("juno.desktop.settings.delete-account")
                }
                if let accountError {
                    Label(accountError, systemImage: "exclamationmark.circle")
                        .junoCaption()
                        .foregroundStyle(Color.junoCaution)
                }
            } header: {
                Text("Danger zone")
            } footer: {
                Text("Signing out removes this Mac's copy of your data. Deleting permanently removes your account, conversations and memories, everywhere.")
            }
        }
        .sheet(isPresented: $showingDeleteAccount) { deleteAccountSheet }
    }

    private var deleteAccountSheet: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Delete your account?")
                .junoEmptyTitle()
            Text("This permanently deletes every conversation, project, file and memory on this account. It cannot be undone.")
                .junoBody()
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Type \(session.profile.email) to confirm.")
                .junoCaption()
            TextField("Email", text: $deleteConfirmation)
                .accessibilityLabel("Confirm your email address")
                .accessibilityIdentifier("juno.desktop.settings.delete-confirm")
            if let accountError {
                Label(accountError, systemImage: "exclamationmark.circle")
                    .junoCaption()
                    .foregroundStyle(Color.junoCaution)
            }
            HStack {
                Spacer()
                Button("Cancel") { showingDeleteAccount = false }
                    .keyboardShortcut(.cancelAction)
                if isDeletingAccount {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Delete account", role: .destructive, action: deleteAccount)
                        .disabled(!deleteConfirmationMatches)
                }
            }
        }
        .padding(JunoSpace.roomy)
        // An explicit width. A presented surface that negotiates its own width
        // re-lays out the window underneath it while it appears, and that
        // re-measure is what this shell has previously fallen into a constraint
        // loop over.
        .frame(width: DesktopSettingsMetrics.sheetWidth)
    }

    /// The same comparison the server makes, so the button is dead until the
    /// confirmation is right rather than live and then refused — `/api/account/
    /// delete` allows three attempts an hour.
    private var deleteConfirmationMatches: Bool {
        !session.profile.email.isEmpty
            && deleteConfirmation
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(session.profile.email) == .orderedSame
    }

    /// Downloads the export, then hands it to `.fileExporter`.
    ///
    /// Two steps rather than one because the file does not exist until the
    /// request comes back: a save panel opened first would be asking where to
    /// put something Juno might fail to fetch. The shared client writes the
    /// response to a temporary file, so the bytes are read back from there —
    /// that keeps the export rules (row caps, CSV quoting) in the one place
    /// both apps share.
    private func export(_ format: NativeAccountDataClient.ExportFormat) {
        guard let accountDataClient else { return }
        isExporting = true
        accountError = nil
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
                // content type, and passing the client's full file name gave
                // the sheet "juno-export-2026-07-26.json.json" to save.
                exportFilename = URL(fileURLWithPath: format.fileName(on: Date()))
                    .deletingPathExtension()
                    .lastPathComponent
                showingExporter = true
            } catch {
                accountError = error.localizedDescription
            }
        }
    }

    private func deleteAccount() {
        guard let accountDataClient else { return }
        isDeletingAccount = true
        accountError = nil
        Task {
            defer { isDeletingAccount = false }
            do {
                try await accountDataClient.deleteAccount(
                    confirmEmail: deleteConfirmation,
                    accountEmail: session.profile.email,
                    for: session.profile.id
                )
                showingDeleteAccount = false
                // The account is gone; the local mirror has to go too, and
                // signing out is what tears down every model holding a copy.
                await authModel.signOut()
            } catch {
                accountError = error.localizedDescription
            }
        }
    }
}

/// A snapshot on its way to a file the reader chooses — the account export from
/// the server, or the memory export written locally.
///
/// Write-only: reading one back into the app is not a thing Juno does, so the
/// read initializer refuses rather than pretending to import.
private struct DesktopSettingsExportDocument: FileDocument {
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

// MARK: - Usage

private struct DesktopSettingsUsagePane: View {
    let usage: DesktopUsageSnapshot?
    let errorDescription: String?
    let isLoading: Bool
    let isConfigured: Bool
    let reload: () -> Void

    var body: some View {
        if !isConfigured {
            DesktopSettingsClamp {
                JunoEmptyState(
                    title: "Usage unavailable",
                    message: "Juno could not compose an authenticated client on this Mac, so your plan and limits cannot be read.",
                    symbol: "chart.bar"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            DesktopSettingsPane {
                if let usage {
                    planSection(usage)
                    limitsSection(usage)

                    Section {
                        Button("Refresh", action: reload)
                            .disabled(isLoading)
                            .accessibilityIdentifier("juno.desktop.settings.usage-refresh")
                    }
                } else if isLoading {
                    Section {
                        HStack(spacing: JunoSpace.snug) {
                            ProgressView().controlSize(.small)
                            Text("Reading your plan and limits…").junoCaption()
                        }
                    }
                } else {
                    Section {
                        Label(
                            errorDescription ?? "Juno could not read your usage.",
                            systemImage: "exclamationmark.circle"
                        )
                        .junoRowLabel()
                        .foregroundStyle(.secondary)
                        Button("Try again", action: reload)
                            .accessibilityIdentifier("juno.desktop.settings.usage-retry")
                    } header: {
                        Text("Usage")
                    }
                }
            }
        }
    }

    private func planSection(_ usage: DesktopUsageSnapshot) -> some View {
        Section {
            LabeledContent("Current plan", value: usage.planName)
            if let renewsAt = usage.renewsAt {
                LabeledContent(
                    usage.renewalLabel,
                    value: renewsAt.formatted(date: .abbreviated, time: .omitted)
                )
            }
            // Only where there is a budget to spend against. On a browse-only
            // tier "€0.00 of €0.00" is arithmetic, not information.
            if let budget = usage.budgetMicroUsd, budget > 0 {
                LabeledContent(
                    "Spent this period",
                    value: "\(usage.euro(usage.spentMicroUsd)) of \(usage.euro(budget))"
                )
            }
        } header: {
            Text("Plan")
        } footer: {
            if let tagline = usage.planTagline {
                Text(tagline)
            }
        }
    }

    @ViewBuilder
    private func limitsSection(_ usage: DesktopUsageSnapshot) -> some View {
        Section {
            if usage.isUnlimited {
                Text("No usage limits on this plan.")
                    .junoRowLabel()
            } else if usage.isBrowseOnly {
                // The web says exactly this on Free, and it is the honest
                // reading of a zero budget: the meters are not at 0% because
                // nothing has been used, they are inapplicable.
                Text("Free is a browse-only tier. Upgrade to Pro to start using models.")
                    .junoRowLabel()
            } else {
                meter(
                    "Current session",
                    usage.session,
                    fallbackCaption: "5-hour window"
                )
                meter(
                    "Weekly · all models",
                    usage.weekly,
                    fallbackCaption: "7-day window"
                )
            }
        } header: {
            Text("Limits")
        } footer: {
            if !usage.isUnlimited, !usage.isBrowseOnly {
                Text("Rolling windows, each a proportional slice of the period budget. They reset on their own clock, not at the start of the month.")
            }
        }
    }

    /// A real `Gauge`, not a hand-drawn bar: it brings the platform's own
    /// capacity styling, its accessibility value and its behaviour under
    /// Increase Contrast. The reset time sits under it as text rather than in a
    /// tooltip, because a tooltip is not reachable from the keyboard.
    private func meter(
        _ label: String,
        _ window: DesktopUsageSnapshot.Window,
        fallbackCaption: String
    ) -> some View {
        let fraction = min(1, max(0, window.fraction))
        return VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Gauge(value: fraction) {
                Text(label)
            } currentValueLabel: {
                Text(fraction.formatted(.percent.precision(.fractionLength(0))))
                    .junoMono()
            }
            .gaugeStyle(.accessoryLinearCapacity)
            .tint(window.fraction >= 0.9 ? Color.junoCaution : Color.junoAccent)
            .accessibilityLabel(label)
            .accessibilityValue(
                fraction.formatted(.percent.precision(.fractionLength(0))) + " used"
            )

            if let resetsAt = window.resetsAt {
                Text("Resets \(resetsAt.formatted(date: .abbreviated, time: .shortened))")
                    .junoCaption()
            } else {
                Text(fallbackCaption)
                    .junoCaption()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private enum DesktopUsageError: LocalizedError {
    case server(message: String)

    var errorDescription: String? {
        switch self {
        case .server(let message): message
        }
    }
}

/// What `/api/profile/usage` says, in the shapes this pane draws.
private struct DesktopUsageSnapshot: Equatable, Sendable {
    struct Window: Equatable, Sendable {
        /// 0…1 of this window's budget, as the server computed it. Can exceed 1.
        let fraction: Double
        let resetsAt: Date?
    }

    let planID: String
    let session: Window
    let weekly: Window
    let spentMicroUsd: Double
    /// Nil on a plan with no budget at all.
    let budgetMicroUsd: Double?
    let eurPerUsd: Double
    let renewsAt: Date?
    let cancelAtPeriodEnd: Bool

    var isUnlimited: Bool { budgetMicroUsd == nil }

    /// A plan that exists but cannot spend — Free, whose budget is genuinely
    /// zero. Distinct from unlimited, and distinct from "0% used so far".
    var isBrowseOnly: Bool {
        guard let budgetMicroUsd else { return false }
        return budgetMicroUsd <= 0
    }

    /// The plan's product name. Unknown identifiers show through unchanged
    /// rather than being renamed to something this build made up.
    var planName: String {
        switch planID.uppercased() {
        case "FREE": "Free"
        case "PRO": "Pro"
        case "MAX": "Max x5"
        case "MAX20": "Max x20"
        case "OWNER": "Owner"
        default: planID
        }
    }

    /// The one-line description the website shows beside the plan name, from
    /// `src/lib/plans.ts`. Nil for an identifier this build does not know —
    /// inventing a tagline for it would be describing a plan we cannot see.
    var planTagline: String? {
        switch planID.uppercased() {
        case "FREE": "Create an account and look around."
        case "PRO": "For everyday power use."
        case "MAX": "For professionals who live in Juno."
        case "MAX20": "For teams of one who never stop."
        case "OWNER": "Full, unlimited access to everything."
        default: nil
        }
    }

    /// What the billing date means. A cancelled subscription's period end is the
    /// day access stops, not the day a new budget arrives, and labelling both
    /// "Renews" is how a reader plans around a date that is not coming.
    var renewalLabel: String {
        cancelAtPeriodEnd ? "Access ends" : "Budget renews"
    }

    /// The ledger is in micro-USD and the product is priced in euros; the rate
    /// comes from the same response, exactly as the web does it.
    func euro(_ microUSD: Double) -> String {
        let rate = eurPerUsd > 0 ? eurPerUsd : 1
        return (microUSD / 1_000_000 * rate)
            .formatted(.currency(code: "EUR").precision(.fractionLength(2)))
    }

    init(_ wire: DesktopUsageWire) {
        planID = wire.quota.plan
        session = Window(
            fraction: wire.spend.windows.session.pct,
            resetsAt: Self.date(fromMilliseconds: wire.spend.windows.session.resetsAtMs)
        )
        weekly = Window(
            fraction: wire.spend.windows.weekly.pct,
            resetsAt: Self.date(fromMilliseconds: wire.spend.windows.weekly.resetsAtMs)
        )
        spentMicroUsd = wire.spend.spentMicroUsd
        budgetMicroUsd = wire.spend.budgetMicroUsd
        eurPerUsd = wire.spend.eurPerUsd
        renewsAt = Self.date(fromMilliseconds: wire.spend.billing.renewsAtMs)
        cancelAtPeriodEnd = wire.spend.billing.cancelAtPeriodEnd
    }

    private static func date(fromMilliseconds value: Double?) -> Date? {
        guard let value, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value / 1000)
    }
}

private struct DesktopUsageWire: Decodable {
    struct Quota: Decodable {
        let plan: String
    }

    struct Window: Decodable {
        let pct: Double
        let resetsAtMs: Double?
    }

    struct Windows: Decodable {
        let session: Window
        let weekly: Window
    }

    struct Billing: Decodable {
        let renewsAtMs: Double?
        let cancelAtPeriodEnd: Bool
    }

    struct Spend: Decodable {
        let spentMicroUsd: Double
        let budgetMicroUsd: Double?
        let eurPerUsd: Double
        let windows: Windows
        let billing: Billing
    }

    let quota: Quota
    let spend: Spend
}
