import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

/// **Memory**, as a stock inset-grouped list.
///
/// The order is the argument, as on the web: what Alevr knows about you (the
/// consolidated profile, split into the sections the server writes), then the
/// individual facts one level down — the substrate, not the answer — then the
/// projects it keeps memory for, then privacy, with the destructive control
/// last and alone.
struct JunoMobileMemoryView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    /// The memory routes the synced store does not carry: suggested skills,
    /// each fact's provenance, and clearing one project. Nil where the app
    /// could not be configured; those parts are then absent.
    var requestSender: (any NativeAuthenticatedRequestSending)? = nil
    var accountID: AccountID? = nil
    /// Opens the chat a fact was learned in.
    var openConversation: ((String) -> Void)? = nil

    @State private var page: NativeMemoryPageModel?
    @State private var clearingProject: NativeMemoryScope?
    @State private var notice: NativeMemoryNotice?
    @State private var showingEraseAll = false
    /// The export file, rebuilt only when what goes in it changes.
    @State private var exportURL: URL?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var paused: Bool { !(model.settings?.memoryEnabled ?? true) }

    var body: some View {
        List {
            if let notice {
                Section {
                    Label(
                        verbatim: notice.title,
                        icon: notice.tone == .error ? .triangleAlert : .check
                    )
                    .foregroundStyle(notice.tone == .error ? Color.red : Color.secondary)
                }
            }
            summarySection
            if let page, !page.skillCandidates.isEmpty {
                JunoMobileSuggestedSkills(page: page) { show($0) }
            }
            factsSection
            projectMemorySection
            privacySection
        }
        .listStyle(.insetGrouped)
        .junoGroupedPage()
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if model.isRefreshingSummary {
                    ProgressView()
                } else {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        JunoIconView(.refresh, size: 18)
                            .accessibilityLabel("Rebuild summary")
                    }
                    .accessibilityIdentifier("juno.mobile.memory-rebuild")
                }
            }
        }
        .refreshable {
            await model.refresh()
            await page?.reload()
            await page?.loadSkillCandidates()
        }
        .task { await startPage() }
        .confirmationDialog(
            clearingProject.map { "Clear \($0.label)?" } ?? "",
            isPresented: Binding(get: { clearingProject != nil }, set: { if !$0 { clearingProject = nil } }),
            titleVisibility: .visible,
            presenting: clearingProject
        ) { project in
            Button("Clear project memory", role: .destructive) {
                clearingProject = nil
                guard let id = project.id, let page else { return }
                Task { show(await page.clearProject(id)) }
            }
            .contentShape(.rect)
            Button("Cancel", role: .cancel) { clearingProject = nil }
                .contentShape(.rect)
        } message: { _ in
            Text("This permanently deletes what Alevr remembers inside this project and its summary. Your account-wide memory, your chats, and other members’ memory stay as they are.")
        }
        .task(id: exportSignature) { rebuildExport() }
        .accessibilityIdentifier("juno.mobile.memory-list")
        .alert("Erase all memory?", isPresented: $showingEraseAll) {
            Button("Cancel", role: .cancel) {}
            Button("Erase everything", role: .destructive) {
                Task { await model.eraseAllMemory() }
            }
            .accessibilityIdentifier("juno.mobile.settings-memory-erase-confirm")
        } message: {
            Text("This permanently removes every saved fact and the consolidated summary. This cannot be undone.")
        }
    }

    // MARK: - Summary

    /// The consolidated profile, as the server's own sections.
    private var summarySection: some View {
        Section {
            if model.isRefreshingSummary, model.summary == nil {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Consolidating what Alevr has learned…")
                        .foregroundStyle(.secondary)
                }
            } else if let summary = model.summary, !summary.content.isEmpty {
                ForEach(JunoMemorySummarySection.parse(summary.content)) { section in
                    VStack(alignment: .leading, spacing: 4) {
                        if let title = section.title {
                            Text(title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        JunoMarkdownText(section.body)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                }
            } else {
                Text(
                    paused
                        ? "Memory is paused, so nothing new is being learned."
                        : "Nothing yet — Alevr builds this from what it learns in chats."
                )
                .foregroundStyle(.secondary)
            }
        } header: {
            Text("What Alevr knows about you")
        } footer: {
            if let summaryFootnote { Text(summaryFootnote) }
        }
    }

    /// Always says where the profile comes from — before there is one, that is the
    /// only thing that explains why it is empty.
    private var summaryFootnote: String? {
        guard let summary = model.summary, !summary.content.isEmpty else {
            return paused ? nil : "Alevr writes this from your chats once there is enough to say."
        }
        let count = summary.entryCount
        let facts = "\(count) fact\(count == 1 ? "" : "s")"
        let when = summary.updatedAt.formatted(.relative(presentation: .named))
        return "Built from \(facts), updated \(when)."
    }

    // MARK: - Facts

    private var factsSection: some View {
        Section {
            NavigationLink {
                JunoMobileMemoryFactsView(
                    model: model,
                    serverFact: { id in page?.facts.first { $0.id == id } },
                    openConversation: openConversation
                )
            } label: {
                LabeledContent("Individual facts") {
                    Text("\(model.memories.count)")
                }
            }
            .accessibilityIdentifier("juno.mobile.memory-facts-toggle")
        } footer: {
            Text("Each fact is a line Alevr can quote. The summary above is built from them.")
        }
        .accessibilityIdentifier("juno.mobile.memory-facts")
    }

    // MARK: - Server-side parts

    private func startPage() async {
        guard page == nil, let requestSender, let accountID else { return }
        let page = NativeMemoryPageModel(client: NativeMemoryClient(sender: requestSender))
        page.start(for: accountID)
        self.page = page
        await page.loadIfNeeded()
    }

    private func show(_ next: NativeMemoryNotice?) {
        guard let next else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { notice = next }
        Task {
            try? await Task.sleep(for: .seconds(4))
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                if notice == next { notice = nil }
            }
        }
    }

    /// The projects Alevr keeps memory for, each with its own clear.
    @ViewBuilder
    private var projectMemorySection: some View {
        let projects = page.map {
            NativeMemoryPresentation.scopes(facts: $0.facts, projectSummaries: $0.projectSummaries)
                .filter { $0.id != nil }
        } ?? []
        if !projects.isEmpty {
            Section {
                ForEach(projects, id: \.id) { project in
                    HStack {
                        LabeledContent(project.label) {
                            Text(project.count == 1 ? "1 memory" : "\(project.count) memories")
                        }
                        if page?.clearingProjectID == project.id {
                            ProgressView().padding(.leading, 8)
                        } else {
                            Button("Clear", role: .destructive) { clearingProject = project }
                                .buttonStyle(.borderless)
                                .disabled(page?.clearingProjectID != nil)
                                .accessibilityLabel("Clear \(project.label) memory")
                                .padding(.leading, 8)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(.rect)
                        }
                    }
                }
            } header: {
                Text("Project memory")
            } footer: {
                Text("Only chats in a project use its memory, and they use nothing else Alevr remembers.")
            }
            .accessibilityIdentifier("juno.mobile.memory-projects")
        }
    }

    // MARK: - Privacy

    private var privacySection: some View {
        Section {
            Toggle(
                "Pause memory",
                isOn: Binding(
                    get: { paused },
                    set: { newValue in
                        Task {
                            await model.updateSettings(
                                NativeSettingsPatch(memoryEnabled: !newValue)
                            )
                        }
                    }
                )
            )
            .disabled(model.isMutating || model.settings == nil)
            .accessibilityIdentifier("juno.mobile.memory-pause")

            if let exportURL {
                ShareLink(item: exportURL, preview: SharePreview("alevr-memory.json")) {
                    Text("Export memory")
                }
                .accessibilityIdentifier("juno.mobile.memory-export")
            }

            if model.isErasing {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Erasing memory…").foregroundStyle(.secondary)
                }
            } else {
                Button("Reset memory…", role: .destructive) { showingEraseAll = true }
                    .disabled(model.isMutating)
                    .accessibilityIdentifier("juno.mobile.settings-memory-erase")
            }
        } header: {
            Text("Privacy")
        } footer: {
            Text("Pausing keeps what Alevr already knows and stops it learning more. Memory is never used to train models. Resetting removes every saved fact and the summary.")
        }
    }

    /// What the exported file is made of. Cheap to compute and stable across the
    /// re-renders a keystroke causes, so the file is only rebuilt when it changes.
    private var exportSignature: String {
        "\(model.memories.count)|\(model.summary?.updatedAt.timeIntervalSince1970 ?? 0)"
    }

    private func rebuildExport() {
        exportURL = makeExport()
    }

    /// The export as a file on disk, or nil when there is nothing to export.
    /// Suppressions are exported under their own key, exactly as the web does.
    private func makeExport() -> URL? {
        guard !model.memories.isEmpty || model.summary != nil else { return nil }
        let facts = model.memories.filter { $0.kind != .suppression }
        let suppressions = model.memories.filter { $0.kind == .suppression }
        let document: [String: Any] = [
            "exportedAt": ISO8601DateFormatter().string(from: Date()),
            "summary": model.summary?.content ?? NSNull(),
            "facts": facts.map {
                [
                    "content": $0.content,
                    "source": $0.source.rawValue,
                    "createdAt": ISO8601DateFormatter().string(from: $0.createdAt),
                ]
            },
            "neverRemember": suppressions.map(\.content),
        ]
        guard let data = try? JSONSerialization.data(
            withJSONObject: document, options: [.prettyPrinted, .sortedKeys]
        ) else { return nil }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("alevr-memory.json")
        guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }
}

