import Foundation
import Observation

/// The tools the composer's `+` menu switches on and off for the next message.
///
/// The website keeps exactly this set in two places, and the split is the whole
/// design: **Web search** and **Canvas & artifacts** live in `ComposerPrefs`
/// (localStorage, sticky across sessions and conversations), **connectors** are
/// per-conversation React state, and **Deep research** is a per-send flag that
/// resets the moment the message goes. Ported literally, because each of those
/// is a different promise:
///
/// - A sticky switch is a preference — "I generally want Juno to be able to
///   search".
/// - A per-conversation one is scoped work — the apps *this* thread may act
///   through, which should not follow you into the next chat.
/// - A per-send one is an instruction about **one** question, and research is
///   expensive enough that leaving it armed after a send is a bill the reader
///   did not agree to.
///
/// Only the sticky pair is written to `UserDefaults`. Nothing here is a mirror
/// of server state: the server re-derives every one of these against the plan
/// and the model's capabilities, so this is what the client *asked for*.
@MainActor
@Observable
final class JunoMobileComposerTools {
    /// The web's cap, restated: `MAX_CHAT_CONNECTORS` in `connector-intent.ts`.
    /// A turn carrying every connected app is a turn whose tool list is longer
    /// than the question.
    static let connectorLimit = 5

    private enum Key {
        static let webSearch = "juno.mobile.composer.web-search"
        static let canvas = "juno.mobile.composer.canvas"
    }

    /// Per-send. Cleared by ``consumeForSend()``.
    var deepResearch = false

    var webSearch: Bool {
        didSet { defaults.set(webSearch, forKey: Key.webSearch) }
    }

    var canvas: Bool {
        didSet { defaults.set(canvas, forKey: Key.canvas) }
    }

    /// Per-conversation, in the order they were picked.
    var connectors: [String] = []

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `object(forKey:)` rather than `bool(forKey:)`: both of these default to
        // ON, and `bool(forKey:)` cannot tell "never set" from "set to false", so
        // it would silently turn web search off for everyone on first launch.
        webSearch = defaults.object(forKey: Key.webSearch) as? Bool ?? true
        canvas = defaults.object(forKey: Key.canvas) as? Bool ?? true
    }

    /// Whether anything is armed that the `+` should advertise.
    ///
    /// Deliberately *not* "any tool is on". Web search and canvas are on by
    /// default, so a dot for those would be lit permanently and would say
    /// nothing. This marks the two states a reader would be surprised by: a
    /// research turn is about to cost real time and money, and connectors mean
    /// this message can reach outside Juno.
    var isArmed: Bool { deepResearch || !connectors.isEmpty }

    var canAddConnector: Bool { connectors.count < Self.connectorLimit }

    func toggleConnector(_ id: String) {
        if let index = connectors.firstIndex(of: id) {
            connectors.remove(at: index)
        } else if canAddConnector {
            connectors.append(id)
        }
    }

    func isConnectorEnabled(_ id: String) -> Bool { connectors.contains(id) }

    /// Drops the per-conversation scope. Called when the reader moves to another
    /// thread — the apps chosen for one conversation are not a global setting.
    func resetForConversationChange() {
        connectors = []
        deepResearch = false
    }

    /// The flags for the message being sent, and the reset that has to happen
    /// with them.
    ///
    /// One call rather than "read four properties, then remember to clear one":
    /// the clearing is the easy half to forget, and forgetting it bills the next
    /// message for a research run nobody asked for.
    func consumeForSend() -> Sent {
        let sent = Sent(
            deepResearch: deepResearch,
            webSearch: webSearch,
            canvas: canvas,
            connectors: connectors
        )
        deepResearch = false
        return sent
    }

    struct Sent: Equatable, Sendable {
        let deepResearch: Bool
        let webSearch: Bool
        let canvas: Bool
        let connectors: [String]
    }
}
