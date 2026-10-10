import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The Skills chip in Code's composer row and the selector it opens: a search
// field, the skills grouped Yours / Installed on this Mac / Project, each with
// its description and where it came from, a check on the ones the thread runs
// under, and Manage skills… at the foot. Built like the model catalogue: the
// popover is the system's (Liquid Glass on macOS 26), nothing inside draws
// glass of its own.

/// `Skills` at rest; the skill's name, or "2 skills", once chosen.
struct CodeSkillsChip: View {
    @Bindable var skills: CodeSkillsModel
    var isEnabled = true

    @State private var isOpen = false

    var body: some View {
        Button { isOpen.toggle() } label: {
            CodeV2TextControlLabel(title: skills.chipTitle, icon: .skills)
                .contentTransition(.opacity)
        }
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: isOpen)).contentShape(.rect)
        .fixedSize()
        .disabled(!isEnabled)
        .help(skills.hasActive ? "Skills: \(skills.chipTitle)" : "Run this thread under a skill, or type / and its name")
        .accessibilityLabel("Skills")
        .accessibilityValue(skills.hasActive ? skills.chipTitle : "None")
        .accessibilityIdentifier("juno.code.v2.skills")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            CodeSkillsPanel(skills: skills, close: { isOpen = false })
        }
        .task { await skills.loadIfNeeded() }
    }
}

/// The selector. 380 wide, like the model catalogue.
struct CodeSkillsPanel: View {
    @Bindable var skills: CodeSkillsModel
    var close: () -> Void = {}
    /// A search already typed (the gallery).
    var initialQuery = ""

    static let size = CGSize(width: 380, height: 420)
    static let listHeight: CGFloat = size.height - 40 - 39

    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var searchFocused: Bool

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var visible: [CodeSkillChoice] { skills.matches(query) }

    var body: some View {
        VStack(spacing: 0) {
            search
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        list
                    }
                    .padding(.horizontal, JunoSpace.tight + 2)
                    .padding(.bottom, JunoSpace.tight + 2)
                }
                .frame(height: Self.listHeight)
                .onChange(of: highlighted) { _, index in
                    guard visible.indices.contains(index) else { return }
                    proxy.scrollTo(visible[index].id)
                }
            }
            Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
            footer
        }
        .frame(width: Self.size.width)
        .onAppear {
            if query.isEmpty, !initialQuery.isEmpty { query = initialQuery }
            searchFocused = true
        }
        .onChange(of: query) { _, _ in highlighted = 0 }
    }

    // MARK: Search

    private var search: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.search, size: 14).foregroundStyle(Studio.Ink.tertiary)
            TextField("Search skills", text: $query)
                .textFieldStyle(.plain)
                .studioType(.text)
                .focused($searchFocused)
                .onKeyPress(.downArrow) { move(1) }
                .onKeyPress(.upArrow) { move(-1) }
                .onKeyPress(.return) {
                    guard visible.indices.contains(highlighted) else { return .ignored }
                    skills.toggle(visible[highlighted])
                    return .handled
                }
                .accessibilityIdentifier("juno.code.v2.skills.search")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 40)
    }

    private func move(_ delta: Int) -> KeyPress.Result {
        guard !visible.isEmpty else { return .ignored }
        highlighted = (highlighted + delta + visible.count) % visible.count
        return .handled
    }

    // MARK: List

    @ViewBuilder
    private var list: some View {
        if skills.choices.isEmpty, skills.isLoading {
            Text("Looking for skills\u{2026}")
                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .padding(JunoSpace.cozy)
        } else if skills.choices.isEmpty, skills.failed {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Couldn\u{2019}t load your skills").studioType(.text).foregroundStyle(Studio.Ink.primary)
                Button("Try Again") { Task { await skills.refresh() } }
                    .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize().contentShape(.rect)
            }
            .padding(JunoSpace.cozy)
        } else if skills.choices.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("No skills yet").studioType(.text).foregroundStyle(Studio.Ink.primary)
                Text("Add a folder with a SKILL.md to ~/.claude/skills, or write one in Alevr.")
                    .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(JunoSpace.cozy)
        } else if searching, visible.isEmpty {
            Text("No skill matches \u{201C}\(query)\u{201D}")
                .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                .padding(JunoSpace.cozy)
        } else if searching {
            // Flat while searching: each row says where it came from.
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, choice in
                row(choice, index: index, labelled: true)
            }
        } else {
            ForEach(CodeSkillChoice.Group.allCases, id: \.self) { group in
                let members = visible.enumerated().filter { $0.element.group == group }
                if !members.isEmpty {
                    CodeV2PickerHeading(title: group.title, trailing: "\(members.count)")
                    ForEach(members, id: \.element.id) { index, choice in
                        row(choice, index: index, labelled: group != .yours)
                    }
                }
            }
        }
    }

    private func row(_ choice: CodeSkillChoice, index: Int, labelled: Bool) -> some View {
        CodeSkillRow(
            choice: choice,
            isSelected: skills.isSelected(choice),
            isArmed: skills.once == choice,
            isHighlighted: index == highlighted,
            showsOrigin: labelled,
            action: { skills.toggle(choice) }
        )
        .id(choice.id)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            if let manage = skills.account?.manage {
                Button("Manage skills\u{2026}") { close(); manage() }
                    .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize().contentShape(.rect)
                    .accessibilityIdentifier("juno.code.v2.skills.manage")
            } else {
                Text("Type / and a name to use one once").studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
            }
            Spacer(minLength: JunoSpace.snug)
            if skills.hasActive {
                Button("Clear") { skills.clear() }
                    .buttonStyle(CodeV2FooterButtonStyle(compact: true)).fixedSize().contentShape(.rect)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 38)
    }
}

/// One skill: the name over its description, where it came from on the
/// right, a check while the thread runs under it.
struct CodeSkillRow: View {
    let choice: CodeSkillChoice
    let isSelected: Bool
    var isArmed = false
    var isHighlighted = false
    var showsOrigin = true
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                JunoIconView(.skills, size: 14)
                    .foregroundStyle(isSelected ? Studio.Ink.primary : Studio.Ink.tertiary)
                    .frame(width: 16, height: 18)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: JunoSpace.tight) {
                        Text(choice.title).studioType(.text).foregroundStyle(Studio.Ink.primary).lineLimit(1)
                        if isArmed {
                            Text("next message").studioType(.small).foregroundStyle(Studio.Ink.secondary).lineLimit(1)
                        }
                        Spacer(minLength: JunoSpace.snug)
                        if showsOrigin, let origin = choice.originLabel {
                            Text(origin).studioType(.small).foregroundStyle(Studio.Ink.tertiary).lineLimit(1)
                        }
                    }
                    if !choice.description.isEmpty {
                        Text(choice.description)
                            .studioType(.small).foregroundStyle(Studio.Ink.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                JunoIconView(.check, size: 13)
                    .foregroundStyle(Studio.Ink.primary)
                    .opacity(isSelected ? 1 : 0)
                    .frame(width: 14, height: 18)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight + 2)
            .frame(minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.control, style: .continuous)
                    .fill(hovering || isHighlighted ? Studio.Surface.hover : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(choice.path ?? choice.title)
        .accessibilityLabel(choice.title)
        .accessibilityValue(choice.description)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("juno.code.v2.skills.row.\(choice.name)")
    }
}
