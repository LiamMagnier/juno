import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// **Settings**, laid out the way the website's is: a serif title over the
/// account, then a column of tiles — each one a card with a small monospaced
/// eyebrow naming what it governs.
///
/// It was a plain `Form` before, which is the iOS Settings idiom: correct for a
/// system pane, wrong for a product surface that has its own typography and its
/// own grouping. The controls inside the tiles are still native pickers and
/// toggles, because those are what a phone user knows how to operate — it is the
/// *frame* that changed, not the mechanics.
struct JunoMobileSettingsView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    var authModel: NativeAuthModel?
    var session: NativeAuthenticatedSession?
    var syncModel: NativeSyncModel<SQLiteAccountRepository>?
    var outbox: (any MutationOutboxRepository)?
    @State private var showingSignOut = false
    @State private var showMemoryPage = false
    @State private var showDiagnosticsPage = false

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed where model.settings == nil && model.memories.isEmpty:
                ContentUnavailableView {
                    Label("Settings unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.lastErrorDescription ?? "Try again.")
                } actions: {
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.borderedProminent)
                }
            default:
                tiles
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $showMemoryPage) {
            JunoMobileMemoryView(model: model)
        }
        .navigationDestination(isPresented: $showDiagnosticsPage) {
            NativeDiagnosticsView(
                syncModel: syncModel,
                outbox: outbox,
                accountID: session.map { StorageAccountID($0.profile.id.rawValue) }
            )
        }
        .task {
            #if DEBUG
            if CommandLine.arguments.contains("--juno-preview-memory") {
                try? await Task.sleep(nanoseconds: 350_000_000)
                showMemoryPage = true
            }
            if CommandLine.arguments.contains("--juno-preview-diagnostics") {
                try? await Task.sleep(nanoseconds: 350_000_000)
                showDiagnosticsPage = true
            }
            #endif
        }
        .safeAreaInset(edge: .bottom) {
            if model.conflictedMutationCount > 0 {
                conflictBanner
            } else if model.phase == .offline || model.lastErrorDescription != nil {
                statusBanner
            }
        }
        .confirmationDialog(
            "auth.sign-out.confirm.title",
            isPresented: $showingSignOut,
            titleVisibility: .visible
        ) {
            Button("auth.sign-out", role: .destructive) {
                Task { await authModel?.signOut() }
            }
            Button("action.cancel", role: .cancel) {}
        } message: {
            Text("auth.sign-out.confirm.message")
        }
        .accessibilityIdentifier("juno.mobile.settings")
    }

    private var tiles: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                header

                if let settings = model.settings {
                    JunoMobileSettingsSections(
                        settings: settings,
                        modelCatalog: conversationModel?.selectableModels ?? [],
                        disabled: model.isMutating,
                        update: { patch in Task { await model.updateSettings(patch) } }
                    )
                } else {
                    JunoSettingsTile(eyebrow: "Preferences") {
                        Label(
                            "Account settings have not finished synchronizing.",
                            systemImage: "clock.arrow.circlepath"
                        )
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    }
                }

                JunoSettingsTile(eyebrow: "Memory") {
                    JunoSettingsLink(
                        title: "Memory",
                        value: Text("^[\(model.memories.count) memory](inflect: true)"),
                        symbol: "brain"
                    ) { showMemoryPage = true }
                    .accessibilityIdentifier("juno.mobile.settings-memory-link")
                }

                JunoSettingsTile(eyebrow: "Account") {
                    VStack(alignment: .leading, spacing: 12) {
                        if let session {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.profile.name ?? session.profile.email)
                                    .font(.system(size: 16, weight: .medium))
                                Text(session.profile.email)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                        if authModel != nil {
                            Button(role: .destructive) {
                                showingSignOut = true
                            } label: {
                                Label("auth.sign-out", systemImage: "rectangle.portrait.and.arrow.right")
                                    .font(.system(size: 15, weight: .medium))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("juno.mobile.account-signout")
                        }
                    }
                }

                JunoSettingsTile(eyebrow: "About") {
                    JunoSettingsLink(
                        title: "diagnostics.title",
                        value: Text(JunoBuildInfo.current.displayVersion),
                        symbol: "stethoscope"
                    ) { showDiagnosticsPage = true }
                    .accessibilityIdentifier("juno.mobile.settings-diagnostics-link")
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .refreshable { await model.refresh() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            if let session {
                JunoAvatar(
                    imageURL: session.profile.imageURL,
                    name: session.profile.name ?? session.profile.email,
                    size: 44
                )
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Settings")
                    .junoPageHeading(compact: true)
                    .accessibilityAddTraits(.isHeader)
                if let session {
                    Text(session.profile.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
    }

    private var conflictBanner: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                Text("Memory or settings changed on another device.")
                    .lineLimit(2)
                Spacer()
            }
            HStack {
                Button("Keep mine") {
                    Task { await model.resolveConflicts(keepLocalChanges: true) }
                }
                Spacer()
                Button("Use server version") {
                    Task { await model.resolveConflicts(keepLocalChanges: false) }
                }
            }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.settings-conflict")
    }

    private var statusBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: model.phase == .offline
                ? "wifi.slash" : "exclamationmark.circle")
            Text(model.lastErrorDescription
                ?? "Offline — showing saved settings. Changes will sync when Juno reconnects.")
                .lineLimit(2)
            Spacer()
            Button("Retry") { Task { await model.refresh() } }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
        .accessibilityIdentifier("juno.mobile.settings-status")
    }
}

