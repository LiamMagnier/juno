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
        static let fastMode = "juno.mobile.composer.fast-mode"
        static let proMode = "juno.mobile.composer.pro-mode"
    }

    /// Per-send. Cleared by ``consumeForSend()``.
    var deepResearch = false

    var webSearch: Bool {
        didSet { defaults.set(webSearch, forKey: Key.webSearch) }
    }

    var canvas: Bool {
        didSet { defaults.set(canvas, forKey: Key.canvas) }
    }

    /// Sticky, like the web's `ComposerPrefs.fastMode` — a reader who wants their
    /// answers served fast wants that generally, not once. Sticky and OFF are
    /// what make it safe: it never turns itself on, and `isArmed` lights the `+`
    /// while it is on, so a 2.5x rate is never running unannounced.
    var fastMode: Bool {
        didSet { defaults.set(fastMode, forKey: Key.fastMode) }
    }

    /// Sticky for the same reason, and cheaper to leave on: pro spends more
    /// tokens at the same rate rather than repricing them.
    var proMode: Bool {
        didSet { defaults.set(proMode, forKey: Key.proMode) }
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
        // Plain `bool(forKey:)` here, deliberately NOT the `object(forKey:)`
        // dance above. That dance exists only because those two default to ON
        // and "never set" has to be told apart from "set to false". These
        // default to OFF, where the two cases mean the same thing — and reusing
        // the pattern with `?? true` would switch a premium rate on for every
        // reader on first launch.
        fastMode = defaults.bool(forKey: Key.fastMode)
        proMode = defaults.bool(forKey: Key.proMode)
    }

    /// Whether anything is armed that the `+` should advertise.
    ///
    /// Deliberately *not* "any tool is on". Web search and canvas are on by
    /// default, so a dot for those would be lit permanently and would say
    /// nothing. This marks the two states a reader would be surprised by: a
    /// research turn is about to cost real time and money, and connectors mean
    /// this message can reach outside Juno.
    /// Flash and Pro join the list for exactly the stated reason: each changes
    /// what the next message costs, which is the surprise this dot exists for.
    var isArmed: Bool { deepResearch || !connectors.isEmpty || fastMode || proMode }

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
            connectors: connectors,
            fastMode: fastMode,
            proMode: proMode
        )
        // Only deepResearch is cleared. Flash and Pro are preferences, not
        // instructions about one question, so they survive the send exactly as
        // web search and canvas do.
        deepResearch = false
        return sent
    }

    struct Sent: Equatable, Sendable {
        let deepResearch: Bool
        let webSearch: Bool
        let canvas: Bool
        let connectors: [String]
        let fastMode: Bool
        let proMode: Bool
    }
}
