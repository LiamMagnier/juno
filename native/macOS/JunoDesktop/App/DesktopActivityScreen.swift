import AppKit
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Activity (G70) in the Mac's Chat column: the shared ``NativeActivityView``
/// over `GET /api/activity`, the same list the web's `/activity` draws.
///
/// A row opens where it lives. A task or a research run started from a chat
/// opens that chat here, where its approval card and its question already
/// render; anything else (a Code task, a task with no chat) opens its page on
/// the web, which is where those are answered today.
struct DesktopActivityScreen: View {
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    let openConversation: (String) -> Void
    var startChat: (() -> Void)?

    @State private var model: NativeActivityModel?

    var body: some View {
        Group {
            if let model {
                NativeActivityView(model: model, onOpen: open, onStartChat: startChat)
                    .frame(maxWidth: 860)
                    .frame(maxWidth: .infinity)
            } else {
                ContentUnavailableView {
                    Label("Activity unavailable", image: JunoIcon.chartLine.assetName)
                } description: {
                    Text("Sign in again to see what is running.")
                }
            }
        }
        .onAppear {
            if model == nil, let sender = configuration.requestSender {
                model = NativeActivityModel(client: NativeActivityClient(sender: sender), accountID: session.profile.id)
            }
        }
    }

    private func open(_ item: NativeActivityItem) {
        if item.kind != .code, let conversationID = item.conversationID {
            openConversation(conversationID)
            return
        }
        if let url = Self.webURL(for: item) { NSWorkspace.shared.open(url) }
    }

    /// The item's page on the web, from the in-app path the route sends.
    static func webURL(for item: NativeActivityItem) -> URL? {
        guard item.href.hasPrefix("/"), let base = URL(string: JunoBackend.productionURLString) else { return nil }
        return URL(string: item.href, relativeTo: base)?.absoluteURL
    }
}
