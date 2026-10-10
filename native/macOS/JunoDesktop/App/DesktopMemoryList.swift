import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Everything Juno remembers, as one list (`memory-list.tsx`): grouped by
/// topic as plain headings with every section open, or by date when the
/// reader asks for newest first; a long section shows its first five rows and
/// unfolds the rest in place; retired facts wait under "No longer used".
///
/// Search is local — the whole list is already here — and matches a fact by
/// its words, its topic and its project.
struct DesktopMemoryList: View {
    let page: NativeMemoryPageModel
    /// Facts in scope, with any pending removal already taken out.
    let facts: [NativeMemoryFact]
    @Binding var query: String
    @Binding var grouping: NativeMemoryGrouping
    let enabled: Bool
    let project: DesktopMemoryProject?
    let projects: @MainActor () -> [DesktopMemoryProject]
    /// Opens a fact's source chat; nil where the page cannot reach Chat.
    var openChat: ((String) -> Void)? = nil
    let post: (NativeMemoryNotice?) -> Void

    @State private var adding = false
    @State private var expanded: Set<String> = []
    @State private var showsRetired = false
    @State private var editingID: String?
    @State private var dealt = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var matching: [NativeMemoryFact] { facts.filter { NativeMemoryPresentation.matches($0, query: query) } }
    private var active: [NativeMemoryFact] { matching.filter { !$0.isRetired } }
    private var retired: [NativeMemoryFact] {
        matching.filter(\.isRetired).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar
            if adding, enabled {
                DesktopMemoryAddForm(project: project) { content in
                    let notice = await page.add(content, projectID: project?.id)
                    post(notice)
                    if notice.tone != .error {
                        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { adding = false }
                        return true
                    }
                    return false
                } cancel: {
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { adding = false }
                }
                .padding(.top, JunoSpace.cozy)
                .transition(.opacity)
            }
            content
                .padding(.top, JunoSpace.regular)
        }
        .onAppear {
            // Dealt once, on the list's first appearance; a search or a
            // regrouping afterwards is not a reveal.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { dealt = true }
        }
    }

    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.snug) {
                DesktopSectionHeading(title: "Memories", count: facts.filter { !$0.isRetired }.count)
                Spacer(minLength: JunoSpace.snug)
                controls
            }
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                DesktopSectionHeading(title: "Memories", count: facts.filter { !$0.isRetired }.count)
                HStack(spacing: JunoSpace.snug) { controls }
            }
        }
    }

    @ViewBuilder
    private var controls: some View {
        JunoPageSearchField(text: $query, prompt: "Search memories", accessibilityIdentifier: "juno.desktop.memory.search")
            .frame(maxWidth: DesktopMemoryListMetrics.searchWidth)
        JunoPageMenu(
            options: [
                JunoPageMenuOption(NativeMemoryGrouping.topic, "By topic", menuTitle: "By Topic"),
                JunoPageMenuOption(NativeMemoryGrouping.newest, "Newest first", menuTitle: "Newest First"),
            ],
            selection: $grouping,
            accessibilityLabel: "Group memories"
        )
        Button {
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { adding.toggle() }
        } label: {
            Label {
                Text("Add")
            } icon: {
                JunoIconView(.plus, size: 13)
                    .rotationEffect(.degrees(adding ? 45 : 0))
            }
        }
        .buttonStyle(.junoGlass)
        .tint(nil)
        // The controls row's 32pt, beside the search field and the menu, at
        // the control radius rather than `.large`'s capsule.
        .controlSize(.large)
        .buttonBorderShape(.roundedRectangle(radius: JunoRadius.control))
        .disabled(!enabled)
        .help(enabled ? "New memory" : "Turn memory on to add to it")
        .accessibilityLabel("New memory")
        .accessibilityValue(adding ? "Open" : "Closed")
        .contentShape(.rect)
    }

    @ViewBuilder
    private var content: some View {
        if facts.isEmpty {
            JunoEmptyState(
                title: project == nil ? "No memories yet" : "Nothing remembered in this project yet",
                message: project == nil
                    ? "Alevr fills this in as you chat. You can also add something yourself."
                    : "Alevr keeps what it learns in this project’s chats here, apart from everything else.",
                icon: .layers,
                size: .panel
            )
        } else if searching, matching.isEmpty {
            JunoEmptyState(
                title: "Nothing matches that",
                message: "Try a shorter word, or search by topic or project name.",
                icon: .search,
                actionLabel: "Clear search",
                action: { query = "" },
                size: .panel
            )
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                let sections = NativeMemoryPresentation.sections(active, grouping: grouping)
                ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                    sectionView(section)
                        .desktopDealIn(index, dealt: dealt)
                }
                if !retired.isEmpty {
                    retiredView
                }
            }
        }
    }

    private func sectionView(_ section: NativeMemorySection) -> some View {
        let foldable = !searching && section.rows.count - DesktopMemoryListMetrics.previewRows >= DesktopMemoryListMetrics.minimumFolded
        let open = !foldable || expanded.contains(section.id)
        let shown = open ? section.rows : Array(section.rows.prefix(DesktopMemoryListMetrics.previewRows))
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            // The grouped form's section header: the topic's mark, its name
            // in the header weight, the count quiet beside it.
            HStack(spacing: JunoSpace.snug) {
                if let topic = section.topic {
                    JunoIconView(DesktopMemoryTopicIcon.icon(for: topic), size: 14)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .accessibilityHidden(true)
                }
                Text(section.label)
                    .junoType(JunoType.ui.weight(.semibold))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(section.rows.count, format: .number)
                    .junoType(.ui)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.horizontal, JunoSpace.cozy)
            DesktopGroupedCard {
                rows(shown)
                if foldable {
                    DesktopRowDivider().padding(.horizontal, JunoSpace.cozy)
                    Button {
                        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                            if expanded.contains(section.id) { expanded.remove(section.id) } else { expanded.insert(section.id) }
                        }
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            if open {
                                Text("Show fewer")
                            } else {
                                Text("Show all \(Text(section.rows.count, format: .number))")
                            }
                            JunoIconView(open ? .chevronUp : .chevronDown, size: 12)
                            Spacer(minLength: 0)
                        }
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.horizontal, JunoSpace.cozy)
                        .frame(minHeight: 36)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// The section's rows inside its grouped card, on inset hairlines, as
    /// the grouped form divides its rows.
    private func rows(_ facts: [NativeMemoryFact]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(facts.enumerated()), id: \.element.id) { index, fact in
                if index > 0 { DesktopRowDivider() }
                DesktopMemoryRow(
                    fact: fact,
                    busy: page.busyIDs.contains(fact.id),
                    showProject: project == nil,
                    isEditing: editingID == fact.id,
                    projects: projects,
                    openChat: openChat,
                    beginEdit: { editingID = fact.id },
                    endEdit: { editingID = nil },
                    save: { content in
                        if content == fact.content { return true }
                        let notice = await page.edit(fact.id, content: content)
                        post(notice)
                        return notice?.tone != .error
                    },
                    remove: { kind in post(page.remove(fact, kind: kind)) },
                    move: { project in Task { post(await page.move(fact, toProject: project?.id)) } }
                )
            }
        }
        // The row's own hover fill reaches 12 outside its text; in the card
        // the text sits on the card's 12pt inset and the fill meets its
        // edges.
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.hairline)
    }

    private var retiredView: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { showsRetired.toggle() }
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    JunoIconView(.chevronRight, size: 12)
                        .rotationEffect(.degrees(showsRetired || searching ? 90 : 0))
                    Text("No longer used")
                    Text(retired.count, format: .number).monospacedDigit()
                }
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.horizontal, JunoSpace.cozy)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(showsRetired ? "Expanded" : "Collapsed")
            if showsRetired || searching {
                Text("Replaced by something newer, contradicted, expired, or forgotten at your request. Alevr doesn’t use these.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, JunoSpace.cozy)
                DesktopGroupedCard {
                    rows(retired)
                }
            }
        }
    }
}

