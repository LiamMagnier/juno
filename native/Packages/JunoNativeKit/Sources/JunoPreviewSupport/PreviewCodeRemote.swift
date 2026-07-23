#if DEBUG
import Foundation

/// Canned Juno Code Remote payloads in the exact wire shapes the relay serves,
/// so the phone's Code screens can be inspected — and screenshotted — without an
/// account, a network, or a Mac running a host.
///
/// The fixture deliberately covers the states that are easy to get wrong: an
/// online host and an offline one, a session that is running, a session waiting
/// on an approval, and a transcript mixing user text, assistant markdown, a tool
/// call and a completion.
public enum PreviewCodeRemote {
    public static let devicesJSON = """
    {"devices":[
      {"id":"studio","name":"Studio","platform":"macos","online":true,
       "lastSeenAt":"2026-07-23T02:40:00.000Z",
       "workspaces":[{"name":"juno"},{"name":"juno-windows"}]},
      {"id":"laptop","name":"MacBook Air","platform":"macos","online":false,
       "lastSeenAt":"2026-07-21T18:04:00.000Z",
       "workspaces":[{"name":"juno"}]}
    ]}
    """

    public static let sessionsJSON = """
    {"sessions":[
      {"sessionID":"s1","deviceID":"studio","title":"Rebuild the composer control row",
       "modelID":"anthropic:claude-sonnet-4-6","permissionMode":"ask","currentStatus":"running",
       "isRunning":true,"isAwaitingApproval":false,"pendingChangeCount":3,
       "workspaceName":"juno","activeBranch":"agent/composer-row",
       "lastEventSequence":4,
       "updatedAt":"2026-07-23T02:41:00.000Z","lastMessageAt":"2026-07-23T02:41:00.000Z"},
      {"sessionID":"s2","deviceID":"studio","title":"Port the greeting to iPad",
       "modelID":"anthropic:claude-sonnet-4-6","permissionMode":"ask","currentStatus":"waiting",
       "isRunning":false,"isAwaitingApproval":true,"pendingChangeCount":0,
       "workspaceName":"juno","lastEventSequence":9,
       "updatedAt":"2026-07-23T01:10:00.000Z","lastMessageAt":"2026-07-23T01:10:00.000Z"}
    ]}
    """

    public static let eventsJSON = """
    {"events":[
      {"seq":1,"kind":"user_message","createdAt":"2026-07-23T02:40:10.000Z",
       "payload":{"text":"The + in the composer does nothing on my iPhone."}},
      {"seq":2,"kind":"assistant_message","createdAt":"2026-07-23T02:40:22.000Z",
       "payload":{"text":"Two defects, not one.\\n\\n- The hit area collapsed to **13.3pt** — the bare glyph.\\n- The touch is taken by the system's leading edge-pan recogniser."}},
      {"seq":3,"kind":"tool_call","createdAt":"2026-07-23T02:40:31.000Z",
       "payload":{"name":"xcodebuild test"}},
      {"seq":4,"kind":"completed","createdAt":"2026-07-23T02:40:58.000Z","payload":{}}
    ]}
    """
}
#endif
