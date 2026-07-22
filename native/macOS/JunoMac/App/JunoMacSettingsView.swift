import JunoChatKit
import JunoStorage
import SwiftUI

/// Real account settings and memory management projected from the encrypted
/// local database, with durable optimistic mutations and conflict resolution.
struct JunoMacSettingsView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .idle, .loading:
                    ProgressView("Loading settings…")
                case .failed where model.settings == nil && model.memories.isEmpty:
                    ContentUnavailableView {
                        Label("Settings unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(model.lastErrorDescription ?? "Try again.")
                    } actions: {
                        Button("Retry") { Task { await model.refresh() } }
                    }
                default:
                    settingsForm
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isMutating || model.isErasing)
                    .accessibilityIdentifier("juno.mac.settings-refresh")
                }
            }
            .safeAreaInset(edge: .bottom) {
                if model.conflictedMutationCount > 0 {
                    conflictBanner
                } else if model.phase == .offline || model.lastErrorDescription != nil {
                    statusBanner
                }
            }
        }
        .accessibilityIdentifier("juno.mac.settings")
    }

    @ViewBuilder
    private var settingsForm: some View {
        Form {
            if let settings = model.settings {
                JunoSettingsSections(
                    settings: settings,
                    modelCatalog: conversationModel?.selectableModels ?? [],
                    disabled: model.isMutating,
                    update: { patch in Task { await model.updateSettings(patch) } }
                )
            } else {
                Section("Preferences") {
                    Label(
                        "Account settings have not finished synchronizing.",
                        systemImage: "clock.arrow.circlepath"
                    )
                    .foregroundStyle(.secondary)
                }
            }
            JunoMemorySections(model: model)
        }
        .formStyle(.grouped)
    }

    private var conflictBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
            Text("Memory or settings changed on another device.")
                .lineLimit(2)
            Spacer()
            Button("Keep mine") {
                Task { await model.resolveConflicts(keepLocalChanges: true) }
            }
            Button("Use server") {
                Task { await model.resolveConflicts(keepLocalChanges: false) }
            }
        }
        .font(.caption)
        .padding(10)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mac.settings-conflict")
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
        .accessibilityIdentifier("juno.mac.settings-status")
    }
}

/// Settings controls shared by shape between sections; every edit becomes one
/// idempotent optimistic `settings.update` patch.
private struct JunoSettingsSections: View {
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
        Section("Appearance") {
            Picker("Theme", selection: binding(\.theme) { NativeSettingsPatch(theme: $0) }) {
                Text("System").tag(NativeThemePreference.system)
                Text("Light").tag(NativeThemePreference.light)
                Text("Dark").tag(NativeThemePreference.dark)
            }
            .pickerStyle(.segmented)
            .disabled(disabled)
            Picker("Accent", selection: binding(\.accent) { NativeSettingsPatch(accent: $0) }) {
                ForEach(knownOrCurrent(Self.accents, current: settings.accent), id: \.self) {
                    Text($0.capitalized).tag($0)
                }
            }
            .disabled(disabled)
        }

        Section("Model") {
            Picker(
                "Default model",
                selection: binding(\.defaultModel) { NativeSettingsPatch(defaultModel: $0) }
            ) {
                if !modelCatalog.contains(where: { $0.id == settings.defaultModel }) {
                    Text(settings.defaultModel).tag(settings.defaultModel)
                }
                ForEach(modelCatalog) { option in
                    Text("\(option.displayName) — \(option.providerName)").tag(option.id)
                }
            }
            .disabled(disabled)
            if !modelCatalog.isEmpty {
                DisclosureGroup("Favorite models (\(settings.favoriteModels.count))") {
                    ForEach(modelCatalog) { option in
                        Toggle(
                            option.displayName,
                            isOn: favoriteBinding(option.id)
                        )
                        .disabled(disabled)
                    }
                }
            }
        }