private enum DesktopMemoryListMetrics {
    static let previewRows = 5
    static let minimumFolded = 3
    static let searchWidth: CGFloat = 240
}

/// One mark per memory topic (`memory-icons.tsx`): the drawing the web files
/// each category under, and the generic stack for anything else.
enum DesktopMemoryTopicIcon {
    static func icon(for topic: String) -> JunoIcon {
        switch topic {
        case "identity": .fingerprint
        case "preferences": .sliders
        case "goals": .target
        case "studies": .graduationCap
        case "workflows": .braces
        case "projects": .projects
        case "relationships": .users
        case "temporary": .tasks
        case "suppression": .eyeOff
        default: .layers
        }
    }
}

// MARK: - A row

/// One remembered fact: a line of text, one muted line about it, and a menu
/// (`entry-row.tsx`). Clicking the sentence edits it in place; the menu
/// carries everything else, Edit included for the keyboard.
struct DesktopMemoryRow: View {
    let fact: NativeMemoryFact
    let busy: Bool
    let showProject: Bool
    let isEditing: Bool
    let projects: @MainActor () -> [DesktopMemoryProject]
    let openChat: ((String) -> Void)?
    let beginEdit: () -> Void
    let endEdit: () -> Void
    let save: (String) async -> Bool
    let remove: (NativeMemoryRemovalKind) -> Void
    let move: (DesktopMemoryProject?) -> Void

