import AppKit
import JunoChatKit
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// Everything the composer's `+` menu shows and changes, handed down in one
/// value so the menu, and every armed mark that reopens it, draw from the same
/// state.
///
/// A row is present when its value is non-nil and absent otherwise — never a
/// row that is on screen and can never work. What a row *cannot do right now*
/// is a disabled row with its reason on a second line ("Not on this model",
/// "Incognito"), the web's rule for the same menu.
struct ComposerPlusMenuModel {
    // Group 1 — bring something in.
    var attachTitle: String
    var canAttach: Bool
    /// Why nothing can be brought in, when it is a rule rather than a limit —
    /// "Incognito": a private turn carries only its words. Drawn as the
    /// disabled rows' second line.
    var attachUnavailableReason: String? = nil
    var addFiles: () -> Void
    /// Nil where a screenshot cannot go anywhere: during a call.
    var takeScreenshot: (() -> Void)?
    /// Nil without a Library to pick from.
    var addFromLibrary: (() -> Void)?
    var canAddFromLibrary: Bool

    // Group 2 — where this chat sits and what it can reach.
    /// The projects to offer, or nil to leave the row out (a project overview's
    /// composer is already filed; private and voice have no project).
    var projects: [NativeProject]?
    var currentProjectID: String?
    var chooseProject: (String?) -> Void
    /// "New Project…", on a draft only.
    var newProject: (() -> Void)?
    /// The connected apps, or nil to leave the row out.
    var connectors: [NativeConnector]?
    var connectorsLoading: Bool
    var selectedConnectors: Binding<Set<String>>
    var manageConnections: (() -> Void)?

    // Group 3 — armed for this message.
    /// The skills a message may be sent under (Phase 4 B's library), or nil
    /// to leave "Use a Skill" out: private mode, a call, no library.
    var skills: [NativeSkillChoice]? = nil
    var skillsLoading = false
    /// The armed skill's slash name; choosing the armed one again disarms it.
    var skillSlug: Binding<String?> = .constant(nil)
    /// "Manage Skills…": the Skills page. Nil leaves the row out.
    var manageSkills: (() -> Void)? = nil
    /// Nil hides Research (private mode). One feature, no levels (Tool calls
    /// & research SPEC §9.9).
    var deepResearch: Binding<Bool>?
    /// Nil hides Web Search, Memory and My Documents (the call's short menu).
    var webSearch: Binding<Bool>?
    var webSearchAvailable: Bool
    var memory: Binding<Bool>?
    var memoryUnavailableReason: String?
    var documents: Binding<Bool>?
    var documentCount: Int

    /// The web's per-chat ceiling on attached apps, kept (§5.4).
    static let connectorLimit = 5
}

/// The composer's `+` menu (§5.4): a native `Menu`, three groups separated by
/// dividers, no headings, Title Case in the web's words. The rows' words and
/// marks are the shell contract's (`JunoShellPlusRow`, from `composer.tsx`),
/// in the order of `JunoShellPlusMenu.chat`; My Documents is the Mac's own
/// (A5).
///
/// It is a real menu on purpose. The version before the one this replaces was a
/// custom popover that had to own hover fills, submenus, checkmarks, disabled
/// explanations, focus and dismissal — and looked foreign for every one of
/// them. Rows here are `Label`s over the generated symbols, on/off rows are
/// `Toggle`s (the system draws the checkmark), and choices are submenus.
///
/// **What is not here any more.** "Canvas & artifacts": whether an answer
/// belongs in an artifact is the model's call now, and the switch sent `nil`
/// when off, which the server read as on — a control that did nothing. The
/// separate thinking chip, which moved into the model popover. Section
/// headings, which the web dropped.
struct ComposerPlusMenu: View {
    let menu: ComposerPlusMenuModel

