import JunoDesignSystem
import SwiftUI

/// The username field (`account-username.tsx`): "@" drawn in front of what
/// you type, the live answer as one quiet line under it, and Save once the
/// name is available. Rows for a grouped Form on either platform; the host
/// decides when it is shown.
public struct NativeUsernameFieldRows: View {
    @Bindable private var model: NativeUsernameModel
    private let onSaved: (String) -> Void
    private let onCancel: (() -> Void)?
    @FocusState private var focused: Bool

    public init(model: NativeUsernameModel, onSaved: @escaping (String) -> Void = { _ in }, onCancel: (() -> Void)? = nil) {
        self.model = model
        self.onSaved = onSaved
        self.onCancel = onCancel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(spacing: JunoSpace.micro) {
                Text(verbatim: "@")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                TextField(
                    "Username",
                    text: Binding(get: { model.value }, set: { model.setValue($0) }),
                    prompt: Text(model.handle ?? "username")
                )
                .labelsHidden()
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.asciiCapable)
                .textContentType(.username)
                #endif
                .focused($focused)
                .disabled(model.saving)
                .onSubmit { Task { await save() } }
                .accessibilityLabel("Username")
                .accessibilityHint(model.statusText)
                .accessibilityIdentifier("juno.username.field")
            }
            Text(model.statusText)
                .font(.footnote)
                .foregroundStyle(model.isProblem ? Color.junoDestructiveInk : Color.secondary)
                .frame(maxWidth: .infinity, minHeight: 18, alignment: .leading)
                .accessibilityAddTraits(.updatesFrequently)
            if let error = model.saveError {
                Label(error, image: JunoIcon.warning.assetName)
                    .font(.footnote)
                    .foregroundStyle(Color.junoDestructiveInk)
            }
            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                if let onCancel {
                    Button("Cancel", action: onCancel)
                        .contentShape(.rect)
                        .disabled(model.saving)
                        .keyboardShortcut(.cancelAction)
                }
                Button {
                    Task { await save() }
                } label: {
                    if model.saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .contentShape(.rect)
                .disabled(!model.canSave)
                .accessibilityIdentifier("juno.username.save")
            }
        }
        .onAppear { focused = true }
    }

    private func save() async {
        if await model.save(), let name = model.username { onSaved(name) }
    }
}

/// The username's resting line: the chosen @name, or until there is one, the
/// handle the profile shows meanwhile.
public enum NativeUsernameCopy {
    public static func description(username: String?, fallback: String?) -> String {
        if let username { return "@\(username)" }
        if let fallback { return "Not chosen yet. Your profile shows @\(fallback)." }
        return "Not chosen yet."
    }
}