    @State private var isHovering = false
    @State private var draft = ""
    @State private var saving = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        Group {
            if isEditing {
                editor
            } else {
                reading
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.close)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(isHovering && !isEditing ? Color.junoHover.opacity(0.6) : Color.clear)
        )
        .padding(.horizontal, -JunoSpace.cozy)
        .onHover { isHovering = $0 }
        .contextMenu { menuItems }
    }

    private var reading: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(fact.content)
                    .junoType(.ui)
                    .strikethrough(fact.isRetired, color: Color.junoSecondaryInk.opacity(0.4))
                    .foregroundStyle(fact.isRetired ? Color.junoSecondaryInk : Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                    .onTapGesture { if !busy { startEditing() } }
                meta
            }
            DesktopRowMenuButton(accessibilityLabel: "Memory options", help: "Options") { menuItems }
                .opacity(isHovering ? 1 : 0)
                .disabled(busy)
                .accessibilityHidden(!isHovering)
        }
    }

    /// One quiet line of plain text: no tokens, no capsules. A sensitive
    /// subject is the one attention state, said in the warning ink with its
    /// glyph and nothing around it.
    private var meta: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            if let sensitive = fact.sensitive {
                Label {
                    Text(NativeMemoryVocabulary.sensitiveLabel(sensitive))
                } icon: {
                    JunoIconView(.permission, size: 11)
                }
                .labelStyle(.titleAndIcon)
                .junoType(.caption)
                .foregroundStyle(Color.junoWarningInk)
                .help("A sensitive subject. Alevr only learns these on its own when you allow the topic in Settings.")
            }
            Text(metaLine)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .help(metaHelp)
            if let chatID = fact.sourceChatID, let openChat {
                Button("Open the chat it came from") { openChat(chatID) }
                    .buttonStyle(DesktopUnderlineLinkStyle(ink: Color.junoSecondaryInk))
                    .junoType(.caption)
                    .help(fact.sourceMessageID == nil ? "Open the chat Alevr learned this in" : "Open the chat and the message Alevr learned this from")
                    .accessibilityIdentifier("juno.desktop.memory.source-chat")
                    .contentShape(.rect)
            }
        }
    }

    private var metaHelp: String {
        if fact.isRetired { return fact.reason ?? NativeMemoryVocabulary.statusDescription(fact.status) ?? "" }
        return NativeMemoryProvenance.of(fact).map(\.explanation).joined(separator: " ")
    }

    /// Status (for a retired row) · where it came from · when, and the
    /// expiry of a temporary fact.
    private var metaLine: String {
        var parts: [String] = []
        if fact.isRetired, let status = NativeMemoryVocabulary.statusLabel(fact.status) { parts.append(status) }
        if let words = fact.learnedFrom {
            parts.append(words)
        } else {
            parts.append(fact.sourceChatID == nil ? "From your chats" : "From a chat")
        }
        parts.append(NativeMemoryPresentation.relativeTime(fact.createdAt))
        if let provenance = NativeMemoryProvenance.line(for: fact) { parts.append(provenance) }
        if showProject, fact.projectID != nil {
            parts.append("In \(fact.projectName ?? "one project")")
        }
        if let expiresAt = fact.expiresAt, !fact.isRetired {
            parts.append("Until \(expiresAt.formatted(.dateTime.day().month(.abbreviated)))")
        }
        return parts.joined(separator: " · ")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            TextField("Edit this memory", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .junoType(.ui)
                .lineLimit(1...6)
                .focused($fieldFocused)
                .onSubmit { Task { await commit() } }
                .onExitCommand { endEdit() }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(Color.junoCanvas)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoForeground.opacity(0.6), lineWidth: 1)
                )
                .accessibilityLabel("Edit this memory")
            HStack(spacing: JunoSpace.snug) {
                Text("Enter to save, Esc to cancel")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                Spacer()
                Button("Cancel", action: endEdit)
                    .buttonStyle(.borderless)
                    .tint(nil)
                    .contentShape(.rect)
                Button("Save") { Task { await commit() } }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .contentShape(.rect)
            }
            .controlSize(.small)
        }
        .onAppear {
            draft = fact.content
            fieldFocused = true
        }
    }

    @ViewBuilder
    private var menuItems: some View {
        Section {
            Button { startEditing() } label: { Label("Edit", image: JunoIcon.edit.assetName) }
            Menu {
                let others = projects().filter { $0.id != fact.projectID }
                if fact.projectID != nil {
                    Button { move(nil) } label: { Label("All Chats", image: JunoIcon.chats.assetName) }
                }
                if others.isEmpty {
                    Button("No Other Projects") {}.disabled(true)
                } else {
                    ForEach(others) { project in
                        Button { move(project) } label: { Label(project.name, image: JunoIcon.projects.assetName) }
                    }
                }
            } label: {
                Label("Move to Project", image: JunoIcon.folderLock.assetName)
            }
            if let chatID = fact.sourceChatID, let openChat {
                Button {
                    openChat(chatID)
                } label: { Label("Open the Chat It Came From", image: JunoIcon.message.assetName) }
            }
            Divider()
            if fact.status != "suppressed" {
                Button {
                    remove(.forget)
                } label: {
                    Label {
                        Text("Forget")
                        Text("Alevr won’t learn this again")
                    } icon: { Image(JunoIcon.eyeOff.assetName) }
                }
            }
            Button(role: .destructive) {
                remove(.delete)
            } label: {
                Label {
                    Text("Delete")
                    Text("Alevr may learn it again from its chat")
                } icon: { Image(JunoIcon.delete.assetName) }
            }
        }
    }

    private func startEditing() {
        beginEdit()
    }

    private func commit() async {
        let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, !saving else { return }
        saving = true
        let ok = await save(next)
        saving = false
        if ok { endEdit() } else { fieldFocused = true }
    }
}