    // Every row sits lexically inside one `Section`, which a menu draws as
    // nothing at all: it is what tells the targets gate these rows are
    // system-drawn menu items, not views laid out here.
    var body: some View {
        Section {
            // ── Group 1: bring something in ─────────────────────────────────
            // No chords in here: ⌘U and ⇧⌘U belong to Chat › Attach Files… and
            // Attach Screenshot… in the menu bar, which is where a Mac shows a
            // key and where it works with this menu closed (P3-19).
            Button(action: menu.addFiles) {
                Label {
                    Text(menu.attachTitle)
                    if let reason = menu.attachUnavailableReason { Text(reason) }
                } icon: {
                    Image(JunoShellPlusRow.files.icon.assetName)
                }
            }
            .disabled(!menu.canAttach)

            if let takeScreenshot = menu.takeScreenshot {
                Button(action: takeScreenshot) {
                    Label {
                        Text(JunoShellPlusRow.screenshot.title)
                        if let reason = menu.attachUnavailableReason { Text(reason) }
                    } icon: {
                        Image(JunoShellPlusRow.screenshot.icon.assetName)
                    }
                }
                .disabled(!menu.canAttach)
            }

            if let addFromLibrary = menu.addFromLibrary {
                Button(action: addFromLibrary) {
                    Label {
                        // The ellipsis is the Mac's: the row opens a sheet.
                        Text(JunoShellPlusRow.library.title + "…")
                        if let reason = menu.attachUnavailableReason { Text(reason) }
                    } icon: {
                        Image(JunoShellPlusRow.library.icon.assetName)
                    }
                }
                .disabled(!menu.canAddFromLibrary)
            }

            // ── Group 2: where this chat sits and what it can reach ─────────
            if menu.projects != nil || menu.connectors != nil {
                Divider()
            }

            if let projects = menu.projects {
                Menu {
                    Toggle("No Project", isOn: projectBinding(nil))
                    if !projects.isEmpty {
                        Divider()
                        ForEach(projects) { project in
                            Toggle(project.name, isOn: projectBinding(project.id))
                        }
                    }
                    if let newProject = menu.newProject {
                        Divider()
                        Button(action: newProject) {
                            Label {
                                Text("New Project…")
                            } icon: {
                                Image(JunoIcon.plus.assetName)
                            }
                        }
                    }
                } label: {
                    Label {
                        Text(JunoShellPlusRow.project.title)
                        if let name = projects.first(where: { $0.id == menu.currentProjectID })?.name {
                            Text(name)
                        }
                    } icon: {
                        Image(JunoShellPlusRow.project.icon.assetName)
                    }
                }
            }

            if let connectors = menu.connectors {
                Menu {
                    if connectors.isEmpty {
                        // A disabled row: it says what is there, and nothing else.
                        Button(menu.connectorsLoading ? "Loading…" : "No Connected Apps") {}
                            .disabled(true)
                    }
                    ForEach(connectors) { connector in
                        Toggle(isOn: connectorBinding(connector.id)) {
                            Label {
                                Text(connector.label)
                            } icon: {
                                connectorImage(connector)
                            }
                        }
                        // At the ceiling the rest go quiet rather than
                        // vanishing, so the limit reads as a limit.
                        .disabled(!selectedConnectors.contains(connector.id) && atConnectorLimit)
                    }
                    if let manageConnections = menu.manageConnections {
                        Divider()
                        Button(action: manageConnections) {
                            Text("Manage Connections…")
                            Text("\(selectedConnectors.count) of \(ComposerPlusMenuModel.connectorLimit) on")
                        }
                    }
                } label: {
                    Label {
                        Text(JunoShellPlusRow.connectors.title)
                        if !selectedConnectors.isEmpty {
                            Text("\(selectedConnectors.count) on")
                        }
                    } icon: {
                        Image(JunoShellPlusRow.connectors.icon.assetName)
                    }
                }
            }

            // ── Group 3: armed for this message ─────────────────────────────
            Divider()

            // Use a Skill ▸ (§5.4): the skills by name, the description on a
            // second line, the armed one checked; the message is sent under
            // it as `skillSlug`. First in the group, as the skill's mark is
            // first among the marks.
            if let skills = menu.skills {
                Menu {
                    if skills.isEmpty {
                        Button(menu.skillsLoading ? "Loading…" : "No Skills Yet") {}
                            .disabled(true)
                    }
                    ForEach(skills) { skill in
                        Toggle(isOn: skillBinding(skill.slug)) {
                            Text(skill.name)
                            if !skill.description.isEmpty {
                                Text(skill.description)
                            }
                        }
                    }
                    if let manageSkills = menu.manageSkills {
                        Divider()
                        Button("Manage Skills…", action: manageSkills)
                    }
                } label: {
                    Label {
                        Text(JunoShellPlusRow.skill.title)
                        if let armed = skills.first(where: { $0.slug == menu.skillSlug.wrappedValue }) {
                            Text(armed.name)
                        }
                    } icon: {
                        Image(JunoShellPlusRow.skill.icon.assetName)
                    }
                }
            }

            if let deepResearch = menu.deepResearch {
                Toggle(isOn: deepResearch) {
                    Label {
                        Text(JunoShellPlusRow.research.title)
                    } icon: {
                        Image(JunoShellPlusRow.research.icon.assetName)
                    }
                }
            }

            if let webSearch = menu.webSearch {
                Toggle(isOn: webSearch) {
                    Label {
                        Text(JunoShellPlusRow.search.title)
                        if !menu.webSearchAvailable {
                            Text("Not on this model")
                        }
                    } icon: {
                        Image(JunoShellPlusRow.search.icon.assetName)
                    }
                }
                .disabled(!menu.webSearchAvailable)
            }

            if let memory = menu.memory {
                // Bound to the synced account setting, so it is the same switch
                // as Settings › Memory. Never a mark: it is true of every message.
                Toggle(isOn: memory) {
                    Label {
                        Text(JunoShellPlusRow.memory.title)
                        if let reason = menu.memoryUnavailableReason {
                            Text(reason)
                        }
                    } icon: {
                        Image(JunoShellPlusRow.memory.icon.assetName)
                    }
                }
                .disabled(menu.memoryUnavailableReason != nil)
            }

            if let documents = menu.documents {
                Toggle(isOn: documents) {
                    Label {
                        Text("My Documents")
                        if menu.documentCount == 0 {
                            Text("None on this Mac")
                        }
                    } icon: {
                        Image(JunoIcon.fileSearch.assetName)
                    }
                }
                .disabled(menu.documentCount == 0)
            }
        }
    }

