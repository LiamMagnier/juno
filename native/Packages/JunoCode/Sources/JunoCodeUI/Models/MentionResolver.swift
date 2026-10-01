import Foundation
import JunoCodeCore

/// A workspace-file reference being typed at the end of the composer.
///
/// The boundary rules are intentionally conservative. `@` is common in email
/// addresses, URLs, filesystem paths and escaped prose; opening a file picker
/// for any of those would make the composer feel unpredictable. A reference
/// therefore starts only at the beginning of the prompt or immediately after
/// whitespace, contains a file-name-shaped query, and must still be the final
/// token in the prompt.
public struct CodeFileContextToken: Equatable, Sendable {
    /// The partial file name after `@`.
    public let query: String

    private let characterOffset: Int
    private let sourceToken: String

    public init?(composerText: String) {
        guard let at = composerText.lastIndex(of: "@") else { return nil }

        if at != composerText.startIndex {
            let previous = composerText[composerText.index(before: at)]
            // Requiring whitespace rejects email addresses, path components,
            // URL user info and escaped `\@` literals with one rule.
            guard previous.isWhitespace else { return nil }
        }

        let suffix = composerText[composerText.index(after: at)...]
        // This feature is a trailing typeahead. Once the reader types a space
        // or newline they have left the token and normal composer behaviour
        // resumes.
        guard suffix.allSatisfy({ !$0.isWhitespace }) else { return nil }
        // Search is by file name, not by an already-written path. In
        // particular this prevents `/tmp/@notes` and `@src/notes` from being
        // mistaken for an active reference.
        guard suffix.allSatisfy(Self.isFileQueryCharacter) else { return nil }

        query = String(suffix)
        characterOffset = composerText.distance(from: composerText.startIndex, to: at)
        sourceToken = String(composerText[at...])
    }

    /// Replace only the active suffix with a visible workspace reference.
    ///
    /// A trailing space deliberately closes the typeahead after insertion. The
    /// full relative path remains readable and editable in the prompt instead
    /// of becoming an opaque attachment chip.
    public func replacing(in composerText: String, withPath path: String) -> String {
        guard characterOffset <= composerText.count else { return composerText }
        let start = composerText.index(
            composerText.startIndex,
            offsetBy: characterOffset
        )
        guard String(composerText[start...]) == sourceToken else { return composerText }
        return "\(composerText[..<start])@\(path) "
    }

    /// Returns true only when the prompt still contains the exact visible
    /// reference the reader selected. Substring matching is unsafe here:
    /// editing `@.env` into `@.env.example` must not silently attach `.env`.
    static func containsReference(to path: WorkspacePath, in composerText: String) -> Bool {
        let needle = "@\(path.value)"
        var searchStart = composerText.startIndex
        while searchStart < composerText.endIndex,
              let range = composerText.range(
                  of: needle,
                  range: searchStart..<composerText.endIndex
              )
        {
            let startsAtBoundary =
                range.lowerBound == composerText.startIndex
                || composerText[composerText.index(before: range.lowerBound)].isWhitespace
            let endsAtBoundary =
                range.upperBound == composerText.endIndex
                || composerText[range.upperBound].isWhitespace
            if startsAtBoundary, endsAtBoundary {
                return true
            }
            searchStart = range.upperBound
        }
        return false
    }

    private static func isFileQueryCharacter(_ character: Character) -> Bool {
        character.isLetter
            || character.isNumber
            || character == "."
            || character == "_"
            || character == "-"
            || character == "+"
    }
}

/// Stable local ranking layered over the workspace index's bounded results.
///
/// `findFiles` deliberately owns discovery and ignore rules. This helper only
/// makes its results predictable for typeahead: exact names, then prefixes,
/// then other substring matches, with shorter paths winning ties.
enum CodeFileContextSearch {
    static func ranked(_ entries: [FileEntry], query: String) -> [FileEntry] {
        let needle = query.lowercased()
        return entries.sorted { left, right in
            let leftRank = rank(left, needle: needle)
            let rightRank = rank(right, needle: needle)
            if leftRank != rightRank { return leftRank < rightRank }
            if left.path.value.count != right.path.value.count {
                return left.path.value.count < right.path.value.count
            }
            return left.path.value.localizedCaseInsensitiveCompare(right.path.value)
                == .orderedAscending
        }
    }

    private static func rank(_ entry: FileEntry, needle: String) -> Int {
        let name = entry.path.lastComponent.lowercased()
        if name == needle { return 0 }
        if name.hasPrefix(needle) { return 1 }
        return 2
    }
}
