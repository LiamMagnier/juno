import SwiftUI

#if os(macOS)

// MARK: - Confirmation

/// A destructive choice put to the reader (spec §7.1): the system's
/// confirmation dialog, its title always visible, one button in the role
/// that says what it does, Cancel, and the web's own words.
///
/// `.alert` is for errors only. Set a value to ask; the dialog clears it on
/// either answer.
///
/// ```swift
/// @State private var confirmation: JunoConfirmation?
/// …
/// confirmation = JunoConfirmation(
///     title: "Delete this design?",
///     message: "Every version of this design and its history will be removed.",
///     confirmTitle: "Delete"
/// ) { Task { await delete(design) } }
/// …
/// .junoConfirmation($confirmation)
/// ```
public struct JunoConfirmation: Identifiable {
    public let id = UUID()
    public var title: String
    public var message: String?
    /// The confirming button's words, Title Case (§0.7): "Delete", "Leave".
    public var confirmTitle: String
    /// `.destructive` unless the choice destroys nothing.
    public var role: ButtonRole?
    public var confirm: @MainActor () -> Void

    public init(
        title: String,
        message: String? = nil,
        confirmTitle: String,
        role: ButtonRole? = .destructive,
        confirm: @escaping @MainActor () -> Void
    ) {
        self.title = title
        self.message = message
        self.confirmTitle = confirmTitle
        self.role = role
        self.confirm = confirm
    }
}

public extension View {
    /// Presents `confirmation` as the system's confirmation dialog while it is
    /// set. See ``JunoConfirmation``.
    func junoConfirmation(_ confirmation: Binding<JunoConfirmation?>) -> some View {
        let title = confirmation.wrappedValue?.title ?? ""
        let isPresented = Binding(
            get: { confirmation.wrappedValue != nil },
            set: { if !$0 { confirmation.wrappedValue = nil } }
        )
        // Opener and buttons on one line: the targets gate reads a dialog's
        // buttons as system-drawn only when its brace opens on that line.
        return self.confirmationDialog(title, isPresented: isPresented, titleVisibility: .visible, presenting: confirmation.wrappedValue) { asked in
            Button(asked.confirmTitle, role: asked.role) {
                confirmation.wrappedValue = nil
                asked.confirm()
            }
            Button("Cancel", role: .cancel) {
                confirmation.wrappedValue = nil
            }
        } message: { asked in
            if let message = asked.message {
                Text(message)
            }
        }
    }
}

// MARK: - Inline rename

/// A list row's name, being renamed in place (spec §7.1, "Rename: inline in
/// list rows"): the row's own words become a plain field, focused and filled
/// with the current name.
///
/// - Return commits; losing focus commits, as on the web.
/// - Esc cancels, and the field ends before focus leaves, so a cancel is
///   never committed on the way out.
/// - The name is trimmed; an empty name, or the one it already had, commits
///   nothing and just ends the rename.
///
/// `end` is called on every way out and clears whatever marks the row as
/// renaming; `commit` gets only a real change.
public struct JunoInlineRenameField: View {
    private let current: String
    private let accessibilityLabel: String
    private let commit: (String) -> Void
    private let end: () -> Void

    @State private var draft = ""
    @State private var hasEnded = false
    @FocusState private var isFocused: Bool

    public init(
        _ current: String,
        accessibilityLabel: String,
        commit: @escaping (String) -> Void,
        end: @escaping () -> Void
    ) {
        self.current = current
        self.accessibilityLabel = accessibilityLabel
        self.commit = commit
        self.end = end
    }

    public var body: some View {
        TextField("Name", text: $draft)
            .textFieldStyle(.plain)
            .focused($isFocused)
            .onSubmit(finish)
            .onExitCommand(perform: cancel)
            .task {
                draft = current
                isFocused = true
            }
            .onChange(of: isFocused) { wasFocused, focused in
                if wasFocused, !focused { finish() }
            }
            .accessibilityLabel(accessibilityLabel)
    }

    /// The new name, if it is one: trimmed, not empty, not the same.
    public static func change(from current: String, to draft: String) -> String? {
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != current else { return nil }
        return name
    }

    private func finish() {
        guard !hasEnded else { return }
        hasEnded = true
        let change = Self.change(from: current, to: draft)
        end()
        if let change { commit(change) }
    }

    private func cancel() {
        guard !hasEnded else { return }
        hasEnded = true
        end()
    }
}

#endif
