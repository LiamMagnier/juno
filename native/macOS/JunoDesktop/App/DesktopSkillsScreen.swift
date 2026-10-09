import AppKit
import Foundation
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The first message of a conversation that writes a skill
/// (`CREATE_SKILL_PROMPT`, `add-skill-menu.tsx`): it lands in the composer as
/// a draft, and the reader finishes the sentence with the job.
enum DesktopSkillCopy {
    static let createPrompt =
        "Help me create a skill for Alevr. Ask me anything you need, then write the SKILL.md with a name, a one-line description and step-by-step instructions. The job is: "
}

/// **Skills** — instructions Juno follows for a specific job
/// (`skills-library-view.tsx`, Phase 4 B3): "Your skills", flat, and
/// "Installed", one folder per repository with its skills inside. The source
/// is what you install, update and remove; the skill is what you switch on
/// and call.
///
/// The signature is the search: the `/` keycap sits in the field and fades
/// while you type, and `/` focuses the field from the page.
struct DesktopSkillsScreen: View {
    let model: NativeSkillLibraryModel
    /// Starts a new chat with `text` in the composer, not sent.
    let startDraft: (String) -> Void
    /// Opens the importer when the page appears, on this repository if one
    /// is named — for a snapshot, or a link that asks for it.
    var importOnAppear: String? = nil
    /// Which folders start open, for a snapshot.
    var initialOpenSources: Set<String>? = nil
    /// A search already typed, for a snapshot.
    var initialQuery: String? = nil

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @AppStorage("juno.skills.open-sources") private var storedOpenSources = ""
    @State private var query = ""
    @State private var importing: DesktopSkillImportRequest?
    @State private var updating: NativeSkillSource?
    @State private var confirmation: JunoConfirmation?
    @State private var dealt = false
    @State private var didOpenOnAppear = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        JunoPage(measure: .reading) {
            JunoPageHeader(
                "Skills",
                lede: "Instructions Alevr follows for a specific job. Type / in chat to use one."
            ) {
                addMenu
            }
        } content: {
            content
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "/")) { _ in
            guard !searchFocused, model.library.map({ !$0.isEmpty }) == true else { return .ignored }
            searchFocused = true
            return .handled
        }
        .task {
            if !didOpenOnAppear, let initialQuery {
                query = initialQuery
            }
            if !didOpenOnAppear, let importOnAppear {
                didOpenOnAppear = true
                importing = DesktopSkillImportRequest(source: importOnAppear.isEmpty ? nil : importOnAppear)
            }
            if model.library == nil, model.failure == nil { await model.refresh() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { dealt = true }
        }
        .sheet(item: $importing) { request in
            DesktopSkillImportSheet(model: model, initialSource: request.source) { outcome, preview in
                Task { await installed(outcome, preview: preview) }
            }
        }
        .sheet(item: $updating) { source in
            DesktopSkillUpdateSheet(model: model, source: source) { result in
                Task { await updated(result, source: source) }
            }
        }
        .junoConfirmation($confirmation)
        .accessibilityIdentifier("juno.desktop.skills")
    }

    // MARK: Header

    private var addMenu: some View {
        Menu {
            Button { importing = DesktopSkillImportRequest(source: nil) } label: {
                Label("Import from GitHub…", image: JunoIcon.github.assetName)
            }
            Button { push(.newSkill) } label: {
                Label("Write a Skill", image: JunoIcon.edit.assetName)
            }
            Button { startDraft(DesktopSkillCopy.createPrompt) } label: {
                Label("Create with Alevr", image: JunoIcon.conversation.assetName)
            }
        } label: {
            DesktopProminentMenuLabel(title: "Add", icon: .plus)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add a skill")
        .accessibilityLabel("Add")
        .accessibilityIdentifier("juno.desktop.skills.add")
        .contentShape(.rect)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let library = model.library {
            if library.isEmpty {
                emptyState
            } else {
                loaded(library)
            }
        } else if let failure = model.failure {
            DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                Text(failure)
            } action: {
                Button("Retry") { Task { await model.refresh() } }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .controlSize(.small)
                    .contentShape(.rect)
            }
        } else {
            DesktopSkillsSkeleton()
        }
    }

    private func loaded(_ library: NativeSkillLibrary) -> some View {
        let filtered = NativeSkillRules.filter(library, query: query)
        return VStack(alignment: .leading, spacing: 0) {
            searchField
                .padding(.bottom, JunoSpace.wide)
            if filtered.isEmpty {
                JunoEmptyState(
                    title: "No skills match “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”",
                    icon: .search,
                    size: .panel
                ) {
                    Button { importing = DesktopSkillImportRequest(source: nil) } label: {
                        Label("Import from GitHub", icon: .github, size: 13)
                    }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .contentShape(.rect)
                }
            }
            if !filtered.yours.isEmpty {
                section(title: "Your skills", count: filtered.yours.count) {
                    ForEach(Array(filtered.yours.enumerated()), id: \.element.id) { index, skill in
                        if index > 0 { DesktopRowDivider() }
                        DesktopSkillRow(
                            skill: skill,
                            open: { push(.skill(skill.id)) },
                            toggle: { on in Task { await toggle(skill, on) } }
                        )
                        .desktopDealIn(index, dealt: dealt)
                    }
                }
            }
            if !filtered.sources.isEmpty {
                section(title: "Installed", count: filtered.sources.count) {
                    ForEach(Array(filtered.sources.enumerated()), id: \.element.source.id) { index, entry in
                        if index > 0 { DesktopRowDivider() }
                        DesktopSkillSourceGroup(
                            source: entry.source,
                            skills: entry.skills,
                            expanded: filtered.searching || isOpen(entry.source),
                            setExpanded: { setOpen(entry.source, $0) },
                            toggleSource: { on in Task { await toggleSource(entry.source, on) } },
                            toggleSkill: { skill, on in Task { await toggle(skill, on) } },
                            open: { push(.skill($0.id)) },
                            checkUpdates: { updating = entry.source },
                            remove: { confirmation = removal(entry.source) }
                        )
                        .desktopDealIn(filtered.yours.count + index, dealt: dealt)
                    }
                }
            }
            if library.truncated {
                Text("Showing \(Text(library.listedCount, format: .number)) of \(Text(library.total, format: .number)) skills, the first by name.")
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.top, JunoSpace.regular)
            }
        }
    }

    /// The web's larger field: 40pt at the field radius, the `/` keycap that
    /// fades while you type, Esc to clear.
    private var searchField: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(.search, size: 15)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
            TextField("Search skills", text: $query)
                .textFieldStyle(.plain)
                .junoType(.ui)
                .focused($searchFocused)
                .onExitCommand { query = "" }
                .accessibilityLabel("Search skills")
                .accessibilityIdentifier("juno.desktop.skills.search")
            DesktopKeycap(key: "/")
                .opacity(query.isEmpty ? 1 : 0)
                .animation(JunoMotion.fast, value: query.isEmpty)
        }
        .padding(.horizontal, JunoSpace.comfy)
        .frame(height: 40)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary.opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(searchFocused ? Color.junoRing : Color.junoInput, lineWidth: 1)
        )
        .contentShape(.rect(cornerRadius: JunoRadius.field))
        .onTapGesture { searchFocused = true }
    }

    private func section<Rows: View>(title: String, count: Int, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(title)
                    .junoType(JunoType.body.weight(.semibold))
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(count, format: .number)
                    .junoType(.ui)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            DesktopListCard(content: rows)
        }
        .padding(.bottom, JunoSpace.wide + JunoSpace.hairline)
    }

    private var emptyState: some View {
        JunoEmptyState(
            title: "No skills yet",
            message: "Install a set from GitHub, or write your own.",
            icon: .skills
        ) {
            VStack(spacing: JunoSpace.roomy) {
                HStack(spacing: JunoSpace.snug) {
                    // Neutral: the header's Add is the page's one prominent
                    // button, and it offers these same doors.
                    Button { importing = DesktopSkillImportRequest(source: nil) } label: {
                        Label("Import from GitHub", icon: .github, size: 13)
                    }
                        .contentShape(.rect)
                    Button { push(.newSkill) } label: {
                        Label("Write one", icon: .edit, size: 13)
                    }
                        .contentShape(.rect)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                DesktopPopularSources { repository in
                    importing = DesktopSkillImportRequest(source: repository)
                }
            }
        }
    }

    // MARK: Folders

    private var openSources: Set<String> {
        if let initialOpenSources { return initialOpenSources }
        return Set(storedOpenSources.split(separator: ",").map(String.init))
    }

    /// Remembered per source on this Mac. A source holding a single skill
    /// starts open: a folder you have to open to find one thing is in the way.
    private func isOpen(_ source: NativeSkillSource) -> Bool {
        let key = source.id
        if openSources.contains("+\(key)") || openSources.contains(key) { return true }
        if openSources.contains("-\(key)") { return false }
        return source.skills.count == 1
    }

    private func setOpen(_ source: NativeSkillSource, _ open: Bool) {
        var set = Set(storedOpenSources.split(separator: ",").map(String.init))
        set.remove("+\(source.id)")
        set.remove("-\(source.id)")
        set.remove(source.id)
        set.insert(open ? "+\(source.id)" : "-\(source.id)")
        storedOpenSources = set.sorted().joined(separator: ",")
    }

    // MARK: Actions

    private func toggle(_ skill: NativeSkill, _ on: Bool) async {
        if let sentence = await model.setSkillEnabled(skill, on) { toast(.error(sentence)) }
    }

    private func toggleSource(_ source: NativeSkillSource, _ on: Bool) async {
        if let sentence = await model.setSourceEnabled(source, on) { toast(.error(sentence)) }
    }

    /// "Remove anthropics/skills?", with what goes and what stays.
    private func removal(_ source: NativeSkillSource) -> JunoConfirmation {
        let count = source.skills.count
        return JunoConfirmation(
            title: "Remove \(source.label)?",
            message: (count == 1 ? "Its skill is removed from Alevr." : "Its \(count) skills are removed from Alevr.")
                + " Chats that used them keep their history.",
            confirmTitle: "Remove"
        ) {
            Task { await remove(source) }
        }
    }

    private func remove(_ source: NativeSkillSource) async {
        let count = source.skills.count
        if let sentence = await model.removeSource(source) {
            toast(.error(sentence))
        } else {
            toast(.success("Removed \(source.label)", detail: "\(count) \(count == 1 ? "skill" : "skills") removed."))
        }
    }

    private func installed(_ outcome: NativeSkillImportOutcome, preview: NativeSkillImportPreview) async {
        let repository = "\(preview.repository.owner)/\(preview.repository.repo)"
        if let sentence = await model.refresh() { toast(.error(sentence)) }
        if let landed = outcome.source?.id { setOpen(NativeSkillSource(id: landed, owner: "", repo: ""), true) }
        let count = outcome.importedCount
        var notes: [String] = []
        if outcome.blocked > 0 {
            notes.append(outcome.blocked == 1
                ? "One came in switched off because Alevr’s safety check blocked it."
                : "\(outcome.blocked) came in switched off because Alevr’s safety check blocked them.")
        }
        if let first = outcome.skipped.first, !first.message.isEmpty { notes.append(first.message) }
        if count > 0, let source = outcome.source, !source.enabled {
            notes.append("\(source.label) is switched off, so \(count == 1 ? "it won’t" : "they won’t") show in chat until you turn it on.")
        }
        let detail = notes.isEmpty ? nil : notes.joined(separator: " ")
        if count == 0 {
            toast(.error("Nothing was installed.", detail: detail))
        } else {
            toast(.success("Installed \(count) \(count == 1 ? "skill" : "skills") from \(repository)", detail: detail))
        }
    }

    private func updated(_ result: NativeSkillSourceUpdateResult, source: NativeSkillSource) async {
        _ = await model.refresh()
        let message = NativeSkillRules.updateOutcome(result, from: result.source?.label ?? source.label)
        toast(message.ok ? .success(message.title, detail: message.detail) : .error(message.title, detail: message.detail))
    }
}

