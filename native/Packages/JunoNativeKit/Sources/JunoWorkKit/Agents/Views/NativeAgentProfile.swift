import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Profile: name, role, face, style and brief; Autonomy with the floor spelled
/// out; the apps it may use; whether it suggests things on its own; **What it
/// knows** — the agent's own memory, each note editable and deletable, with
/// Export; and Delete.
///
/// The fields edit a local copy and Save sends only what changed, because
/// `PATCH /api/agents/{id}` treats every present field as an instruction. The
/// view is keyed on the agent's id by its caller, so a poll that refreshes the
/// agent never throws away what is being typed.
struct NativeAgentProfileTab: View {
    let model: NativeAgentsModel
    let agent: NativeAgent
    let notes: [NativeAgentNote]
    let apps: [NativeAgentAppChoice]
    let delete: () -> Void

    @State private var name: String
    @State private var role: String
    @State private var avatar: JunoAgentAvatar
    @State private var style: NativeAgentStyle
    @State private var instructions: String
    @State private var approvalMode: JunoWorkPermissionPolicy
    @State private var connectorIDs: [String]
    @State private var proactive: Bool
    @State private var newNote = ""
    @State private var editingNoteID: String?
    @State private var editingText = ""

    init(
        model: NativeAgentsModel,
        agent: NativeAgent,
        notes: [NativeAgentNote],
        apps: [NativeAgentAppChoice],
        delete: @escaping () -> Void
    ) {
        self.model = model
        self.agent = agent
        self.notes = notes
        self.apps = apps
        self.delete = delete
        _name = State(initialValue: agent.name)
        _role = State(initialValue: agent.role)
        _avatar = State(initialValue: agent.avatar)
        _style = State(initialValue: agent.style)
        _instructions = State(initialValue: agent.instructions)
        _approvalMode = State(initialValue: agent.approvalMode)
        _connectorIDs = State(initialValue: agent.connectorIDs)
        _proactive = State(initialValue: agent.proactive)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.region) {
            identity
            talk
            brief
            autonomy
            appsSection
            initiative
            saveBar
            Divider()
            knows
            Divider()
            retire
        }
    }

    // MARK: Fields

    private var identity: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            NativeAgentHeading(title: "Who it is")
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                JunoAgentFace(avatar: avatar, state: agent.state, size: JunoAgentFaceSize.md)
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        NativeAgentFieldLabel(title: "Name")
                        TextField("Name", text: $name)
                            .nativeAgentField()
                    }
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        NativeAgentFieldLabel(title: "What it is for")
                        TextField("Inbox and calendar", text: $role)
                            .nativeAgentField()
                    }
                }
            }
            NativeAgentFaceBuilder(avatar: $avatar)
        }
    }

    private var talk: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            NativeAgentHeading(title: "How it talks")
            NativeAgentStylePicker(style: $style)
        }
    }

    private var brief: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            NativeAgentHeading(title: "Its brief")
            TextEditor(text: $instructions)
                .font(.body)
                .nativeAgentWell(minHeight: 160)
                .accessibilityLabel("Its brief")
        }
    }

    private var autonomy: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            NativeAgentHeading(title: "Autonomy")
            NativeAgentAutonomyPicker(mode: $approvalMode)
        }
    }

    private var appsSection: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            NativeAgentHeading(title: "Connected apps it may use")
            NativeAgentAppPicker(apps: apps, selection: $connectorIDs)
        }
    }

    private var initiative: some View {
        Toggle(isOn: $proactive) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Suggest ideas on its own")
                    .font(.callout.weight(.medium))
                    .junoInk()
                Text("It thinks things over at most every six hours and writes ideas you can start. It never starts work from one without you.")
                    .font(.callout)
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Color.junoAccent)
    }

    private var saveBar: some View {
        HStack(spacing: JunoSpace.snug) {
            Spacer(minLength: 0)
            Button("Revert", action: revert)
                .buttonStyle(.borderless)
                .disabled(patch.isEmpty || model.isMutating)
                .frame(minHeight: NativeAgentMetrics.target)
                .contentShape(.rect)
            Button("Save changes", action: save)
                .buttonStyle(.bordered)
                .nativeAgentNeutralTint()
                .disabled(!canSave || model.isMutating)
                .frame(minHeight: NativeAgentMetrics.target)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.agents.profile.save")
        }
    }

    // MARK: What it knows

    private var knows: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .center, spacing: JunoSpace.snug) {
                NativeAgentHeading(title: "What it knows")
                Spacer(minLength: JunoSpace.snug)
                if !notes.isEmpty {
                    ShareLink(item: exportText, subject: Text("What \(agent.name) knows")) {
                        Label("Export", icon: .download)
                            .font(.callout)
                    }
                    .frame(minHeight: NativeAgentMetrics.target)
                }
            }
            Text("Its own memory: what you told it and what it worked out. Every note is yours to edit or delete.")
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: JunoSpace.snug) {
                TextField("Something it should know", text: $newNote)
                    .nativeAgentField()
                    .onSubmit(addNote)
                Button("Add", action: addNote)
                    .buttonStyle(.bordered)
                    .nativeAgentNeutralTint()
                    .disabled(trimmedNewNote.isEmpty || model.isMutating)
                    .frame(minHeight: NativeAgentMetrics.target)
                    .contentShape(.rect)
            }
            if notes.isEmpty {
                Text("Nothing yet. What it learns from its work appears here.")
                    .font(.callout)
                    .junoSecondaryInk()
            } else {
                ForEach(notes) { note in
                    noteView(note)
                }
            }
        }
    }

    @ViewBuilder
    private func noteView(_ note: NativeAgentNote) -> some View {
        if editingNoteID == note.id {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                TextEditor(text: $editingText)
                    .font(.body)
                    .nativeAgentWell(minHeight: 80)
                    .accessibilityLabel("Note")
                HStack(spacing: JunoSpace.snug) {
                    Spacer(minLength: 0)
                    Button("Cancel") { editingNoteID = nil }
                        .buttonStyle(.borderless)
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                    Button("Save") { saveNote(note) }
                        .buttonStyle(.bordered)
                        .nativeAgentNeutralTint()
                        .disabled(
                            editingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || model.isMutating
                        )
                        .frame(minHeight: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
            }
            .nativeAgentTile()
        } else {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.content)
                        .font(.callout)
                        .junoInk()
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(noteMeta(note))
                        .junoCaption()
                }
                Spacer(minLength: JunoSpace.snug)
                Menu {
                    Button("Edit") {
                        editingText = note.content
                        editingNoteID = note.id
                    }
                    Button("Delete", role: .destructive) {
                        Task { await model.deleteNote(agentID: agent.id, noteID: note.id) }
                    }
                } label: {
                    JunoIconView(.ellipsis, size: 14)
                        .junoSecondaryInk()
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(minWidth: NativeAgentMetrics.target, minHeight: NativeAgentMetrics.target)
                .contentShape(.rect)
                .accessibilityLabel("Note actions")
            }
            .nativeAgentTile()
        }
    }

    // MARK: Delete

    private var retire: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            NativeAgentHeading(title: "Delete this agent")
            Text("Its routines stop. Its thread and its tasks stay, as ordinary chats and tasks.")
                .font(.callout)
                .junoSecondaryInk()
                .fixedSize(horizontal: false, vertical: true)
            Button(role: .destructive, action: delete) {
                Text("Delete \(agent.name)…")
            }
            .buttonStyle(.bordered)
            .nativeAgentNeutralTint()
            .frame(minHeight: NativeAgentMetrics.target)
            .contentShape(.rect)
        }
    }

    // MARK: Editing

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedNewNote: String {
        newNote.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Only what differs from the agent as the server last described it.
    private var patch: NativeAgentPatch {
        var patch = NativeAgentPatch()
        if trimmedName != agent.name { patch.name = trimmedName }
        let trimmedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedRole != agent.role { patch.role = trimmedRole }
        if avatar != agent.avatar { patch.avatar = avatar }
        if style != agent.style { patch.style = style }
        let trimmedBrief = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedBrief != agent.instructions { patch.instructions = trimmedBrief }
        if approvalMode != agent.approvalMode { patch.approvalMode = approvalMode }
        if Set(connectorIDs) != Set(agent.connectorIDs) { patch.connectorIDs = connectorIDs }
        if proactive != agent.proactive { patch.proactive = proactive }
        return patch
    }

    private var canSave: Bool {
        !patch.isEmpty
            && !trimmedName.isEmpty
            && trimmedName.count <= NativeAgentLimits.name
            && role.trimmingCharacters(in: .whitespacesAndNewlines).count <= NativeAgentLimits.role
            && instructions.trimmingCharacters(in: .whitespacesAndNewlines).count <= NativeAgentLimits.instructions
    }

    private func save() {
        let submitted = patch
        guard canSave else { return }
        Task { await model.update(id: agent.id, submitted) }
    }

    private func revert() {
        name = agent.name
        role = agent.role
        avatar = agent.avatar
        style = agent.style
        instructions = agent.instructions
        approvalMode = agent.approvalMode
        connectorIDs = agent.connectorIDs
        proactive = agent.proactive
    }

    private func addNote() {
        let content = trimmedNewNote
        guard !content.isEmpty else { return }
        Task {
            if await model.addNote(agentID: agent.id, content: content) {
                newNote = ""
            }
        }
    }

    private func saveNote(_ note: NativeAgentNote) {
        let content = editingText
        Task {
            if await model.updateNote(agentID: agent.id, noteID: note.id, content: content) {
                editingNoteID = nil
            }
        }
    }

    private func noteMeta(_ note: NativeAgentNote) -> String {
        guard let at = note.createdAt else { return note.sourceLabel }
        return "\(note.sourceLabel) · \(NativeAgentFormat.ago(at))"
    }

    /// What it knows as plain text, the shape a person can keep: one note a
    /// line, each with who wrote it.
    private var exportText: String {
        let lines = notes.map { note in
            "- \(note.content) (\(note.sourceLabel.lowercased()))"
        }
        return "What \(agent.name) knows\n\n" + lines.joined(separator: "\n")
    }
}