/// One settings tile: a card with a monospaced eyebrow naming what it governs.
/// The eyebrow is the web page's own device — it lets a section be identified
/// without spending a heading-sized line on it.
struct JunoSettingsTile<Content: View>: View {
    let eyebrow: LocalizedStringKey
    @ViewBuilder var content: Content

    var body: some View {
        JunoCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                Text(eyebrow)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                content
            }
        }
    }
}

/// A row inside a tile that pushes a subpage. Deliberately not a `NavigationLink`
/// in a `List`: these tiles are not list rows, and the chevron has to sit at the
/// card's own trailing edge.
private struct JunoSettingsLink: View {
    let title: LocalizedStringKey
    let value: Text?
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.junoAccent)
                    .frame(width: 22)
                Text(title).font(.system(size: 16))
                Spacer(minLength: 6)
                if let value {
                    value.font(.callout).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct JunoMobileSettingsSections: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: (NativeSettingsPatch) -> Void
    @State private var instructionsDraft = ""
    @State private var editingInstructions = false

    private static let accents = ["coral", "teal", "violet", "amber", "sage"]
    private static let personalities = [
        "default", "concise", "encouraging", "socratic", "formal", "nerdy",
    ]
    private static let responseLanguages = [
        "auto", "English", "Spanish", "French", "German", "Portuguese",
        "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic",
    ]
    private static let interfaceLocales = [
        "auto", "en", "es", "fr", "de", "it", "pt-BR", "nl", "pl", "tr", "ru",
        "uk", "sv", "id", "vi", "th", "hi", "ja", "ko", "zh-Hans", "zh-Hant",
    ]

    var body: some View {
        JunoSettingsTile(eyebrow: "Appearance") {
            Picker("Theme", selection: binding(\.theme) { NativeSettingsPatch(theme: $0) }) {
                Text("System").tag(NativeThemePreference.system)
                Text("Light").tag(NativeThemePreference.light)
                Text("Dark").tag(NativeThemePreference.dark)
            }
            .pickerStyle(.segmented)
            .disabled(disabled)
            row("Accent") {
                Picker("Accent", selection: binding(\.accent) { NativeSettingsPatch(accent: $0) }) {
                    ForEach(knownOrCurrent(Self.accents, current: settings.accent), id: \.self) {
                        Text($0.capitalized).tag($0)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
        }

        JunoSettingsTile(eyebrow: "Default model") {
            row("Model") {
                Picker(
                    "Default model",
                    selection: binding(\.defaultModel) { NativeSettingsPatch(defaultModel: $0) }
                ) {
                    if !modelCatalog.contains(where: { $0.id == settings.defaultModel }) {
                        Text(junoDisplayModelName(settings.defaultModel))
                            .tag(settings.defaultModel)
                    }
                    ForEach(modelCatalog) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
            if !modelCatalog.isEmpty {
                NavigationLink {
                    JunoMobileFavoriteModelsView(
                        settings: settings,
                        modelCatalog: modelCatalog,
                        disabled: disabled,
                        update: update
                    )
                } label: {
                    HStack {
                        Text("Favorite models").font(.system(size: 16))
                        Spacer(minLength: 6)
                        Text("\(settings.favoriteModels.count)")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }

        JunoSettingsTile(eyebrow: "Response style") {
            row("Personality") {
                Picker(
                    "Personality",
                    selection: binding(\.personality) { NativeSettingsPatch(personality: $0) }
                ) {
                    ForEach(
                        knownOrCurrent(Self.personalities, current: settings.personality),
                        id: \.self
                    ) {
                        Text($0.capitalized).tag($0)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
        }

        JunoSettingsTile(eyebrow: "Custom instructions") {
            if editingInstructions {
                TextEditor(text: $instructionsDraft)
                    .font(.callout)
                    .frame(minHeight: 110)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.junoCanvas)
                    )
                    .accessibilityLabel("Custom instructions")
                HStack {
                    Button("Cancel") { editingInstructions = false }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Save") {
                        editingInstructions = false
                        update(NativeSettingsPatch(customInstructions: instructionsDraft))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(disabled)
                }
                .font(.system(size: 15, weight: .medium))
            } else {
                Text(settings.customInstructions.isEmpty
                    ? "Nothing set — tell Juno how you'd like it to answer."
                    : settings.customInstructions)
                    .font(.callout)
                    .foregroundStyle(settings.customInstructions.isEmpty ? .secondary : .primary)
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Edit instructions") {
                    instructionsDraft = settings.customInstructions
                    editingInstructions = true
                }
                .buttonStyle(.plain)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.junoAccent)
                .disabled(disabled)
                .accessibilityIdentifier("juno.mobile.settings-edit-instructions")
            }
        }

        JunoSettingsTile(eyebrow: "Language") {
            row("Responses") {
                Picker(
                    "Response language",
                    selection: binding(\.responseLanguage) {
                        NativeSettingsPatch(responseLanguage: $0)
                    }
                ) {
                    ForEach(
                        knownOrCurrent(Self.responseLanguages, current: settings.responseLanguage),
                        id: \.self
                    ) {
                        Text($0 == "auto" ? "Auto-detect" : $0).tag($0)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
            row("Interface") {
                Picker(
                    "Interface language",
                    selection: binding(\.interfaceLocale) {
                        NativeSettingsPatch(interfaceLocale: $0)
                    }
                ) {
                    ForEach(
                        knownOrCurrent(Self.interfaceLocales, current: settings.interfaceLocale),
                        id: \.self
                    ) { locale in
                        Text(locale == "auto"
                            ? "Match system"
                            : (Locale.current.localizedString(forIdentifier: locale) ?? locale))
                            .tag(locale)
                    }
                }
                .labelsHidden()
                .disabled(disabled)
            }
        }

        JunoSettingsTile(eyebrow: "Email notifications") {
            Toggle(
                "Budget alerts",
                isOn: binding(\.emailBudgetAlerts) {
                    NativeSettingsPatch(emailBudgetAlerts: $0)
                }
            )
            .tint(Color.junoAccent)
            .disabled(disabled)
            Toggle(
                "Weekly digest",
                isOn: binding(\.emailWeeklyDigest) {
                    NativeSettingsPatch(emailWeeklyDigest: $0)
                }
            )
            .tint(Color.junoAccent)
            .disabled(disabled)
        }
    }

    /// A label and its control on one line. Pickers inside a card have no `Form`
    /// to supply that layout, and a bare `Picker` with a visible label collapses
    /// to a menu button with the label lost inside it.
    private func row<Control: View>(
        _ label: LocalizedStringKey, @ViewBuilder control: () -> Control
    ) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 16))
            Spacer(minLength: 6)
            control()
        }
    }

    /// Keeps an unknown stored value selectable so the picker never silently
    /// rewrites a preference this build does not recognize.
    private func knownOrCurrent(_ known: [String], current: String) -> [String] {
        known.contains(current) ? known : [current] + known
    }

    private func binding<Value: Equatable>(
        _ keyPath: KeyPath<NativeAccountSettings, Value>,
        patch: @escaping (Value) -> NativeSettingsPatch
    ) -> Binding<Value> {
        Binding(
            get: { settings[keyPath: keyPath] },
            set: { value in
                guard value != settings[keyPath: keyPath] else { return }
                update(patch(value))
            }
        )
    }
}

private struct JunoMobileFavoriteModelsView: View {
    let settings: NativeAccountSettings
    let modelCatalog: [NativeChatModelOption]
    let disabled: Bool
    let update: (NativeSettingsPatch) -> Void

    var body: some View {
        List(modelCatalog) { option in
            Toggle(isOn: favoriteBinding(option.id)) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.displayName)
                    Text(option.providerName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(disabled)
        }
        .navigationTitle("Favorite models")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func favoriteBinding(_ modelID: String) -> Binding<Bool> {
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

private struct JunoMobileMemoryView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    @State private var newMemory = ""
    @State private var editMemoryID: String?
    @State private var editContent = ""
    @State private var deleteMemoryID: String?
    @State private var showingEraseAll = false

    var body: some View {
        List {
            Section {
                Text("Juno remembers helpful details from your chats so it can give you better, more personalized answers.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section {
                if let summary = model.summary, !summary.content.isEmpty {
                    Text(summary.content)
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                    HStack(spacing: 6) {
                        Text("Updated \(summary.updatedAt.formatted(.relative(presentation: .named)))")
                        Spacer(minLength: 0)
                        Text("^[\(summary.entryCount) memory](inflect: true)")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                } else {
                    Text("No summary yet — Juno builds this from what it learns in chats.")
                        .foregroundStyle(.secondary)
                }
            } header: {
                HStack {
                    Text("Memory summary")
                    Spacer()
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        if model.isRefreshingSummary {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(model.isRefreshingSummary)
                    .accessibilityLabel("Refresh summary")
                }
            }

            Section {
                Toggle("Pause memory", isOn: Binding(
                    get: { !(model.settings?.memoryEnabled ?? true) },
                    set: { paused in
                        Task {
                            await model.updateSettings(NativeSettingsPatch(memoryEnabled: !paused))
                        }
                    }
                ))
                .disabled(model.isMutating || model.settings == nil)
                .accessibilityIdentifier("juno.mobile.memory-pause")
            } footer: {
                Text("While paused, Juno won't save new details from your chats. Existing memories are kept.")
            }

            Section {
                DisclosureGroup {
                    HStack {
                        TextField("Something Juno should remember", text: $newMemory)
                            .onSubmit(addMemory)
                            .accessibilityIdentifier("juno.mobile.settings-memory-input")
                        Button("Add", action: addMemory)
                            .disabled(
                                model.isMutating
                                    || newMemory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            )
                            .accessibilityIdentifier("juno.mobile.settings-memory-add")
                    }
                    if model.memories.isEmpty {
                        Text("No saved memories yet. Facts Juno learns in chats appear here.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(model.memories) { memory in
                            memoryRow(memory)
                        }
                    }
                } label: {
                    HStack {
                        Text("Manage edits")
                        Spacer()
                        Text("^[\(model.memories.count) memory](inflect: true)")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Button("Reset memory…", role: .destructive) {
                    showingEraseAll = true
                }
                .disabled(model.isErasing || model.isMutating)
                .accessibilityIdentifier("juno.mobile.settings-memory-erase")
                if model.isErasing {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Erasing memory…").foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("Resetting permanently removes every saved fact and the summary, and old chats are not re-learned.")
            }
        }
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .accessibilityIdentifier("juno.mobile.memory-list")
        .alert("Edit memory", isPresented: Binding(
            get: { editMemoryID != nil },
            set: { if !$0 { editMemoryID = nil } }
        )) {
            TextField("Memory", text: $editContent)
            Button("Cancel", role: .cancel) { editMemoryID = nil }
            Button("Save") {
                guard let id = editMemoryID else { return }
                editMemoryID = nil
                Task { await model.updateMemory(id: id, content: editContent) }
            }
        }
        .alert("Delete this memory?", isPresented: Binding(
            get: { deleteMemoryID != nil },
            set: { if !$0 { deleteMemoryID = nil } }
        )) {
            Button("Cancel", role: .cancel) { deleteMemoryID = nil }
            Button("Delete", role: .destructive) {
                guard let id = deleteMemoryID else { return }
                deleteMemoryID = nil
                Task { await model.deleteMemory(id: id) }
            }
        } message: {
            Text("Juno will no longer use this fact in conversations.")
        }
        .alert("Erase all memory?", isPresented: $showingEraseAll) {
            Button("Cancel", role: .cancel) {}
            Button("Erase everything", role: .destructive) {
                Task { await model.eraseAllMemory() }
            }
        } message: {
            Text("This permanently removes every saved fact and the consolidated summary. This cannot be undone.")
        }
    }

    private func memoryRow(_ memory: NativeMemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(memory.content)
            HStack(spacing: 8) {
                Image(systemName: memory.kind == .suppression
                    ? "hand.raised" : "brain.head.profile")
                    .accessibilityHidden(true)
                Text(memory.source == .manual ? "Added by you" : "Learned from chats")
                Text(memory.createdAt, style: .date)
                if memory.isPending {
                    Label("Waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", role: .destructive) {
                deleteMemoryID = memory.id
            }
            .disabled(model.isMutating || model.isErasing)
            Button("Edit") {
                editContent = memory.content
                editMemoryID = memory.id
            }
            .disabled(model.isMutating || model.isErasing)
        }
        .contextMenu {
            Button("Edit") {
                editContent = memory.content
                editMemoryID = memory.id
            }
            Button("Delete", role: .destructive) {
                deleteMemoryID = memory.id
            }
        }
    }

    private func addMemory() {
        let content = newMemory
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        newMemory = ""
        Task { await model.createMemory(content: content) }
    }
}
