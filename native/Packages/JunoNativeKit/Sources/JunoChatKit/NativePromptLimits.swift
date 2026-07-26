import Foundation

/// Prompt / input size policy, ported from the website's `src/lib/prompt-limits.ts`.
///
/// There is intentionally **no application character cap** on a chat message.
/// The only real limit is the selected model's context window, enforced by the
/// provider. Everything here is a *soft* UI rule so a pasted curriculum does not
/// turn the composer into a wall of text or the transcript into a screen the
/// reader has to scroll past to reach their answer. The full text is always what
/// gets sent and stored.
///
/// The numbers live here rather than in either app because a bubble that
/// collapses on the phone and not on the Mac is not one product. They are the
/// web's own values; if they move there, they move here.
public enum NativePromptLimits {
    /// Above this — or past ``longMessageLines`` lines — a user bubble is drawn
    /// collapsed with a "Show more" control under it. The web's rule exactly:
    /// `view.content.length > 700 || lineCount > 14`.
    public static let longMessageCharacters = 700
    public static let longMessageLines = 14

    /// The collapsed bubble's height cap, in points. Chosen to match the web's
    /// `max-h-60` (240px) — enough to read the opening of a prompt and recognise
    /// it, short enough that the answer stays on screen.
    public static let collapsedMessageHeight: CGFloat = 240

    /// Above this the composer stops keeping the draft live in the text field
    /// and shows a compact "large paste" card instead. Tens of thousands of
    /// characters in an auto-sizing `TextField` is a per-keystroke relayout of
    /// the whole composer; the text itself is untouched and still sent.
    public static let composerInlineSoftCharacters = 8_000

    /// Once a draft is this long the composer offers, quietly, to send it as a
    /// file instead. An offer and not a rule — a long message is a legitimate
    /// thing to send, and the web only ever suggests.
    public static let composerLongTextCharacters = 1_500
    public static let composerLongTextLines = 30

    /// The name a draft gets when it is attached rather than typed. The same
    /// name the web's `attachAsFile` uses, so the two clients produce the same
    /// message.
    public static let attachedPromptFileName = "prompt.txt"
    public static let attachedPromptMimeType = "text/plain"

    /// Newline count over the head of the string only.
    ///
    /// Never `split(separator:)` on a draft: that allocates a substring per line
    /// of a multi-megabyte paste, on the main actor, purely to decide whether to
    /// draw a button. Sampling the first few thousand characters answers the
    /// only question being asked — "is this long?" — at a bounded cost.
    public static func sampleLineCount(_ text: String, sampleCharacters: Int = 4_000) -> Int {
        guard !text.isEmpty else { return 0 }
        var lines = 1
        var scanned = 0
        for character in text.utf8 {
            if scanned >= sampleCharacters { break }
            if character == 0x0A { lines += 1 }
            scanned += 1
        }
        return lines
    }

    /// Whether a *sent* message should be drawn collapsed.
    public static func isLongMessage(_ text: String) -> Bool {
        text.count > longMessageCharacters || sampleLineCount(text) > longMessageLines
    }

    /// What the "Show more" control says it is hiding.
    ///
    /// The web writes "22 lines" unconditionally, which is right for the case it
    /// was built for — a pasted system prompt is line-shaped — and wrong for the
    /// other one: a single long paragraph has no newlines at all, and the control
    /// then read "Show more · 1 lines", which is both ungrammatical and useless.
    /// A prompt with no line structure is measured in characters instead, which
    /// is the only thing about it that is worth stating.
    public static func collapsedSummary(
        for text: String,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let lines = sampleLineCount(text)
        guard lines > 1 else {
            return "\(text.count.formatted(.number.locale(locale))) characters"
        }
        return "\(lines.formatted(.number.locale(locale))) lines"
    }

    /// Whether a *draft* is long enough to be worth offering as a file.
    public static func isLongDraft(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).count > composerLongTextCharacters
            || sampleLineCount(text) > composerLongTextLines
    }

    /// Whether a draft is too large to keep live in the composer's text field.
    public static func isHugeDraft(_ text: String) -> Bool {
        text.count > composerInlineSoftCharacters
    }
}
