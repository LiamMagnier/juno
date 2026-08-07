import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// A workspace file opened for reading, and — in a Code session — for editing.
///
/// It takes the review canvas rather than a sheet: a file is reading material
/// the reader wants beside the composer, and a modal over the transcript hides
/// the conversation the edit is part of. Writes go through the same atomic,
/// fingerprint-checked, checkpointed writer the agent uses, so a manual edit is
/// undoable in exactly the same way an agent edit is.
struct WorkspaceDocumentEditor: View {
    @Bindable var controller: SessionController
    let document: WorkspaceEditorDocument
    let onClose: () -> Void
    let onChange: (WorkspaceEditorDocument) -> Void

    @State private var draft: String = ""
    @State private var loadedPath: String?
    @State private var isSaving = false

    private var isEditable: Bool {
        controller.session.configuration.behavior == .code
    }

    private var isDirty: Bool { draft != document.content }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.junoSeparator)
            TextEditor(text: $draft)
                .font(.junoCode)
                .scrollContentBackground(.hidden)
                .padding(JunoSpace.snug)
                .background(Color.junoTerminal)
                .disabled(!isEditable || isSaving)
                .accessibilityLabel("Contents of \(document.path.value)")
                .accessibilityIdentifier("juno.code.file-editor")
            Divider().overlay(Color.junoSeparator)
            footer
        }
        .task(id: document.id) {
            // Only re-seed when the document itself changes; a save returns a
            // fresh snapshot of the same path and must not discard the caret.
            guard loadedPath != document.id else { return }
            loadedPath = document.id
            draft = document.content
        }
    }

    private var header: some View {
        HStack(spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 1) {
                Text(document.path.lastComponent)
                    .junoRowLabel()
                Text(document.path.value)
                    .junoCodeSmall()
                    .junoSecondaryInk()
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: JunoSpace.snug)
            if isDirty {
                Text("Modified")
                    .junoCaption()
                    .foregroundStyle(Color.junoCaution)
            }
            Text("\(document.lineCount) lines · \(document.byteCount) bytes")
                .junoCaption()
            Button("Close", action: onClose)
                .controlSize(.small)
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .help("Return to the changed files")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .background(Color.junoRaised)
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            if isEditable {
                Button("Reload") { reload() }
                    .controlSize(.small)
                    .disabled(isSaving)
                    .help("Read this file again from disk")
            } else {
                Label(
                    "\(controller.session.configuration.behavior.rawValue.capitalized) sessions are read-only",
                    systemImage: "lock"
                )
                .junoCaption()
            }

            if let error = controller.transientError {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .lineLimit(2)
            }

            Spacer(minLength: JunoSpace.snug)

            if isSaving {
                ProgressView().controlSize(.small)
            }
            Button("Save") { save() }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .keyboardShortcut("s", modifiers: .command)
                .disabled(!isEditable || !isDirty || isSaving)
                .help(
                    isEditable
                        ? "Write this file through a new checkpoint"
                        : "Ask and Plan sessions are read-only"
                )
                .accessibilityIdentifier("juno.code.file-editor.save")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(Color.junoRaised)
    }

    private func reload() {
        isSaving = true
        Task {
            if let refreshed = await controller.openWorkspaceFile(document.path) {
                onChange(refreshed)
                draft = refreshed.content
            }
            isSaving = false
        }
    }

    private func save() {
        isSaving = true
        Task {
            if let saved = await controller.saveWorkspaceFile(document, content: draft) {
                onChange(saved)
                draft = saved.content
            }
            isSaving = false
        }
    }
}