/// The importer, asked for with or without a repository.
struct DesktopSkillImportRequest: Identifiable {
    let id = UUID()
    let source: String?
}

/// Three repositories one press away (`POPULAR_SKILL_SOURCES`).
struct DesktopPopularSources: View {
    var disabled = false
    let pick: (String) -> Void

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Text("Popular")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.trailing, JunoSpace.micro * 2)
            ForEach(NativeSkillRules.popularSources, id: \.owner) { source in
                DesktopPopularChip(label: "\(source.owner)/\(source.repo)", owner: source.owner) {
                    pick("\(source.owner)/\(source.repo)")
                }
                .disabled(disabled)
            }
        }
    }
}

private struct DesktopPopularChip: View {
    let label: String
    let owner: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.tight) {
                DesktopOwnerTile(owner: owner, side: 16)
                Text(label)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoForeground)
            }
            .padding(.leading, JunoSpace.tight)
            .padding(.trailing, JunoSpace.snug)
            .frame(height: 28)
            .background(
                Capsule(style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.junoSecondary)
            )
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityLabel("Import \(label)")
    }
}

// MARK: - Rows

/// One skill: its name, one line of what it is for, its switch
/// (`skill-row.tsx`). The whole row opens its page; the switch still works.
/// The one fact that earns a mark here is that the skill cannot run as
/// things stand: blocked, or waiting for approval.
struct DesktopSkillRow: View {
    let skill: NativeSkill
    var inheritedOff = false
    var indent = false
    let open: () -> Void
    let toggle: (Bool) -> Void

