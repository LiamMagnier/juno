import Foundation
import JunoDesignSystem
import SwiftUI

/// Dictation and voice for Code's composers, as the host hands them in.
///
/// The microphone and the call are the app's (Chat's dictation capsule, the
/// realtime call and its bar live in the app target, outside this package), so
/// a composer here only draws the two buttons and accepts what was heard. The
/// host owns both sessions and sends the words back as a ``CodeHeardText``.
public struct CodeComposerSpeech {
    /// Starts dictation. Nil draws no microphone (no recogniser on this Mac).
    public var dictate: (() -> Void)?
    /// Starts a voice conversation with this thread. Nil draws no voice button
    /// (signed out, no plan, or a call is already live).
    public var talk: (() -> Void)?
    /// What was heard, for this composer to take. A new value (a new `id`) is
    /// taken once.
    public var heard: CodeHeardText?

    public init(dictate: (() -> Void)? = nil, talk: (() -> Void)? = nil, heard: CodeHeardText? = nil) {
        self.dictate = dictate
        self.talk = talk
        self.heard = heard
    }
}

/// Words that arrived by voice, and what the composer should do with them.
public struct CodeHeardText: Equatable, Identifiable {
    public enum Disposition: Equatable {
        /// Dictation stopped: the words join the draft, for editing.
        case append
        /// Dictation's send: the words join the draft and the draft goes.
        case appendAndSend
        /// A spoken request in a call: these words alone become the thread's
        /// next turn, through the same send, steer or queue as typed words.
        /// The draft is left as it was.
        case sendAlone
    }

    public let id: UUID
    public let text: String
    public let disposition: Disposition

    public init(id: UUID = UUID(), text: String, disposition: Disposition) {
        self.id = id
        self.text = text
        self.disposition = disposition
    }

    /// `draft` with these words joined to it: one space between, nothing
    /// added when either side is empty.
    public func joined(to draft: String) -> String {
        let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let existing = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if spoken.isEmpty { return draft }
        return existing.isEmpty ? spoken : "\(existing) \(spoken)"
    }
}

/// The microphone and the voice button, at the end of a Code composer's
/// controls row, before Send: Chat's order (Dictate, then the voice chat).
struct CodeComposerSpeechButtons: View {
    let speech: CodeComposerSpeech?
    var isEnabled = true

    var body: some View {
        if let dictate = speech?.dictate {
            Button(action: dictate) { JunoIconView(.mic, size: 15) }
                .buttonStyle(StudioIconButtonStyle())
                .disabled(!isEnabled)
                .help("Dictate")
                .accessibilityLabel("Dictate")
                .accessibilityIdentifier("juno.code.composer.dictate")
        }
        if let talk = speech?.talk {
            Button(action: talk) { JunoIconView(.audioLines, size: 15) }
                .buttonStyle(StudioIconButtonStyle())
                .disabled(!isEnabled)
                .help("Voice conversation")
                .accessibilityLabel("Start voice conversation")
                .accessibilityIdentifier("juno.code.composer.voice")
        }
    }
}
