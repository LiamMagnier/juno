import Foundation

public enum GlobPatternError: Error, Equatable, Sendable {
    case empty
    case tooLong
    case invalid
}

/// A glob compiled to a regular expression over workspace-relative paths.
/// `*` and `?` never cross `/`; `**` crosses directories.
public struct GlobPattern: Sendable {
    public let source: String
    private let regex: NSRegularExpression

    public init(_ source: String) throws {
        guard !source.isEmpty else { throw GlobPatternError.empty }
        guard source.utf8.count <= 1_024 else { throw GlobPatternError.tooLong }
        // A pattern with no slash matches basenames anywhere, like gitignore.
        let anchored = source.contains("/") ? source : "**/" + source
        let pattern = "^" + Self.translate(anchored) + "$"
        do {
            regex = try NSRegularExpression(pattern: pattern)
        } catch {
            throw GlobPatternError.invalid
        }
        self.source = source
    }

    public func matches(_ relativePath: String) -> Bool {
        let range = NSRange(relativePath.startIndex..., in: relativePath)
        return regex.firstMatch(in: relativePath, options: [], range: range) != nil
    }

    static func translate(_ glob: String) -> String {
        var out = ""
        let characters = Array(glob)
        var index = 0
        while index < characters.count {
            let character = characters[index]
            switch character {
            case "*":
                let isDouble = index + 1 < characters.count && characters[index + 1] == "*"
                if isDouble {
                    let followedBySlash = index + 2 < characters.count && characters[index + 2] == "/"
                    if followedBySlash {
                        out += "(?:[^/]+/)*"
                        index += 3
                    } else {
                        out += ".*"
                        index += 2
                    }
                } else {
                    out += "[^/]*"
                    index += 1
                }
            case "?":
                out += "[^/]"
                index += 1
            default:
                out += NSRegularExpression.escapedPattern(for: String(character))
                index += 1
            }
        }
        return out
    }
}