    @State private var isHovering = false

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Button(action: open) {
                HStack(spacing: JunoSpace.cozy) {
                    if !indent {
                        DesktopInsetTile(icon: .skills, side: 28, glyph: 15, isActive: isHovering)
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.micro) {
                        Text(skill.name)
                            .junoType(JunoType.ui.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                        if !skill.description.isEmpty {
                            Text(skill.description)
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .lineLimit(1)
                        }
                        if let attention = skill.attention {
                            Text(attention.sentence)
                                .junoType(JunoType.caption.weight(.medium))
                                .foregroundStyle(Color.junoWarningInk)
                        }
                    }
                    .opacity(inheritedOff || !skill.enabled ? 0.6 : 1)
                    Spacer(minLength: JunoSpace.snug)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(skill.name)
            .accessibilityHint("Opens the skill")
            if skill.attention != nil {
                JunoIconView(.warning, size: 15)
                    .foregroundStyle(Color.junoWarningInk)
                    .help(skill.attention?.sentence ?? "")
                    .accessibilityHidden(true)
            }
            Toggle(skill.name, isOn: Binding(get: { skill.enabled && !skill.isBlocked }, set: { toggle($0) }))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .tint(Color.junoAccent)
                .disabled(skill.isBlocked || inheritedOff)
                .accessibilityLabel("Use \(skill.name)")
            JunoIconView(.chevronRight, size: 13)
                .foregroundStyle(Color.junoSecondaryInk)
                .opacity(isHovering ? 1 : 0)
                .frame(width: 16)
                .accessibilityHidden(true)
        }
        .padding(.leading, indent ? JunoSpace.regular + 28 + JunoSpace.cozy : JunoSpace.regular)
        .padding(.trailing, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .frame(minHeight: 56)
        .background(isHovering ? Color.junoHover : Color.clear)
        .onHover { isHovering = $0 }
    }
}

/// One installed repository: a folder row and its skills (`skill-source-group.tsx`).
/// The group carries the source's switch and its More menu; each child
/// carries only its own switch, which the source never rewrites.
struct DesktopSkillSourceGroup: View {
    let source: NativeSkillSource
    let skills: [NativeSkill]
    let expanded: Bool
    let setExpanded: (Bool) -> Void
    let toggleSource: (Bool) -> Void
    let toggleSkill: (NativeSkill, Bool) -> Void
    let open: (NativeSkill) -> Void
    let checkUpdates: () -> Void
    let remove: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.cozy) {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { setExpanded(!expanded) }
                } label: {
                    HStack(spacing: JunoSpace.cozy) {
                        DesktopOwnerTile(owner: source.owner)
                        VStack(alignment: .leading, spacing: JunoSpace.micro) {
                            Text(source.label)
                                .junoType(JunoType.ui.weight(.medium))
                                .foregroundStyle(Color.junoForeground)
                                .lineLimit(1)
                            counts
                        }
                        Spacer(minLength: JunoSpace.snug)
                    }
                    .opacity(source.enabled ? 1 : 0.6)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(source.label)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if source.hasUpdate {
                    Button("Update available", action: checkUpdates)
                        .buttonStyle(DesktopUnderlineLinkStyle(ink: Color.junoAccentInk))
                        .contentShape(.rect)
                }
                if source.needsAttention {
                    JunoIconView(.warning, size: 15)
                        .foregroundStyle(Color.junoWarningInk)
                        .help("A skill in this source needs attention")
                        .accessibilityLabel("A skill in this source needs attention")
                }
                DesktopRowMenuButton(accessibilityLabel: "More for \(source.label)") {
                    Section {
                        Button { checkUpdates() } label: { Label("Check for Updates…", image: JunoIcon.refresh.assetName) }
                        if let url = URL(string: source.url) {
                            Button { NSWorkspace.shared.open(url) } label: {
                                Label("View on GitHub", image: JunoIcon.github.assetName)
                            }
                        }
                        Divider()
                        Button(role: .destructive) { remove() } label: {
                            Label("Remove…", image: JunoIcon.delete.assetName)
                        }
                    }
                }
                Toggle(source.label, isOn: Binding(get: { source.enabled }, set: { toggleSource($0) }))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .controlSize(.small)
                    .tint(Color.junoAccent)
                    .accessibilityLabel("Use skills from \(source.label)")
                JunoIconView(.chevronRight, size: 13)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .frame(width: 16)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            .frame(minHeight: 56)
            .background(isHovering ? Color.junoHover : Color.clear)
            .onHover { isHovering = $0 }
            if expanded {
                VStack(spacing: 0) {
                    ForEach(skills) { skill in
                        DesktopRowDivider()
                        DesktopSkillRow(
                            skill: skill,
                            inheritedOff: !source.enabled,
                            indent: true,
                            open: { open(skill) },
                            toggle: { toggleSkill(skill, $0) }
                        )
                    }
                }
                .background(Color.junoSecondary.opacity(0.4))
                .transition(.opacity)
            }
        }
    }

