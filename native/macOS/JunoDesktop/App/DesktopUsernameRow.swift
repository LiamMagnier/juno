import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Settings › Account › Username (`account-username.tsx`): at rest the
/// handle and one button; Change opens the field in the row itself, checked
/// as you type against `GET /api/account/username?check=` and saved with
/// `PATCH`. The profile's Edit lands here with the field open.
struct DesktopUsernameRow: View {
    let context: DesktopSettingsContext

    @State private var model: NativeUsernameModel?
    @State private var editing = false
    private let links = DesktopProfileLinks.shared

    var body: some View {
        Group {
            if let model {
                DesktopSettingRow(
                    title: "Username",
                    description: NativeUsernameCopy.description(username: model.username, fallback: model.handle)
                ) {
                    if !editing {
                        DesktopOutlineButton(title: model.username == nil ? "Choose" : "Change") { open(model) }
                            .disabled(!model.loaded)
                            .accessibilityLabel(model.username == nil ? "Choose a username" : "Change username")
                            .accessibilityIdentifier("juno.desktop.settings.username")
                    }
                }
                if editing {
                    NativeUsernameFieldRows(
                        model: model,
                        onSaved: { name in
                            editing = false
                            context.toasts.post(.success("Your username is now @\(name)."))
                        },
                        onCancel: { editing = false }
                    )
                    .padding(.vertical, JunoSpace.tight)
                }
            }
        }
        .task {
            guard model == nil, let sender = context.services.sender else { return }
            let created = NativeUsernameModel(client: NativeUsernameClient(sender: sender), accountID: context.accountID)
            model = created
            await created.load()
            if links.takeUsernameFocus() { open(created) }
        }
        .onChange(of: links.usernameFocusRequest) { _, request in
            guard request != nil, let model, links.takeUsernameFocus() else { return }
            open(model)
        }
    }

    private func open(_ model: NativeUsernameModel) {
        model.beginEditing()
        editing = true
    }
}
