import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The Team orchestrator in the composer (team lane): an always-visible chip
// next to the model and mode chips that says who is on the team ("Opus plans
// · Sonnet ×2 builds · GPT verifies"), and opens the role editor. Also
// reachable from the + menu (Team…) and ⇧⌘O. The chip and the editor live
// here and in CodeV2TeamEditor.swift; each composer has one insertion point.

/// Where the open thread's team is kept (its session and its project), set
/// by each composer with ``SwiftUI/View/codeV2TeamScope(session:project:)``.
private struct CodeV2TeamScopeKey: EnvironmentKey {
    static let defaultValue: CodeV2TeamStore.Scope? = nil
}

extension EnvironmentValues {
    var codeV2TeamScope: CodeV2TeamStore.Scope? {
        get { self[CodeV2TeamScopeKey.self] }
        set { self[CodeV2TeamScopeKey.self] = newValue }
    }
}

extension View {
    /// The thread and project the composer's Team belongs to: a thread keeps
    /// its own team, and a new thread starts from the project's last one.
    public func codeV2TeamScope(session: String?, project: String?) -> some View {
        environment(\.codeV2TeamScope, CodeV2TeamStore.Scope(session: session, project: project))
    }
}

/// `Team` at rest (Solo); `Opus plans · Sonnet ×2 builds · GPT verifies`
/// once a team is set. Opens the role editor in a Liquid Glass popover.
struct CodeV2TeamChip: View {
    @Bindable var model: CodeV2ComposerModel
    let directory: CodeV2ProviderDirectory
    var isEnabled = true
    var store = CodeV2TeamStore()

    @State private var isOpen = false
    @Environment(\.codeV2TeamScope) private var scope

    private var summary: String? { model.roles.teamSummary }

    var body: some View {
        Button { isOpen.toggle() } label: {
            CodeV2TextControlLabel(title: summary ?? "Team", icon: .agents)
                .contentTransition(.opacity)
        }
        .buttonStyle(CodeV2FooterButtonStyle(isOpen: isOpen)).contentShape(.rect)
        .fixedSize()
        .disabled(!isEnabled)
        .keyboardShortcut("o", modifiers: [.command, .shift])
        .help(summary.map { "Team: \($0) (⇧⌘O)" } ?? "Choose who plans, builds and verifies (⇧⌘O)")
        .accessibilityLabel("Team")
        .accessibilityValue(summary ?? "Solo")
        .accessibilityIdentifier("juno.code.v2.team")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            CodeV2TeamEditor(directory: directory, draft: $model.roles, lead: model.selection)
        }
        .onChange(of: model.teamEditorRequested) { _, requested in
            guard requested else { return }
            model.teamEditorRequested = false
            if isEnabled { isOpen = true }
        }
        .task(id: scope) { restore() }
        .onChange(of: model.roles) { _, roles in save(roles) }
    }

    /// The thread's team, else its project's default, with the lead kept on
    /// the composer's own model.
    private func restore() {
        guard let scope, var stored = store.load(scope) else { return }
        stored.orchestrator = model.selection
        let draft = CodeV2RoleDraft(routing: stored)
        if draft != model.roles { model.roles = draft }
    }

    private func save(_ roles: CodeV2RoleDraft) {
        guard let scope else { return }
        store.save(roles.routing, scope: scope)
    }
}
