import Foundation

public enum BoundedValueError: Error, Equatable, Sendable {
    case empty(field: String)
    case exceedsUTF8Limit(field: String, maximum: Int)
    case containsControlCharacter(field: String)
    case invalidRange(field: String)
}

public enum BoundedValue {
    public static func validateText(
        _ value: String,
        field: String,
        maximumUTF8Bytes: Int,
        allowsEmpty: Bool = false,
        allowsNewlines: Bool = false
    ) throws {
        guard maximumUTF8Bytes > 0 else {
            throw BoundedValueError.invalidRange(field: field)
        }
        if !allowsEmpty, value.isEmpty {
            throw BoundedValueError.empty(field: field)
        }
        guard value.utf8.count <= maximumUTF8Bytes else {
            throw BoundedValueError.exceedsUTF8Limit(
                field: field,
                maximum: maximumUTF8Bytes
            )
        }

        let invalid = value.unicodeScalars.contains { scalar in
            guard CharacterSet.controlCharacters.contains(scalar) else {
                return false
            }
            return !(allowsNewlines && (scalar == "\n" || scalar == "\r" || scalar == "\t"))
        }
        if invalid {
            throw BoundedValueError.containsControlCharacter(field: field)
        }
    }
}
