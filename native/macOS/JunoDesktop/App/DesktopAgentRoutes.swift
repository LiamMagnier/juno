import JunoCore
import JunoWorkKit
import SwiftUI

/// The Agents destination: Agents home, and nothing pushed on it. An agent is
/// its thread, which opens in Chat, and its profile, which is a sheet over the
/// window (DIRECTION.md). There is no agent page and no hiring page.
struct DesktopAgentsHome: View {
    let model: NativeAgentsModel
    /// Opens a conversation by id in Chat.
    let openThread: (String) -> Void
    /// Opens a conversation by id in Chat and sends the message as its first.
    let startThread: (String, String) -> Void

    var body: some View {
        NativeAgentsScreen(model: model, openThread: openThread, startThread: startThread)
    }
}

/// The agent whose profile sheet is up, as a sheet's item.
struct DesktopAgentProfileItem: Identifiable, Hashable {
    let id: String
}