// MARK: - Individual facts

/// Every saved fact, grouped by where it came from — "you told Alevr this"
/// and "Alevr worked this out" are different claims, and only one is worth
/// auditing. Tap to edit, swipe to delete, long-press for the chat it came from.
private struct JunoMobileMemoryFactsView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>
    let serverFact: (String) -> NativeMemoryFact?
    var openConversation: ((String) -> Void)?

    @State private var newMemory = ""
    @State private var editMemoryID: String?
    @State private var editContent = ""
    @State private var deleteMemoryID: String?
    @State private var query = ""

    /// How many facts it takes before a filter is worth its place.
    private static let searchThreshold = 12

    private var matching: [NativeMemoryEntry] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return model.memories }
        return model.memories.filter {
            $0.content.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Add something Alevr should remember", text: $newMemory, axis: .vertical)
                        .onSubmit(addMemory)
                        .accessibilityIdentifier("juno.mobile.settings-memory-input")
                    if !newMemory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button("Add", action: addMemory)
                            .buttonStyle(.borderless)
                            .fontWeight(.semibold)
                            .disabled(model.isMutating)
                            .accessibilityIdentifier("juno.mobile.settings-memory-add")
                            .contentShape(.rect)
                    }
                }
            }

            if model.memories.isEmpty {
                Section {
                    Text("Nothing saved yet. What Alevr learns in chats appears here.")
                        .foregroundStyle(.secondary)
                }
            } else if matching.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                group("Added by you", matching.filter { $0.source == .manual })
                group("Learned from chats", matching.filter { $0.source != .manual })
            }
        }
        .listStyle(.insetGrouped)
        .junoGroupedPage()
        .navigationTitle("Individual facts")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(JunoMobileMemorySearch(enabled: model.memories.count >= Self.searchThreshold, query: $query))
        .sheet(isPresented: Binding(get: { editMemoryID != nil }, set: { if !$0 { editMemoryID = nil } })) {
            editSheet
        }
        .alert("Delete this memory?", isPresented: Binding(
            get: { deleteMemoryID != nil },
            set: { if !$0 { deleteMemoryID = nil } }
        )) {
            Button("Cancel", role: .cancel) { deleteMemoryID = nil }
                .contentShape(.rect)
            Button("Delete", role: .destructive) {
                guard let id = deleteMemoryID else { return }
                deleteMemoryID = nil
                Task { await model.deleteMemory(id: id) }
            }
            .contentShape(.rect)
        } message: {
            Text("Alevr will no longer use this fact in conversations.")
        }
    }

    @ViewBuilder
    private func group(_ title: LocalizedStringKey, _ entries: [NativeMemoryEntry]) -> some View {
        if !entries.isEmpty {
            Section(title) {
                ForEach(entries) { memory in
                    row(memory)
                }
            }
        }
    }

    private func row(_ memory: NativeMemoryEntry) -> some View {
        Button {
            editContent = memory.content
            editMemoryID = memory.id
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(memory.content)
                    .foregroundStyle(Color.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Group {
                    if memory.kind == .suppression {
                        Text("Never remember")
                    } else if memory.isPending {
                        Text("\(memory.createdAt, style: .date), waiting to sync")
                    } else {
                        Text(memory.createdAt, style: .date)
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                if let provenance = serverFact(memory.id).flatMap({ NativeMemoryProvenance.line(for: $0) }) {
                    Text(provenance)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .contentShape(.rect)
        }
        .disabled(model.isMutating || model.isErasing)
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) { deleteMemoryID = memory.id }
        }
        .contextMenu {
            Button {
                editContent = memory.content
                editMemoryID = memory.id
            } label: {
                Label("Edit", icon: .pencil)
            }
            if let chatID = serverFact(memory.id)?.sourceChatID, let openConversation {
                Button { openConversation(chatID) } label: { Label("Open the chat it came from", icon: .message) }
            }
            Button(role: .destructive) { deleteMemoryID = memory.id } label: { Label("Delete", icon: .trash) }
        }
    }

    /// Editing one fact, full width and multi-line.
    private var editSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Memory", text: $editContent, axis: .vertical)
                        .lineLimit(3...10)
                        .accessibilityIdentifier("juno.mobile.memory-edit-field")
                } footer: {
                    Text("Write it as a short, durable statement — Alevr quotes these back as facts.")
                }
            }
            .navigationTitle("Edit memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("action.cancel") { editMemoryID = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let id = editMemoryID else { return }
                        editMemoryID = nil
                        Task { await model.updateMemory(id: id, content: editContent) }
                    }
                    .disabled(editContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func addMemory() {
        let content = newMemory
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        newMemory = ""
        Task { await model.createMemory(content: content) }
    }
}

