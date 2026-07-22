import Foundation

/// Removes likely credentials from text before it reaches transcripts, logs,
/// or model context. Redaction is best effort and additive: callers must still
/// avoid injecting secrets in the first place.
public struct SecretRedactor: Sendable {
    public static let placeholder = "[redacted]"

    /// Environment variable name fragments whose values must never leave the
    /// process.
    public static let sensitiveEnvironmentNames: [String] = [
        "TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY", "API_KEY",
        "ACCESS_KEY", "PRIVATE_KEY", "CREDENTIAL", "AUTH", "COOKIE", "SESSION",
    ]

    private struct Rule: @unchecked Sendable {
        let regex: NSRegularExpression
        let template: String
    }

    private let rules: [Rule]

    public init() {
        let sources: [(pattern: String, template: String)] = [
            // Authorization headers.
            (
                "(?i)(authorization\\s*[:=]\\s*)(?:bearer\\s+)?[A-Za-z0-9._~+/=-]{8,}",
                "$1\(Self.placeholder)"
            ),
            // Common key=value credential assignments.
            (
                "(?i)\\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)(\\s*[:=]\\s*)(?:\"[^\"]{4,}\"|'[^']{4,}'|[^\\s\"']{4,})",
                "$1$2\(Self.placeholder)"
            ),
            // Well-known token prefixes (GitHub, Slack, Stripe, AWS, model providers).
            ("\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b", Self.placeholder),
            ("\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", Self.placeholder),
            ("\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", Self.placeholder),
            ("\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\\b", Self.placeholder),
            ("\\bAKIA[0-9A-Z]{16}\\b", Self.placeholder),
            ("\\bsk-[A-Za-z0-9_-]{20,}\\b", Self.placeholder),
            // PEM private key blocks.
            (
                "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
                Self.placeholder
            ),
            // URL userinfo credentials: scheme://user:pass@host
            ("(?i)(://[^/\\s:@]+:)[^@/\\s]+(@)", "$1\(Self.placeholder)$2"),
        ]
        rules = sources.compactMap { source in
            guard let regex = try? NSRegularExpression(pattern: source.pattern) else {
                return nil
            }
            return Rule(regex: regex, template: source.template)
        }
    }

    public func redact(_ text: String) -> String {
        var output = text
        for rule in rules {
            output = rule.regex.stringByReplacingMatches(
                in: output,
                options: [],
                range: NSRange(output.startIndex..., in: output),
                withTemplate: rule.template
            )
        }
        return output
    }

    /// True when an environment variable of this name is likely to hold a
    /// credential and must be dropped from child process environments.
    public static func isSensitiveEnvironmentName(_ name: String) -> Bool {
        let upper = name.uppercased()
        return sensitiveEnvironmentNames.contains { upper.contains($0) }
    }
}
