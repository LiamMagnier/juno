import Foundation

/// Human-facing summary of structured instructions used by project index rows.
/// The stored prompt is never changed; only markup that would consume the card
/// without helping someone identify the project is hidden here.
public enum JunoPromptPreview {
    public static func text(
        _ source: String,
        fallback: String = "No instructions set."
    ) -> String {
        let collapsed = source
            .split(whereSeparator: \Character.isWhitespace)
            .map(String.init)
            .joined(separator: " ")
        guard !collapsed.isEmpty else { return fallback }

        let unwrapped = collapsed
            .replacingOccurrences(
                of: #"</?[A-Za-z][A-Za-z0-9_.:-]*(?:\s[^<>]*)?/?>"#,
                with: " ",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"\s{2,}"#,
                with: " ",
                options: .regularExpression
            )
            .trimmingCharacters(in: .whitespaces)

        return unwrapped.isEmpty ? collapsed : unwrapped
    }
}