    private var selectedConnectors: Set<String> { menu.selectedConnectors.wrappedValue }

    private var atConnectorLimit: Bool {
        selectedConnectors.count >= ComposerPlusMenuModel.connectorLimit
    }

    /// The app's own mark where there is one — the installed Mac app's icon or
    /// the bundled brand artwork — and the plug the Connections page uses
    /// otherwise. A menu row takes an image, not a view.
    private func connectorImage(_ connector: NativeConnector) -> Image {
        if let image = JunoConnectorMark.menuImage(for: connector.id) {
            return Image(nsImage: image)
        }
        return Image(JunoIcon.connections.assetName)
    }

    // MARK: Bindings

    private func projectBinding(_ id: String?) -> Binding<Bool> {
        Binding(
            get: { menu.currentProjectID == id },
            set: { isOn in if isOn { menu.chooseProject(id) } }
        )
    }

    private func skillBinding(_ slug: String) -> Binding<Bool> {
        let selection = menu.skillSlug
        return Binding(
            get: { selection.wrappedValue == slug },
            set: { isOn in selection.wrappedValue = isOn ? slug : nil }
        )
    }

    private func connectorBinding(_ id: String) -> Binding<Bool> {
        let selection = menu.selectedConnectors
        return Binding(
            get: { selection.wrappedValue.contains(id) },
            set: { isOn in
                if isOn {
                    guard selection.wrappedValue.count < ComposerPlusMenuModel.connectorLimit else { return }
                    selection.wrappedValue.insert(id)
                } else {
                    selection.wrappedValue.remove(id)
                }
            }
        )
    }
}

// MARK: - Armed marks

/// One thing armed for the next message, drawn at the head of the field (§5.5).
///
/// The web's `ArmedMark`, as a value: what it looks like, what it says, and how
/// to say "turn it off" to a screen reader. What removing it *does* is the
/// composer's — the id says which state it stands for.
struct ChatComposerMark: Identifiable, Equatable {
    enum Glyph: Equatable {
        case icon(JunoIcon)
        case connector(String)
    }

    let id: String
    let glyph: Glyph
    let label: String
    /// A qualifier after the label — research depth. Dropped with the label on
    /// a narrow composer.
    let detail: String?
    let help: String
    let removeLabel: String

    /// Two, then a count. Every mark is a word the sentence starts further in,
    /// so a third would leave less room for the prompt than for the things
    /// qualifying it — the web's `ARMED_MARK_LIMIT`.
    static let visibleLimit = 2

    /// Below this width a composer keeps the marks' glyphs and drops their
    /// words (§5.5): two worded marks are ~260pt, which would leave a narrow
    /// window's sentence a third of its own line.
    static let labelMinimumWidth: CGFloat = 480

    static let skillID = "skill"
    static let researchID = "research"
    static let webSearchID = "web"
    static let documentsID = "documents"
    static let connectorPrefix = "connector:"
    static let overflowID = "more"