        Section("Personalization") {
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
            .disabled(disabled)
            VStack(alignment: .leading, spacing: 6) {
                Text("Custom instructions")
                if editingInstructions {
                    TextEditor(text: $instructionsDraft)
                        .font(.body)
                        .frame(minHeight: 90)
                        .accessibilityLabel("Custom instructions")
                    HStack {
                        Spacer()
                        Button("Cancel") { editingInstructions = false }
                        Button("Save") {
                            editingInstructions = false
                            update(NativeSettingsPatch(customInstructions: instructionsDraft))
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(disabled)
                    }
                } else {
                    Text(settings.customInstructions.isEmpty
                        ? "No custom instructions" : settings.customInstructions)
                        .foregroundStyle(settings.customInstructions.isEmpty
                            ? .secondary : .primary)
                        .lineLimit(4)
                    Button("Edit instructions") {
                        instructionsDraft = settings.customInstructions
                        editingInstructions = true
                    }
                    .disabled(disabled)
                    .accessibilityIdentifier("juno.mac.settings-edit-instructions")
                }
            }
        }

        Section("Language") {
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
            .disabled(disabled)
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
            .disabled(disabled)
        }

        Section("Email") {
            Toggle(
                "Budget alerts",
                isOn: binding(\.emailBudgetAlerts) {
                    NativeSettingsPatch(emailBudgetAlerts: $0)
                }
            )
            .disabled(disabled)
            Toggle(
                "Weekly digest",
                isOn: binding(\.emailWeeklyDigest) {
                    NativeSettingsPatch(emailWeeklyDigest: $0)
                }
            )
            .disabled(disabled)
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

private struct JunoMemorySections: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    @State private var newMemory = ""
    @State private var editMemoryID: String?
    @State private var editContent = ""
    @State private var deleteMemoryID: String?
    @State private var showingEraseAll = false

    var body: some View {
        Section("Memory") {
            Toggle(
                "Remember details from chats",
                isOn: Binding(
                    get: { model.settings?.memoryEnabled ?? true },
                    set: { value in
                        Task {
                            await model.updateSettings(
                                NativeSettingsPatch(memoryEnabled: value)
                            )
                        }
                    }
                )
            )
            .disabled(model.isMutating || model.settings == nil)
            .accessibilityIdentifier("juno.mac.settings-memory-toggle")

            if let summary = model.summary,
                !summary.content.isEmpty
            {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("What Juno remembers")
                        Spacer()
                        if model.isRefreshingSummary {
                            ProgressView().controlSize(.small)
                        }
                        Text("\(summary.entryCount) memories")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                    Text(summary.content)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            HStack {
                TextField("Add something Juno should remember", text: $newMemory)
                    .onSubmit(addMemory)
                    .accessibilityIdentifier("juno.mac.settings-memory-input")
                Button("Add", action: addMemory)
                    .disabled(
                        model.isMutating
                            || newMemory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    .accessibilityIdentifier("juno.mac.settings-memory-add")
            }

            if model.memories.isEmpty {
                Text("No saved memories yet. Facts Juno learns in chats appear here.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.memories) { memory in
                    memoryRow(memory)
                }
            }
        }

        Section {
            Button("Erase all memory…", role: .destructive) {
                showingEraseAll = true
            }
            .disabled(model.isErasing || model.isMutating)
            .accessibilityIdentifier("juno.mac.settings-memory-erase")
            if model.isErasing {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Erasing memory…").foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Danger zone")
        } footer: {
            Text("Erasing memory permanently removes every saved fact and the summary, and old chats are not re-learned.")
        }
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
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: memory.kind == .suppression
                ? "hand.raised" : "brain.head.profile")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(memory.content)
                HStack(spacing: 8) {
                    Text(memory.source == .manual ? "Added by you" : "Learned from chats")
                    Text(memory.createdAt, style: .date)
                    if memory.isPending {
                        Label("Waiting to sync", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Menu {
                Button("Edit") {
                    editContent = memory.content
                    editMemoryID = memory.id
                }
                Button("Delete", role: .destructive) {
                    deleteMemoryID = memory.id
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .disabled(model.isMutating || model.isErasing)
            .accessibilityLabel("Memory actions")
        }
        .accessibilityElement(children: .combine)
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
