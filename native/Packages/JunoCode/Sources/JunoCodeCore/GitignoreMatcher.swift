import Foundation

/// A practical subset of gitignore semantics over workspace-relative paths:
/// wildcards that stop at `/`, `**` that crosses, root-anchored patterns with
/// a leading or embedded `/`, directory-only patterns with a trailing `/`,
/// `!` negation with last-match-wins, comments, and blank lines.
public struct GitignoreMatcher: Sendable {
    private struct Rule: @unchecked Sendable {
        /// Matches the pattern itself or anything nested beneath it.
        let regex: NSRegularExpression
        let isNegation: Bool
        let directoryOnly: Bool
    }

    private let rules: [Rule]

    public init(contents: String) {
        var compiled: [Rule] = []
        for rawLine in contents.components(separatedBy: "\n") {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            var isNegation = false
            if line.hasPrefix("!") {
                isNegation = true
                line.removeFirst()
            }
            var directoryOnly = false
            if line.hasSuffix("/") {
                directoryOnly = true
                line.removeLast()
            }
            guard !line.isEmpty else { continue }
            // A pattern containing a slash is anchored to the root; others
            // match at any depth.
            let anchored: String
            if line.hasPrefix("/") {
                anchored = String(line.dropFirst())
            } else if line.contains("/") {
                anchored = line
            } else {
                anchored = "**/" + line
            }
            // `(?:/.*)?` extends the match to everything inside a matched
            // directory.
            let pattern = "^" + GlobPattern.translate(anchored) + "(?:/.*)?$"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            compiled.append(
                Rule(regex: regex, isNegation: isNegation, directoryOnly: directoryOnly)
            )
        }
        rules = compiled
    }

    public var isEmpty: Bool { rules.isEmpty }

    /// Last matching rule wins, like git.
    public func isIgnored(_ relativePath: String, isDirectory: Bool) -> Bool {
        var ignored = false
        for rule in rules {
            let matches: Bool
            if rule.directoryOnly, !isDirectory {
                // A directory-only rule affects a file only when one of the
                // file's proper ancestors matches the rule.
                matches = Self.hasMatchingAncestor(rule.regex, path: relativePath)
            } else {
                matches = Self.fullMatch(rule.regex, path: relativePath)
            }
            if matches {
                ignored = !rule.isNegation
            }
        }
        return ignored
    }

    private static func fullMatch(_ regex: NSRegularExpression, path: String) -> Bool {
        let range = NSRange(path.startIndex..., in: path)
        return regex.firstMatch(in: path, options: [], range: range) != nil
    }

    private static func hasMatchingAncestor(_ regex: NSRegularExpression, path: String) -> Bool {
        var components = path.split(separator: "/").map(String.init)
        guard !components.isEmpty else { return false }
        components.removeLast()
        var prefix = ""
        for component in components {
            prefix = prefix.isEmpty ? component : prefix + "/" + component
            if fullMatch(regex, path: prefix) {
                return true
            }
        }
        return false
    }
}
