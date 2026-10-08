import JunoAuth
import JunoChatKit
import Observation
import SwiftUI

/// The profile page (`/profile`) as a Chat-window destination: the shared
/// ``NativeProfileView`` fed by `GET /api/profile/activity`. Reached from the
/// account menu's Profile row (``DesktopPageRouter``).
struct DesktopProfileScreen: View {
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    var startChat: (() -> Void)?

    @State private var model: NativeProfileModel?

    var body: some View {
        Group {
            if let model {
                NativeProfileView(
                    model: model,
                    identity: NativeProfileIdentity(
                        name: session.profile.name,
                        fallbackHandle: NativeProfileIdentity.derivedHandle(email: session.profile.email, name: session.profile.name),
                        imageData: configuration.avatarModel?.imageData,
                        imageURL: session.profile.imageURL
                    ),
                    onEdit: { DesktopProfileLinks.shared.editUsername() },
                    onStartChat: startChat
                )
                .frame(maxWidth: 860)
                .frame(maxWidth: .infinity)
            } else {
                ContentUnavailableView("Profile unavailable", systemImage: "person.crop.circle", description: Text("Sign in again to see your activity."))
            }
        }
        .onAppear {
            if model == nil, let sender = configuration.requestSender {
                model = NativeProfileModel(client: NativeProfileClient(sender: sender), accountID: session.profile.id)
            }
        }
    }
}

/// The profile's Edit: Settings › Account with the username field open, as
/// the web's `/settings?section=account&focus=username`. The request is held
/// until the Account pane takes it, because Settings is its own window.
@MainActor
@Observable
final class DesktopProfileLinks {
    static let shared = DesktopProfileLinks()

    /// Set by Edit; the Account pane opens its username field and clears it.
    private(set) var usernameFocusRequest: UUID?

    func editUsername() {
        usernameFocusRequest = UUID()
        DesktopSettingsRouter.open(.account)
    }

    /// The pane took the request.
    func takeUsernameFocus() -> Bool {
        guard usernameFocusRequest != nil else { return false }
        usernameFocusRequest = nil
        return true
    }
}
