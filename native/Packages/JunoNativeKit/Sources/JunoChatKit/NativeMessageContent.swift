import Foundation

/// Juno's message wire format, as the client has to render it.
///
/// The model wraps durable memories and clarification wizards in custom tags
/// that are instructions to Juno, not prose for the reader. The website strips
/// them in `cleanForDisplay` (`src/lib/message-content.ts`); the native clients
/// did not, so a reply that happened to write a memory rendered
/// `juno:memoryThe user is following a structured…</juno:memory>` straight into
/// the transcript.
///
/// This is deliberately a *display* transform only. The stored message keeps its
/// tags, because the server parses the same text to persist the memory — hiding
/// them at render time is the whole job.
public enum NativeMessageContent {
    /// Strips everything that is markup-for-Juno rather than text-for-the-reader.
    public static func cleanForDisplay(_ text: String) -> String {
        var output = removeTagged(text, tag: "juno:memory")
        output = removeClarificationWizards(output)
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Removes `<tag>…</tag>` pairs, and a trailing unclosed `<tag>` opener.
    ///
    /// The unclosed case is not hypothetical: a reply is rendered while it
    /// streams, so the opening tag arrives many frames before the closing one.
    /// Without this the raw tag flashes on screen mid-stream.
    static func removeTagged(_ text: String, tag: String) -> String {
        var result = ""
        var remainder = Substring(text)
        let open = "<\(tag)>"
        let close = "</\(tag)>"

        while let openRange = remainder.range(of: open) {
            result += remainder[remainder.startIndex..<openRange.lowerBound]
            let afterOpen = remainder[openRange.upperBound...]
            guard let closeRange = afterOpen.range(of: close) else {
                // Still streaming: drop the opener and everything after it,
                // which is the memory's body arriving a character at a time.
                return result
            }
            remainder = afterOpen[closeRange.upperBound...]
        }
        result += remainder
        return result
    }

    /// `:::clarification-wizard … :::` blocks, which the web also hides.
    static func removeClarificationWizards(_ text: String) -> String {
        let marker = ":::clarification-wizard"
        var result = ""
        var remainder = Substring(text)

        while let start = remainder.range(of: marker, options: .caseInsensitive) {
            result += remainder[remainder.startIndex..<start.lowerBound]
            let afterMarker = remainder[start.upperBound...]
            guard let end = afterMarker.range(of: ":::") else { return result }
            remainder = afterMarker[end.upperBound...]
        }
        result += remainder
        return result
    }
}
