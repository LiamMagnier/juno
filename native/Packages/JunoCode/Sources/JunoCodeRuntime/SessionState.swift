import Foundation
import JunoCodeCore

/// One part of the session's volatile state: the date and branch, the goal,
/// the enabled skills.
public struct SessionStateSection: Equatable, Sendable {
    /// Also the element the body is written in, so letters, digits and `_`.
    public let name: String
    public let body: String
    /// What decides whether the section is sent again. Nil means the body
    /// itself; a section can narrow it to the facts that matter.
    public let fingerprintSource: String?

    public init(name: String, body: String, fingerprintSource: String? = nil) {
        self.name = name
        self.body = body
        self.fingerprintSource = fingerprintSource
    }

    var fingerprint: String {
        String(Digests.sha256Hex(fingerprintSource ?? body).prefix(16))
    }
}

/// Facts that change during a session, carried in the conversation rather
/// than in the system prompt.
///
/// The system prompt and the tool list head every request's cached prefix,
/// and Anthropic binds each replayed thinking block to them. When the goal,
/// the skills or the date lived in `system`, every `update_goal` rebuilt the
/// prompt: the whole conversation became a cache miss and every signed
/// reasoning block was dropped. Here they ride in a `<session_state>` user
/// block appended after the history. Only the sections whose facts changed
/// since the last block are written, and the block is kept in the history
/// like any other message — removing it again would edit a message a later
/// thinking block was produced after, which invalidates it just the same.
///
/// A block is a plain user message so it replays on every provider and older
/// builds still read the conversation. Its first line names each section and
/// fingerprint, which is how the next request knows what the model already
/// has; nothing inside the bodies is parsed.
public enum SessionState {
    static let marker = "<session_state from=\"juno\""
    static let closingTag = "</session_state>"

    /// What the system prompt says about the blocks, so the model knows what
    /// they are before it meets one.
    public static let systemPromptGuidance = """
        Juno adds <session_state> blocks to the conversation as the session \
        goes on: the date, the Git branch, the durable goal and the enabled \
        skills. Juno writes them, not the reader. Each section in a block \
        replaces the same section of any earlier block, and a section that is \
        not repeated has not changed. Follow the newest version of each.
        """

    /// The block for `sections`, or nil when there is nothing to send.
    public static func render(_ sections: [SessionStateSection]) -> String? {
        guard !sections.isEmpty else { return nil }
        let index = sections.map { "\($0.name):\($0.fingerprint)" }.joined(separator: ",")
        var lines = [
            marker + " sections=\"" + index + "\">",
        ]
        for section in sections {
            lines.append("<\(section.name)>")
            lines.append(section.body.trimmingCharacters(in: .whitespacesAndNewlines))
            lines.append("</\(section.name)>")
        }
        lines.append(closingTag)
        return lines.joined(separator: "\n")
    }

    /// The section fingerprints a block carries, or nil when `text` is not a
    /// block. Read from the opening line alone: the bodies hold skill files
    /// and goal text, which may say anything.
    static func fingerprints(in text: String) -> [String: String]? {
        guard text.hasPrefix(marker) else { return nil }
        let firstLine = text.prefix { $0 != "\n" }
        guard let open = firstLine.range(of: "sections=\""),
              let close = firstLine[open.upperBound...].firstIndex(of: "\"")
        else { return [:] }
        var result: [String: String] = [:]
        for entry in firstLine[open.upperBound..<close].split(separator: ",") {
            let parts = entry.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            result[String(parts[0])] = String(parts[1])
        }
        return result
    }

    /// Each section's newest fingerprint in `messages`: what the model has
    /// been told most recently.
    static func latestFingerprints(in messages: [ModelMessage]) -> [String: String] {
        var result: [String: String] = [:]
        for message in messages {
            guard case let .user(text) = message, let found = fingerprints(in: text) else { continue }
            result.merge(found) { _, newer in newer }
        }
        return result
    }

    /// The sections of `current` the model has not been told yet.
    static func changedSections(
        _ current: [SessionStateSection],
        since messages: [ModelMessage]
    ) -> [SessionStateSection] {
        let known = latestFingerprints(in: messages)
        return current.filter { known[$0.name] != $0.fingerprint }
    }

    static func isBlock(_ message: ModelMessage) -> Bool {
        guard case let .user(text) = message else { return false }
        return text.hasPrefix(marker)
    }
}

extension ModelMessage {
    /// A `<session_state>` block Juno appended, not a turn anyone took.
    var isSessionState: Bool { SessionState.isBlock(self) }
}