/// `.searchable` only once scrolling is the alternative.
private struct JunoMobileMemorySearch: ViewModifier {
    let enabled: Bool
    @Binding var query: String

    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $query, prompt: "Search memories")
        } else {
            content
        }
    }
}

/// One `## `-headed section of the consolidated summary.
///
/// The server writes the profile as Markdown with a fixed section order — Work
/// context, Personal context, Preferences, Projects & goals, Top of mind (see
/// `src/lib/memory.ts`). Splitting on those headings is what lets the card render
/// a profile instead of a wall; text before the first heading is real content the
/// model wrote, so it is kept as an untitled lead rather than discarded.
struct JunoMemorySummarySection: Identifiable, Equatable {
    let id: Int
    let title: String?
    let body: String

    static func parse(_ markdown: String) -> [JunoMemorySummarySection] {
        var sections: [JunoMemorySummarySection] = []
        var title: String?
        var lines: [String] = []

        func flush() {
            let body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty || title != nil else { return }
            sections.append(
                JunoMemorySummarySection(id: sections.count, title: title, body: body)
            )
            lines = []
        }

        for line in markdown.components(separatedBy: "\n") {
            if let heading = headingText(line) {
                flush()
                title = heading
            } else {
                lines.append(line)
            }
        }
        flush()

        // A summary with no headings at all is still a summary; render it whole
        // rather than showing nothing.
        if sections.isEmpty {
            let body = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty {
                sections = [JunoMemorySummarySection(id: 0, title: nil, body: body)]
            }
        }
        return sections
    }