    /// The marks for what is armed, in the web's order: Skill (a later
    /// phase) → Research → Web search → each connector under its own
    /// logo → My documents. Memory never gets a mark: it is an account setting
    /// true of every message, and a mark that is always lit teaches the reader
    /// to stop reading the row. Research has no levels and so no detail
    /// (SPEC §9.9).
    static func marks(
        skill: (slug: String, name: String?, description: String?)? = nil,
        research: Bool,
        webSearch: Bool,
        connectors: [(id: String, label: String)],
        documentCount: Int?
    ) -> [ChatComposerMark] {
        var marks: [ChatComposerMark] = []
        // The skill, first: it decides how the message is answered. The web's
        // mark (`composer.tsx`): the skill's name, its description as the
        // tooltip, "Sent under /slug." without one.
        if let skill {
            let description = skill.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            marks.append(ChatComposerMark(
                id: skillID,
                glyph: .icon(.skills),
                label: skill.name ?? "/\(skill.slug)",
                detail: nil,
                help: description.isEmpty ? "Sent under /\(skill.slug)." : description,
                removeLabel: "Don\u{2019}t use this skill for this message"
            ))
        }
        if research {
            marks.append(ChatComposerMark(
                id: researchID,
                glyph: .icon(.research),
                label: "Research",
                detail: nil,
                help: "Research on",
                removeLabel: "Turn off Research"
            ))
        }
        if webSearch {
            marks.append(ChatComposerMark(
                id: webSearchID,
                glyph: .icon(.web),
                label: "Web search",
                detail: nil,
                help: "Web search is on for this chat.",
                removeLabel: "Turn off web search"
            ))
        }
        for connector in connectors {
            marks.append(ChatComposerMark(
                id: connectorPrefix + connector.id,
                glyph: .connector(connector.id),
                label: connector.label,
                detail: nil,
                help: "\(connector.label) is attached to this chat.",
                removeLabel: "Detach \(connector.label)"
            ))
        }
        if let documentCount {
            marks.append(ChatComposerMark(
                id: documentsID,
                glyph: .icon(.fileSearch),
                label: "My documents",
                detail: nil,
                help: documentCount == 1
                    ? "Alevr will search 1 document on this Mac and quote what it finds in your message."
                    : "Alevr will search \(documentCount) documents on this Mac and quote what it finds in your message.",
                removeLabel: "Don't search my documents"
            ))
        }
        return marks
    }

    /// The marks that fit, then one standing for the rest.
    ///
    /// The tail collapses into "N more": its help names the rest, and removing
    /// it clears exactly the states it stands for.
    static func visible(_ marks: [ChatComposerMark]) -> (shown: [ChatComposerMark], rest: [ChatComposerMark]) {
        (Array(marks.prefix(visibleLimit)), Array(marks.dropFirst(visibleLimit)))
    }

    static func overflow(for rest: [ChatComposerMark]) -> ChatComposerMark {
        let names = rest.map(\.label).joined(separator: ", ")
        return ChatComposerMark(
            id: overflowID,
            glyph: .icon(.more),
            label: "\(rest.count) more",
            detail: nil,
            help: names,
            removeLabel: "Turn off \(names)"
        )
    }
}

/// A mark: 22pt, radius 6, the resting fill inside glass — neutral, never
/// coral (§0.4, §5.5).
///
/// The label is the `+` menu itself, reopened where the reader is looking —
/// clicking "Research" is how you get to the switch that turns it off. A
/// hover reveals the ✕ that disarms it directly; VoiceOver gets the same as a
/// named action, because a control that appears only under a pointer is not
/// one a screen reader can find.
struct ComposerArmedMarkView<MenuContent: View>: View {
    let mark: ChatComposerMark
    let showsLabel: Bool
    let disarm: () -> Void
    @ViewBuilder let menu: () -> MenuContent

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            Menu {
                menu()
            } label: {
                HStack(spacing: JunoSpace.hairline) {
                    glyph
                    if showsLabel {
                        Text(mark.label)
                            .junoType(JunoType.label.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                            .lineLimit(1)
                        if let detail = mark.detail {
                            Text("· \(detail)")
                                .junoType(.label)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.leading, JunoSpace.tight)
                .padding(.trailing, hovered ? 2 : JunoSpace.tight)
                .padding(.vertical, JunoSpace.hairline)
                .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(mark.help)

            if hovered {
                Button(action: disarm) {
                    JunoIconView(.close, size: 9, weight: .bold)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .padding(.leading, JunoSpace.micro)
                        .padding(.trailing, JunoSpace.hairline)
                        .padding(.vertical, JunoSpace.tight)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help(mark.removeLabel)
                .transition(.opacity)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                .fill(Color.junoGlassFill)
        )
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([mark.label, mark.detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint("Opens the add menu.")
        .accessibilityAction(named: mark.removeLabel, disarm)
        .accessibilityIdentifier("juno.desktop.chat.mark.\(mark.id)")
    }

    @ViewBuilder
    private var glyph: some View {
        switch mark.glyph {
        case .icon(let icon):
            JunoIconView(icon, size: 12, weight: .bold)
                .foregroundStyle(Color.junoForeground)
        case .connector(let id):
            JunoConnectorMark(connectorID: id, connectorName: mark.label, size: 12)
        }
    }
}
