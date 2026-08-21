import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// **Memory**, rebuilt on the website's own structure.
///
/// It was an `.insetGrouped` `List` of eight sections — a Settings pane that
/// happened to be about memory. The web is three stacked blocks in one column,
/// and the order is the argument:
///
/// 1. **What Juno knows about you** — the consolidated profile, split into the
///    sections the server writes (`## Work context`, `## Preferences`, …). This
///    leads because it is the only thing most people came to read.
/// 2. **The individual facts** — collapsed. They are the substrate the summary is
///    built from, and a list of forty one-line facts is a worse answer to "what
///    does it know?" than five paragraphs of prose.
/// 3. **Privacy** — pause, and a two-step reset, kept together and last so the
///    destructive control is nowhere near the reading.
///
/// The web edits memory by *asking in plain language* against `/api/memory/edit`.
/// That route has no native client, so the individual facts stay directly
/// editable here — the same capability, reached the way this client can.
struct JunoMobileMemoryView: View {
    @Bindable var model: NativeMemorySettingsModel<SQLiteAccountRepository>

    @State private var newMemory = ""
    @State private var editMemoryID: String?
    @State private var editContent = ""
    @State private var deleteMemoryID: String?
    @State private var showingFacts = false
    @State private var resetArmed = false
    @State private var showingEraseAll = false
    /// Filters the facts list. Empty is the resting state — see ``matchingFacts``.
    @State private var factQuery = ""
    /// The export file, rebuilt only when what goes in it changes.
    @State private var exportURL: URL?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var paused: Bool { !(model.settings?.memoryEnabled ?? true) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                summaryCard
                factsSection
                privacySection
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.hairline)
            .padding(.bottom, JunoSpace.region)
            .frame(maxWidth: 768)
            .frame(maxWidth: .infinity)
        }
        .junoScreenCanvas()
        // Blank, deliberately. The page states its own name in the serif heading
        // two lines below the bar, and an inline bar title repeated it verbatim
        // on every screen of this app that has a heading.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .task(id: exportSignature) { rebuildExport() }
        .accessibilityIdentifier("juno.mobile.memory-list")
        // A sheet with a real text editor, not an `alert` with a `TextField`.
        // A memory is a sentence — "The user prefers short explanations with code
        // examples." — and the alert gave it a single line that scrolled
        // horizontally, with no way to see the whole thing being edited.
        .sheet(isPresented: Binding(
            get: { editMemoryID != nil },
            set: { if !$0 { editMemoryID = nil } }
        )) {
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

    // MARK: - Header

    /// The web's own heading, wording included: a small semibold eyebrow naming
    /// the section, then **what the page is about** in the serif. "Memory" alone
    /// names a feature; "What Juno remembers" states the question the reader
    /// came to answer.
    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("Memory")
                .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                .foregroundStyle(Color.junoMutedForeground)
                .accessibilityHidden(true)
            Text("What Juno remembers")
                .junoPageHeading(compact: true)
                .accessibilityAddTraits(.isHeader)
            Text("Distilled from your chats and used as context whenever you talk to Juno. Always yours to edit.")
                .junoFont(size: 15, relativeTo: .subheadline)
                .lineSpacing(3)
                .foregroundStyle(Color.junoMutedForeground)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, JunoSpace.tight)
    }

    /// Editing one fact, full width and multi-line.
    private var editSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                TextEditor(text: $editContent)
                    .junoFont(size: 16, relativeTo: .callout)
                    .lineSpacing(2)
                    .scrollContentBackground(.hidden)
                    .padding(JunoSpace.cozy)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                            .fill(Color.junoSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                            .strokeBorder(Color.junoHairline, lineWidth: 1)
                    )
                    .frame(minHeight: 130)
                    .accessibilityLabel("Memory")
                    .accessibilityIdentifier("juno.mobile.memory-edit-field")
                Text("Write it as a short, durable statement — Juno quotes these back as facts.")
                    .junoFont(size: 12, relativeTo: .caption)
                    .foregroundStyle(Color.junoMutedForeground)
                Spacer(minLength: 0)
            }
            .padding(JunoSpace.regular)
            .junoScreenCanvas()
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
                    .disabled(
                        editContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
            }
        }
        .presentationDetents([.medium])
        .tint(Color.junoAccent)
    }

    // MARK: - Summary

    /// The consolidated profile. Rendered as the server's own sections rather than
    /// as one wall of Markdown: it writes `## Work context`, `## Preferences` and
    /// so on, and honouring those headings is the difference between a profile and
    /// a paragraph.
    private var summaryCard: some View {
        JunoMobileWorkspaceSection(
            title: "What Juno knows about you",
            actionTitle: model.isRefreshingSummary ? nil : "Rebuild",
            actionImage: "arrow.clockwise",
            action: model.isRefreshingSummary ? nil : { Task { await model.refresh() } },
            footnote: summaryFootnote
        ) {
            JunoCard {
                if model.isRefreshingSummary, model.summary == nil {
                    working("Consolidating what Juno has learned…")
                } else if let summary = model.summary, !summary.content.isEmpty {
                    VStack(alignment: .leading, spacing: JunoSpace.regular) {
                        ForEach(JunoMemorySummarySection.parse(summary.content)) { section in
                            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                                if let title = section.title {
                                    Text(title)
                                        .font(
                                            JunoSerif.font(
                                                size: 15, relativeTo: .subheadline, face: .medium
                                            )
                                        )
                                        .foregroundStyle(Color.junoMutedForeground)
                                }
                                JunoMarkdownText(section.body)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                } else {
                    JunoMobileEmptyLine(
                        text: paused
                            ? "Memory is paused, so nothing new is being learned."
                            : "Nothing yet — Juno builds this from what it learns in chats."
                    )
                }
            }
        }
    }

    /// Always says where the profile comes from — before there is one, that is the
    /// only thing on the card that explains why it is empty.
    private var summaryFootnote: String? {
        guard let summary = model.summary, !summary.content.isEmpty else {
            return paused
                ? "Nothing new is being learned while memory is paused."
                : "Juno writes this from your chats. It appears once there is enough to say."
        }
        let count = summary.entryCount
        let facts = "\(count) fact\(count == 1 ? "" : "s")"
        let when = summary.updatedAt.formatted(.relative(presentation: .named))
        return "Built from \(facts) · updated \(when)"
    }

    private func working(_ text: String) -> some View {
        HStack(spacing: JunoSpace.snug) {
            ProgressView().controlSize(.small)
            Text(text)
                .junoFont(size: 14, relativeTo: .subheadline)
                .foregroundStyle(Color.junoMutedForeground)
        }
    }

    // MARK: - Facts

    /// Collapsed by default, and labelled with its own count so the reader knows
    /// what opening it costs. This is the substrate, not the answer.
    private var factsSection: some View {
        JunoMobileWorkspaceSection(
            title: "Individual facts",
            footnote: showingFacts
                ? "Each of these is a line Juno can quote. The summary above is built from them."
                : nil
        ) {
            JunoCard(padding: 0) {
                VStack(spacing: 0) {
                    // The disclosure lives *inside* the card so the section has
                    // presence when it is shut. As a bare label with a chevron on
                    // the canvas it read as a stray line of text rather than as
                    // something with content behind it.
                    Button {
                        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                            showingFacts.toggle()
                        }
                    } label: {
                        HStack(spacing: JunoSpace.snug) {
                            Text(factsSummaryLine)
                                .junoFont(size: 15, relativeTo: .subheadline)
                                .foregroundStyle(Color.primary.opacity(0.82))
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.down")
                                .junoFont(size: 11, relativeTo: .caption2, weight: .bold)
                                .foregroundStyle(Color.junoMutedForeground)
                                .rotationEffect(.degrees(showingFacts ? 180 : 0))
                        }
                        .padding(.horizontal, JunoSpace.regular)
                        .padding(.vertical, JunoSpace.cozy)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(factsSummaryLine)
                    .accessibilityIdentifier("juno.mobile.memory-facts-toggle")

                    if showingFacts {
                        Divider().padding(.leading, JunoSpace.regular)
                        addRow
                        if model.memories.isEmpty {
                            Divider().padding(.leading, JunoSpace.regular)
                            JunoMobileEmptyLine(
                                text: "Nothing saved yet. What Juno learns in chats appears here."
                            )
                            .padding(.horizontal, JunoSpace.regular)
                            .padding(.vertical, JunoSpace.regular)
                        } else {
                            // The filter earns its place only once scrolling is
                            // the alternative. Below the threshold the whole list
                            // is on screen and a search field is a control that
                            // does nothing but take a row.
                            if model.memories.count >= Self.searchThreshold {
                                Divider().padding(.leading, JunoSpace.regular)
                                searchRow
                            }
                            if matchingFacts.isEmpty {
                                Divider().padding(.leading, JunoSpace.regular)
                                JunoMobileEmptyLine(
                                    text: "No memory matches “\(factQuery.trimmingCharacters(in: .whitespaces))”."
                                )
                                .padding(.horizontal, JunoSpace.regular)
                                .padding(.vertical, JunoSpace.regular)
                            } else {
                                // Grouped by where they came from, because "you
                                // told Juno this" and "Juno worked this out" are
                                // different claims and only one of them is worth
                                // auditing.
                                factGroup(
                                    "Added by you",
                                    matchingFacts.filter { $0.source == .manual }
                                )
                                factGroup(
                                    "Learned from chats",
                                    matchingFacts.filter { $0.source != .manual }
                                )
                            }
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier("juno.mobile.memory-facts")
    }

    /// How many facts it takes before a filter is worth more than the row it
    /// occupies. Twelve is roughly two screens on a phone.
    private static let searchThreshold = 12

    private var matchingFacts: [NativeMemoryEntry] {
        let needle = factQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return model.memories }
        return model.memories.filter {
            $0.content.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    private var searchRow: some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: "magnifyingglass")
                .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 18)
            TextField("Filter memories", text: $factQuery)
                .junoFont(size: 15, relativeTo: .subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("juno.mobile.memory-search")
            if !factQuery.isEmpty {
                Button {
                    factQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .junoFont(size: 15, relativeTo: .subheadline)
                        .foregroundStyle(Color.junoMutedForeground)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear filter")
                .contentShape(.rect)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    /// States the count in words rather than as a bare number beside a label —
    /// the row has to say what opening it will show. Once a filter is on, it
    /// states what is being *shown* instead, so the number under the reader's
    /// eyes and the number in the header never disagree.
    private var factsSummaryLine: String {
        let total = model.memories.count
        guard total > 0 else { return "No individual facts yet" }
        let shown = matchingFacts.count
        if showingFacts, shown != total {
            return "\(shown) of \(total) facts"
        }
        return "\(total) individual fact\(total == 1 ? "" : "s")"
    }

    @ViewBuilder
    private func factGroup(_ title: String, _ entries: [NativeMemoryEntry]) -> some View {
        if !entries.isEmpty {
            Divider().padding(.leading, JunoSpace.regular)
            Text(title)
                .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
                .kerning(0.4)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.cozy)
                .padding(.bottom, JunoSpace.hairline)
            ForEach(entries) { memory in
                factRow(memory)
            }
        }
    }

    private var addRow: some View {
        HStack(spacing: JunoSpace.cozy) {
            Image(systemName: "plus")
                .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 18)
            TextField("Something Juno should remember", text: $newMemory)
                .junoFont(size: 15, relativeTo: .subheadline)
                .onSubmit(addMemory)
                .accessibilityIdentifier("juno.mobile.settings-memory-input")
            if !newMemory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button("Add", action: addMemory)
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccent)
                    .disabled(model.isMutating)
                    .accessibilityIdentifier("juno.mobile.settings-memory-add")
                .contentShape(.rect)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    private func factRow(_ memory: NativeMemoryEntry) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            // A suppression is not a fact — it is an instruction to *stop* using
            // one, and it reads as a contradiction unless it is marked.
            Image(systemName: memory.kind == .suppression ? "hand.raised" : "circle.fill")
                .junoFont(size: memory.kind == .suppression ? 12 : 5, relativeTo: .caption)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 18, height: 20)

            VStack(alignment: .leading, spacing: 3) {
                Text(memory.content)
                    .junoFont(size: 15, relativeTo: .subheadline)
                    .lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: JunoSpace.tight) {
                    Text(memory.source == .manual ? "Added by you" : "Learned from chats")
                    Text("·")
                    Text(memory.createdAt, style: .date)
                    if memory.isPending {
                        Text("· waiting to sync")
                    }
                }
                .junoFont(size: 12, relativeTo: .caption)
                .foregroundStyle(Color.junoMutedForeground)
            }

            Menu {
                Button("Edit") {
                    editContent = memory.content
                    editMemoryID = memory.id
                }
                Button("Delete", role: .destructive) { deleteMemoryID = memory.id }
            } label: {
                Image(systemName: "ellipsis")
                    .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(model.isMutating || model.isErasing)
            .accessibilityLabel("Actions for this memory")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Privacy

    private var privacySection: some View {
        JunoMobileWorkspaceSection(
            title: "Privacy",
            footnote: "Memory is never used to train models. Resetting removes every saved fact and the summary, and old chats are not re-learned."
        ) {
            JunoCard(padding: 0) {
                VStack(spacing: 0) {
                    Toggle(isOn: Binding(
                        get: { paused },
                        set: { newValue in
                            Task {
                                await model.updateSettings(
                                    NativeSettingsPatch(memoryEnabled: !newValue)
                                )
                            }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Pause memory")
                                .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                            Text("Keeps what Juno already knows; stops it learning more.")
                                .junoFont(size: 12, relativeTo: .caption)
                                .foregroundStyle(Color.junoMutedForeground)
                        }
                    }
                    .disabled(model.isMutating || model.settings == nil)
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.cozy)
                    .accessibilityIdentifier("juno.mobile.memory-pause")

                    Divider().padding(.leading, JunoSpace.regular)

                    exportRow

                    Divider().padding(.leading, JunoSpace.regular)

                    resetRow
                }
            }
        }
    }

    /// Take it with you. The web's privacy strip offers this and the app did not,
    /// which made "always yours" a claim with no button behind it.
    ///
    /// Suppressions are exported under their own key rather than mixed into the
    /// facts, exactly as the web does: a suppression is a block-list entry — a
    /// thing Juno has been told *never* to remember — and filing it as a memory
    /// would invert its meaning in the exported file.
    @ViewBuilder
    private var exportRow: some View {
        if let exportURL {
            ShareLink(
                item: exportURL,
                preview: SharePreview("juno-memory.json")
            ) {
                HStack(spacing: JunoSpace.cozy) {
                    Text("Export memory")
                        .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 6)
                    Image(systemName: "square.and.arrow.up")
                        .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                        .foregroundStyle(Color.junoMutedForeground)
                }
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.cozy)
                .contentShape(Rectangle())
            }
            // A `ShareLink` tints its whole label with the accent, exactly as a
            // `Menu` does — which made Export the only coral row on a card whose
            // other two are ink and red. The tint has to be set on the link; a
            // foreground style inside the label cannot override it.
            .tint(Color.primary)
            .accessibilityIdentifier("juno.mobile.memory-export")
        }
    }

    /// Rebuilds the export file. Called from `.task(id:)` on what the file is
    /// made of, **not** computed inline in the row.
    ///
    /// As a computed property this ran a JSON serialize and a disk write on every
    /// body evaluation of this screen — once per keystroke in the filter field,
    /// once per disclosure toggle. The file only changes when the memories or the
    /// summary do, so that is what it is keyed on.
    /// What the exported file is made of. Cheap to compute and stable across the
    /// re-renders that a filter keystroke causes.
    private var exportSignature: String {
        "\(model.memories.count)|\(model.summary?.updatedAt.timeIntervalSince1970 ?? 0)"
    }

    private func rebuildExport() {
        exportURL = makeExport()
    }

    /// The export as a file on disk, or nil when there is nothing to export.
    ///
    /// Written to a temporary file rather than shared as a `String`: sharing a
    /// string hands other apps a wall of JSON as *text*, where a `.json` file
    /// arrives in Files and Mail as the document it is.
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
            .appendingPathComponent("juno-memory.json")
        guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }

    /// Two steps, and the first one expires. A single destructive button that
    /// erases everything on one tap is a mis-tap away from unrecoverable; a
    /// confirmation that stays armed forever is the same button with extra work.
    private var resetRow: some View {
        HStack(spacing: JunoSpace.cozy) {
            if model.isErasing {
                working("Erasing memory…")
            } else if resetArmed {
                Text("Erase everything Juno remembers?")
                    .junoFont(size: 14, relativeTo: .subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Cancel") {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        resetArmed = false
                    }
                }
                .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoMutedForeground)
                .contentShape(.rect)
                Button("Erase") { showingEraseAll = true }
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoDanger)
                    .accessibilityIdentifier("juno.mobile.settings-memory-erase-confirm")
                .contentShape(.rect)
            } else {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        resetArmed = true
                    }
                    // Disarms itself, so a tap made and thought better of does not
                    // leave a live destructive control on the screen.
                    Task {
                        try? await Task.sleep(for: .seconds(4))
                        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                            resetArmed = false
                        }
                    }
                } label: {
                    Text("Reset memory…")
                        .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                        .foregroundStyle(Color.junoDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.isErasing || model.isMutating)
                .accessibilityIdentifier("juno.mobile.settings-memory-erase")
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    private func addMemory() {
        let content = newMemory
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        newMemory = ""
        Task { await model.createMemory(content: content) }
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