    /// `#`…`###` followed by whitespace and a title.
    private static func headingText(_ line: String) -> String? {
        var rest = Substring(line).drop(while: { $0 == " " })
        let hashes = rest.prefix(while: { $0 == "#" })
        guard (1...3).contains(hashes.count) else { return nil }
        rest = rest.dropFirst(hashes.count)
        guard rest.first?.isWhitespace == true else { return nil }
        let title = rest.trimmingCharacters(in: .whitespaces)
        return title.isEmpty ? nil : title
    }
}

// MARK: - Suggested skills

/// Methods the person's own runs repeated, proposed as skills
/// (`skill-candidates.tsx`). Absent when there is nothing to propose.
private struct JunoMobileSuggestedSkills: View {
    let page: NativeMemoryPageModel
    let post: (NativeMemoryNotice?) -> Void

    var body: some View {
        Section {
            ForEach(page.skillCandidates) { candidate in
                row(candidate)
            }
        } header: {
            Text("Suggested skills")
        } footer: {
            Text("From your own runs. A skill is how Alevr does something; memory stays what it knows.")
        }
        .accessibilityIdentifier("juno.mobile.memory-skill-candidates")
    }

    private func row(_ candidate: NativeSkillCandidate) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(candidate.title)
                .font(.body.weight(.semibold))
            Text(candidate.detailLine())
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(Array(candidate.examples.prefix(2).enumerated()), id: \.offset) { _, example in
                Text("“\(example)”")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            actions(candidate)
                .padding(.top, 4)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func actions(_ candidate: NativeSkillCandidate) -> some View {
        let busy = page.busyCandidateIDs.contains(candidate.id)
        if page.madeSkills[candidate.id] != nil {
            Label("Added to your skills", icon: .check)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            HStack(spacing: 16) {
                Button {
                    Task { post(await page.decide(candidate, .accept)) }
                } label: {
                    if busy {
                        ProgressView()
                    } else {
                        Text("Add as skill")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(busy)
                .accessibilityIdentifier("juno.mobile.memory-skill-accept")
                .contentShape(.rect)
                Button("Dismiss") {
                    Task { post(await page.decide(candidate, .dismiss)) }
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .disabled(busy)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
        }
    }
}