    private var counts: some View {
        HStack(spacing: JunoSpace.tight) {
            let (total, on) = source.counts
            Text("\(total) \(total == 1 ? "skill" : "skills")")
            Text("·").accessibilityHidden(true)
            Text(source.enabled ? "\(on) on" : "Off")
        }
        .junoType(.caption)
        .monospacedDigit()
        .foregroundStyle(Color.junoSecondaryInk)
    }
}

/// The list's shape while it loads: the search field, a heading, three rows.
private struct DesktopSkillsSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            JunoSkeleton(height: 40, cornerRadius: JunoRadius.field)
                .padding(.bottom, JunoSpace.roomy)
            JunoSkeleton(height: 16, width: 110)
            DesktopListCard {
                ForEach(0..<3, id: \.self) { index in
                    if index > 0 { DesktopRowDivider() }
                    HStack(spacing: JunoSpace.cozy) {
                        JunoSkeleton(height: 28, width: 28, cornerRadius: JunoRadius.control)
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            JunoSkeleton(height: 12, width: 160)
                            JunoSkeleton(height: 10, width: 260)
                        }
                        Spacer()
                        JunoSkeleton(height: 18, width: 32, cornerRadius: 9)
                    }
                    .padding(.horizontal, JunoSpace.regular)
                    .frame(height: 56)
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading skills")
    }
}
