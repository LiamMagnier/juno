import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UniformTypeIdentifiers

struct DesktopDestinationView: View {
    @Binding var destination: DesktopDestination
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Bindable var conversationModel: NativeConversationModel<SQLiteAccountRepository>
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    @Binding var requestedProjectID: String?

    var body: some View {
        switch destination {
        case .chat:
            DesktopConversationView(
                model: conversationModel,
                attachmentModel: configuration.attachmentModel,
                profileName: session.profile.name,
                configuration: configuration,
                session: session,
                draftProjectID: $draftProjectID,
                draftPrompt: $draftPrompt
            )
        case .search:
            if let model = configuration.searchModel {
                DesktopSearchScreen(
                    model: model,
                    openConversation: openConversation,
                    // The run in flight in Chat, so the screen a reader uses to
                    // find things can say "Juno is reading twelve pages about
                    // this right now" instead of "No results".
                    researchActivity: conversationModel.researchActivity,
                    // Only offered when there is a conversation to return to.
                    // A run always belongs to one, but a reader can reach Search
                    // from a draft that has not been created yet, and a link to
                    // nowhere is worse than no link.
                    openResearchRun: conversationModel.selectedConversationID.map { id in
                        { openConversation(id) }
                    }
                )
            } else {
                unavailable("Search", "The encrypted search index is unavailable.")
            }
        case .projects:
            if let model = configuration.projectModel {
                DesktopProjectsScreen(
                    model: model,
                    conversationModel: conversationModel,
                    configuration: configuration,
                    session: session,
                    openConversation: openConversation,
                    startConversation: startConversation,
                    requestedProjectID: $requestedProjectID
                )
            } else {
                unavailable("Projects", "The synchronized project store is unavailable.")
            }
        case .library:
            if let model = configuration.libraryModel {
                DesktopLibraryScreen(
                    model: model,
                    documentIndex: configuration.documentIndexModel,
                    accountID: session.profile.id,
                    attachmentClient: configuration.requestSender.map {
                        NativeAttachmentAPIClient(sender: $0)
                    },
                    generateClient: configuration.generateClient,
                    modelCatalog: conversationModel.modelCatalog,
                    openConversation: openConversation
                )
            } else {
                unavailable("Library", "The authenticated file library is unavailable.")
            }
        case .artifacts:
            if let model = configuration.artifactModel {
                DesktopArtifactsScreen(model: model)
            } else {
                unavailable("Artifacts", "The synchronized artifact store is unavailable.")
            }
        case .connections:
            if let model = configuration.connectorModel {
                DesktopConnectionsScreen(model: model)
            } else {
                unavailable("Connections", "The connector service is unavailable.")
            }
        case .tasks:
            if let model = configuration.scheduledTaskModel {
                DesktopTasksScreen(
                    model: model,
                    modelOptions: conversationModel.selectableModels,
                    openConversation: openConversation
                )
            } else {
                unavailable("Tasks", "The scheduled-task service is unavailable.")
            }
        case .design:
            // The artifact store is the hard dependency, not the transport: the
            // page lists the designs this account already has, and those are
            // projected from the encrypted database. A request sender is what
            // *starting* one needs, and its absence disables the presets with a
            // reason rather than emptying the page.
            if let model = configuration.artifactModel {
                DesktopDesignScreen(
                    model: model,
                    accountID: session.profile.id,
                    requestSender: configuration.requestSender,
                    syncModel: configuration.syncModel
                )
            } else {
                unavailable("Design", "The synchronized artifact store is unavailable.")
            }
        case .usage:
            DesktopUsageScreen(
                session: session,
                requestSender: configuration.requestSender,
                modelCatalog: conversationModel.selectableModels
            )
        case .settings:
            if let model = configuration.memorySettingsModel {
                DesktopSettingsModal(
                    model: model,
                    authModel: configuration.authModel,
                    session: session,
                    configuration: configuration,
                    accountDataClient: configuration.accountDataClient,
                    shareClient: configuration.shareClient,
                    modelCatalog: conversationModel.selectableModels,
                    avatarData: configuration.avatarModel?.imageData,
                    syncModel: configuration.syncModel,
                    outbox: configuration.outbox,
                    openUsage: { destination = .usage },
                    codeHostModel: configuration.codeHostModel,
                    workHostModel: configuration.workHostModel,
                    learningModel: configuration.memoryLearningModel,
                    onDismiss: { destination = .chat }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(JunoSpace.regular)
            } else {
                unavailable("Settings", "Account settings could not be loaded.")
            }
        }
    }

    private func openConversation(_ id: String) {
        draftProjectID = nil
        conversationModel.isDraftingNewConversation = false
        conversationModel.selectedConversationID = id
        destination = .chat
    }

    private func startConversation(in projectID: String, prompt: String?) {
        draftProjectID = projectID
        draftPrompt = prompt
        conversationModel.isDraftingNewConversation = true
        conversationModel.selectedConversationID = nil
        destination = .chat
    }

    private func unavailable(_ title: String, _ description: String) -> some View {
        ContentUnavailableView(
            title,
            systemImage: "exclamationmark.triangle",
            description: Text(description)
        )
    }
}

/// **What Juno remembers** — the account's memory corpus, as its own screen.
///
/// This was four sections inside the Memory tab of the settings window, which
/// put a corpus editor — a table, a text field, a delete confirmation, an
/// exporter and an erase-everything button — in the same surface as a theme
/// picker. The web has had it at `/memory` since the beginning and the phone
/// pushes it as its own page; this is the Mac's version of that, and settings is
/// left with the one thing that genuinely is a preference: the switch.
///
/// The `Table` survived the move on purpose. A grid of cards would have looked
/// more like the rest of the app and lost every affordance that makes a list of
/// forty facts editable: multi-selection, ⌘⌫, the context menu, and columns you
/// can compare down. Provenance is a column and not a badge because "you told
/// Juno this" and "Juno worked this out" are different claims, and only one of
/// them is worth auditing.
struct DesktopMemoryScreen: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    /// Returns to whatever opened this. Nil where the screen is the whole
    /// surface — a sidebar destination would pass nothing, because the sidebar
    /// *is* the way back and a second control saying so is clutter.
    var back: (() -> Void)?

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
    private var hasContent: Bool {
        !model.memories.isEmpty || model.summary != nil
    }