// MARK: - Adding

/// "New memory": a field that grows with the sentence, what it will apply
/// to, and Cancel / Save.
struct DesktopMemoryAddForm: View {
    let project: DesktopMemoryProject?
    let save: (String) async -> Bool
    let cancel: () -> Void

    @State private var draft = ""
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            TextField(
                project == nil
                    ? "Something Alevr should know, like “I prefer metric units”"
                    : "Something true of this project, like “We cite in APA”",
                text: $draft,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .junoType(.ui)
            .lineLimit(1...5)
            .focused($focused)
            .onSubmit { Task { await commit() } }
            .onExitCommand(perform: cancel)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoCanvas)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(focused ? Color.junoForeground.opacity(0.6) : Color.junoInput, lineWidth: 1)
            )
            .accessibilityLabel("New memory")
            HStack(spacing: JunoSpace.snug) {
                Group {
                    if let project {
                        Text("Only chats in \(project.name) will use it.")
                    } else {
                        Text("Every chat can use it.")
                    }
                }
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                Spacer()
                Button("Cancel", action: cancel)
                    .buttonStyle(.borderless)
                    .tint(nil)
                    .contentShape(.rect)
                Button("Save") { Task { await commit() } }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .contentShape(.rect)
            }
            .controlSize(.small)
        }
        .onAppear { focused = true }
    }

    private func commit() async {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !saving else { return }
        saving = true
        let ok = await save(content)
        saving = false
        if ok { draft = "" } else { focused = true }
    }
}
