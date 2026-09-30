import Foundation
import JunoCodeCore

/// A tool call's streamed arguments, read as JSON.
///
/// Providers stream arguments as text, and text can arrive cut off by the
/// output limit or simply malformed. That used to become `{}`, which a tool
/// with no required fields then ran — `git_diff` of nothing, a status with no
/// scope — and which every other tool refused as "Missing required field",
/// sending the model off to hunt for a field it had in fact written. A call
/// whose arguments do not parse is now answered with the parser's own
/// complaint, so the model knows to send it again.
public enum ToolArguments {
    public enum Parsed: Equatable, Sendable {
        case value(JSONValue)
        /// What the parser said, with its position when it gave one.
        case malformed(String)
    }

    /// Empty arguments are an empty object: that is how a call with no
    /// parameters streams.
    public static func parse(_ raw: String) -> Parsed {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .value(.object([:])) }
        let data = Data(trimmed.utf8)
        if let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            return .value(value)
        }
        return .malformed(parserComplaint(data))
    }

    /// The Foundation parser's own description of what is wrong — "Unexpected
    /// end of file", "around line 1, column 38" — which says more than the
    /// decoder's generic "not in the correct format".
    private static func parserComplaint(_ data: Data) -> String {
        do {
            _ = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
            return "the JSON could not be read"
        } catch {
            let error = error as NSError
            let detail = (error.userInfo[NSDebugDescriptionErrorKey] as? String) ?? error.localizedDescription
            return detail.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// The tool result a malformed call is answered with.
    public static func malformedResult(toolName: String, rawArguments: String, error: String) -> String {
        let shown = rawArguments.count > 300 ? String(rawArguments.prefix(300)) + "…" : rawArguments
        return """
            Not run: the arguments for \(toolName) were not valid JSON (\(error)). \
            \(rawArguments.count) characters arrived, beginning: \(shown)
            Send the call again with one complete JSON object for its arguments.
            """
    }
}
