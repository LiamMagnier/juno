import SwiftUI

#if os(macOS)

/// What a rename asks, in the web's dialog words (Phase 4 brief §2.3):
/// "Rename project" / "Change the name of this project." / "Project name" /
/// "Rename Project".
public struct JunoRenameRequest: Identifiable {
    public let id = UUID()
    public var title: String
    public var message: String?
    public var fieldLabel: String
    public var confirmTitle: String
    public var current: String
    public var maximumLength: Int
    /// Saves the new name. Returns whether it was saved; a false keeps the
    /// sheet open with the reader's words in it.
    public var save: @MainActor (String) async -> Bool

    public init(
        title: String,
        message: String? = nil,
        fieldLabel: String,
        confirmTitle: String,
        current: String,
        maximumLength: Int = 200,
        save: @escaping @MainActor (String) async -> Bool
    ) {
        self.title = title
        self.message = message
        self.fieldLabel = fieldLabel
        self.confirmTitle = confirmTitle
        self.current = current
        self.maximumLength = maximumLength
        self.save = save
    }
}

/// The small rename sheet every page shares: projects, artifacts, library
/// files and skills. The sidebar keeps ``JunoInlineRenameField``.
///
/// System-presented and opaque — no custom background, no glass — with an
/// explicit frame (crash rule 2). Cancel is the cancel action; the confirm is
/// the sheet's one prominent button, disabled while the trimmed name is empty
/// or unchanged.
public struct JunoRenameSheet: View {
    private let request: JunoRenameRequest
    private let dismiss: () -> Void

    @State private var draft: String
    @State private var saving = false
    @FocusState private var focused: Bool

    public init(_ request: JunoRenameRequest, dismiss: @escaping () -> Void) {
        self.request = request
        self.dismiss = dismiss
        _draft = State(initialValue: request.current)
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        !saving && !trimmed.isEmpty && trimmed != request.current.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(request.title)
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                if let message = request.message {
                    Text(message)
                        .junoType(.body)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(request.fieldLabel)
                    .junoType(.ui)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.junoForeground)
                TextField(request.fieldLabel, text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .focused($focused)
                    .onSubmit(save)
                    .onChange(of: draft) { _, value in
                        if value.count > request.maximumLength {
                            draft = String(value.prefix(request.maximumLength))
                        }
                    }
                    .accessibilityLabel(request.fieldLabel)
            }
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Cancel", action: dismiss)
                    .contentShape(.rect)
                    .keyboardShortcut(.cancelAction)
                    .disabled(saving)
                Button(request.confirmTitle, action: save)
                    .contentShape(.rect)
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 400)
        .onAppear { focused = true }
    }

    private func save() {
        guard canSave else { return }
        saving = true
        let name = trimmed
        Task {
            let saved = await request.save(name)
            saving = false
            if saved { dismiss() }
        }
    }
}

public extension View {
    /// Presents ``JunoRenameSheet`` while `request` is set.
    func junoRenameSheet(_ request: Binding<JunoRenameRequest?>) -> some View {
        sheet(item: request) { asked in
            JunoRenameSheet(asked) { request.wrappedValue = nil }
        }
    }
}

#endif
