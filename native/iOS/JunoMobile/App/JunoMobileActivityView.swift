import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

/// Activity (G70) on the iPhone and iPad: the shared ``NativeActivityView``
/// over `GET /api/activity`, reached from the drawer (and the iPad sidebar).
///
/// A row opens where it lives: a task or research run started from a chat
/// opens that chat, where its approval card and question render; a Code task
/// or a task with no chat opens its page on the web.
struct JunoMobileActivityView: View {
  let session: NativeAuthenticatedSession?
  let requestSender: (any NativeAuthenticatedRequestSending)?
  let openConversation: (String) -> Void
  var startChat: (() -> Void)?

  @State private var model: NativeActivityModel?
  @Environment(\.openURL) private var openURL

  var body: some View {
    Group {
      if let model {
        NativeActivityView(model: model, onOpen: open, onStartChat: startChat)
      } else {
        JunoEmptyState(
          title: "Activity unavailable",
          message: "Sign in again to see what is running.",
          icon: .chartLine
        )
      }
    }
    .onAppear {
      if model == nil, let requestSender, let session {
        model = NativeActivityModel(
          client: NativeActivityClient(sender: requestSender), accountID: session.profile.id)
      }
    }
  }

  private func open(_ item: NativeActivityItem) {
    if item.kind != .code, let conversationID = item.conversationID {
      openConversation(conversationID)
      return
    }
    if let url = Self.webURL(for: item) { openURL(url) }
  }

  /// The item's page on the web, from the in-app path the route sends.
  static func webURL(for item: NativeActivityItem) -> URL? {
    guard item.href.hasPrefix("/") else { return nil }
    return URL(string: item.href, relativeTo: JunoBackend.productionURL)?.absoluteURL
  }
}