    var body: some View {
        JunoDetailPage(maxWidth: DesktopMemoryMetrics.readingWidth) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                JunoSettingsTile("Summary") { summaryTile }
                JunoSettingsTile("Saved facts") { factsTile }
                JunoSettingsTile("Your memory") { privacyTile }
            }
        }
        .navigationTitle("Memory")
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
        .accessibilityIdentifier("juno.desktop.memory")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            // The web's `ArrowLeft` ghost button, in the page rather than in the
            // toolbar: the toolbar belongs to the window, and this screen is a
            // page inside it.
            if let back {
                Button(action: back) {
                    Image(systemName: "chevron.left")
                        // Scaled with body text, not frozen at 13pt: the glyph
                        // sits beside the page heading and should grow with the
                        // page under Dynamic Type. The 24pt frame is the hit
                        // target, not the glyph, and stays fixed.
                        .junoFont(size: 13, relativeTo: .body, weight: .semibold)
                        .frame(width: 24, height: 24)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .keyboardShortcut("[", modifiers: .command)
                .help("Back to settings (⌘[)")
                .accessibilityLabel("Back to settings")
                .accessibilityIdentifier("juno.desktop.memory.back")
            }
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Memory")
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .textCase(.uppercase)
                Text("What Juno remembers")
                    .font(JunoSerif.pageHeading())
                Text("Distilled from your chats, projects and connections, and used as context whenever you talk to Juno. Always yours to edit, in plain language.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Summary

    /// The consolidated profile, as prose. It is the only long-form reading on
    /// this screen, so it stays selectable.
    @ViewBuilder
    private var summaryTile: some View {
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
            .fixedSize(horizontal: false, vertical: true)
        }

        HStack(spacing: JunoSpace.cozy) {
            Text(summaryFootnote)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: JunoSpace.snug)
            Button("Refresh") { Task { await model.refresh() } }
                .disabled(model.isRefreshingSummary)
                .accessibilityIdentifier("juno.desktop.memory.refresh-summary")
        }
    }

    private var summaryFootnote: String {
        guard let summary = model.summary, !summary.content.isEmpty else {
            return isPaused
                ? "Nothing new is being learned while memory is paused."
                : "Written from the facts below, once there are enough of them."
        }
        let facts = summary.entryCount == 1 ? "1 fact" : "\(summary.entryCount) facts"
        return "Built from \(facts) · updated \(summary.updatedAt.formatted(date: .abbreviated, time: .shortened))"
    }

    // MARK: - Facts

    @ViewBuilder
    private var factsTile: some View {
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
                                .junoSecondaryInk()
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
                        .junoSecondaryInk()
                }
                .width(min: 110, ideal: 130)
                TableColumn("Added") { memory in
                    Text(memory.createdAt.formatted(date: .abbreviated, time: .omitted))
                        .junoSecondaryInk()
                }
                .width(min: 90, ideal: 100)
            }
            .frame(height: DesktopMemoryMetrics.tableHeight)
            // The table sits *on* the tile, not in a well of its own: its own
            // grey fill and its zebra striping are two more surfaces than this
            // page has any use for, and the striped empty rows below the last
            // fact read as content that failed to load.
            .scrollContentBackground(.hidden)
            .alternatingRowBackgrounds(.disabled)
            // Selecting a fact should not light a row of prose up in the app
            // accent — macOS resolves a focused table selection to it unless the
            // view says otherwise, and the web's selected row is a warm grey.
            .junoSidebarSelectionTint()
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
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
            .accessibilityIdentifier("juno.desktop.memory.table")
        }

        HStack(spacing: JunoSpace.snug) {
            TextField("Something Juno should remember", text: $newMemory)
                .onSubmit(addMemory)
                .accessibilityIdentifier("juno.desktop.memory.field")
            Button("Add", action: addMemory)
                .disabled(model.isMutating || trimmedNewMemory.isEmpty)
                .accessibilityIdentifier("juno.desktop.memory.add")
            // The same two actions the context menu offers, as buttons, because
            // a context menu is unreachable without a pointer.
            Button("Edit…") {
                guard let memory = singleMemory(in: selection) else { return }
                beginEditing(memory)
            }
            .disabled(model.isMutating || singleMemory(in: selection) == nil)
            .accessibilityIdentifier("juno.desktop.memory.edit")
            Button("Remove") { pendingDeletion = selection }
                .disabled(model.isMutating || selection.isEmpty)
                .help("Delete the selected memories (⌘⌫)")
                .keyboardShortcut(.delete, modifiers: .command)
                .accessibilityIdentifier("juno.desktop.memory.remove")
        }

        Text("Each of these is a line Juno can quote. The summary above is written from them.")
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)
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
                .junoPanel(cornerRadius: JunoRadius.well)
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )
                .accessibilityLabel("Memory")
                .accessibilityIdentifier("juno.desktop.memory.edit-field")
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
                .accessibilityIdentifier("juno.desktop.memory.edit-save")
            }
        }
        .padding(JunoSpace.roomy)
        .frame(width: DesktopSettingsMetrics.confirmWidth)
        // Sheet contract: the warm ground inside the content, the platter left to
        // the system. `.fitted` honours the explicit width above.
        .junoSheetSurface(.fitted)
    }

    // MARK: - Privacy

    @ViewBuilder
    private var privacyTile: some View {
        Toggle(isOn: memoryBinding) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Remember details from chats")
                    .junoRowLabel()
                Text("Pausing stops Juno from saving or using memories. Private chats are never remembered, and memory is never used to train models.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .tint(Color.junoAccent)
        .disabled(model.isMutating || model.settings == nil)
        .accessibilityLabel("Remember details from chats")
        .accessibilityIdentifier("juno.desktop.memory.enabled")

        Divider()

        HStack(spacing: JunoSpace.snug) {
            // Written from the memories already loaded, in the same shape the
            // web's Export button produces — no request, so it works offline and
            // cannot report a success it did not have.
            Button("Export memory…", action: exportMemory)
                .disabled(!hasContent)
                .accessibilityIdentifier("juno.desktop.memory.export")
                // Attached to the button, not to the screen: the delete dialog
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
                .disabled(model.isErasing || !hasContent)
                .accessibilityIdentifier("juno.desktop.memory.erase")
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

            Spacer(minLength: 0)
        }

        if let exportError {
            Label(exportError, systemImage: "exclamationmark.circle")
                .junoCaption()
                .foregroundStyle(Color.junoCaution)
                .fixedSize(horizontal: false, vertical: true)
        }

        Text("Export writes the summary, every fact and the never-remember list to a JSON file. Erasing removes all of it. Old chats are not re-learned, and it cannot be undone.")
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Actions

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
        // can tell "no summary yet" from "this file predates summaries".
        // Unwrapped deliberately — an `Optional` inside the dictionary is not a
        // JSON value and `JSONSerialization` would throw on it.
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
}

private enum DesktopMemoryMetrics {
    /// Narrower than the settings grid: this page is one column of prose and one
    /// table, not a two-column grid of tiles.
    static let readingWidth: CGFloat = 760
    /// The facts table. Taller than the 210pt it had as an embedded form row —
    /// it is the reason this screen exists, so it gets the room.
    static let tableHeight: CGFloat = 320
}
