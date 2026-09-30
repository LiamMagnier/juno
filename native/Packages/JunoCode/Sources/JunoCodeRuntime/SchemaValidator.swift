import Foundation
import JunoCodeCore

/// Minimal JSON-schema-style validation for tool inputs: object shape,
/// required fields, per-property primitive types, and rejection of unknown
/// keys. Tools own richer semantic validation.
public enum SchemaValidator {
    public static func validate(input: JSONValue, against schema: JSONValue) -> String? {
        // An MCP server may leave the top-level `type` out; its schema still
        // describes the object of arguments.
        let type = schema["type"]?.stringValue
        guard type == nil || type == "object" else {
            return "Schema must describe an object."
        }
        guard let object = input.objectValue else {
            return "Input must be an object."
        }
        let properties = schema["properties"]?.objectValue
        let required = schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? []

        for name in required where object[name] == nil || object[name]?.isNull == true {
            return "Missing required field '\(name)'."
        }
        // A schema that names no properties at all constrains no keys.
        guard let properties else { return nil }
        for (key, value) in object {
            guard let property = properties[key] else {
                return "Unknown field '\(key)'."
            }
            if value.isNull { continue }
            if let expected = expectedType(of: property),
               let problem = check(value: value, expectedType: expected, field: key)
            {
                return problem
            }
        }
        return nil
    }

    /// `input` with values the schema types differently converted, where the
    /// conversion is exact: `"3"` for an integer, `"true"` for a boolean, a
    /// stringified array or object for one, and a whole argument object sent
    /// as a JSON string. Anything else is left as it came, for ``validate``
    /// to name.
    ///
    /// Several models send exactly these, and a strict check turned each into
    /// a refused call and a retry that often sent the same thing again.
    public static func coerced(input: JSONValue, against schema: JSONValue) -> JSONValue {
        var input = input
        if case let .string(text) = input, let parsed = parsedJSON(text), parsed.objectValue != nil {
            input = parsed
        }
        guard var object = input.objectValue,
              let properties = schema["properties"]?.objectValue
        else { return input }
        for (key, value) in object {
            guard let property = properties[key], let expected = expectedType(of: property) else { continue }
            var converted = coerced(value, to: expected)
            if expected == "array",
               case let .array(items) = converted,
               let itemSchema = property["items"],
               let itemType = expectedType(of: itemSchema)
            {
                converted = .array(items.map { coerced($0, to: itemType) })
            }
            object[key] = converted
        }
        return .object(object)
    }

    /// One value as `expected`, when it converts exactly.
    private static func coerced(_ value: JSONValue, to expected: String) -> JSONValue {
        guard case let .string(raw) = value else { return value }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch expected {
        case "integer":
            if let integer = Int(text) { return .number(Double(integer)) }
        case "number":
            if let number = Double(text), number.isFinite { return .number(number) }
        case "boolean":
            switch text.lowercased() {
            case "true": return .bool(true)
            case "false": return .bool(false)
            default: break
            }
        case "array":
            if let parsed = parsedJSON(text), parsed.arrayValue != nil { return parsed }
        case "object":
            if let parsed = parsedJSON(text), parsed.objectValue != nil { return parsed }
        default:
            break
        }
        return value
    }

    /// The type a property declares: its `type`, or the first non-null one
    /// of a `["integer", "null"]` list.
    private static func expectedType(of property: JSONValue) -> String? {
        if let type = property["type"]?.stringValue { return type }
        return property["type"]?.arrayValue?
            .compactMap(\.stringValue)
            .first { $0 != "null" }
    }

    private static func parsedJSON(_ text: String) -> JSONValue? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{") || trimmed.hasPrefix("[") else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8))
    }

    private static func check(value: JSONValue, expectedType: String, field: String) -> String? {
        switch expectedType {
        case "string":
            return value.stringValue == nil ? "Field '\(field)' must be a string." : nil
        case "boolean":
            return value.boolValue == nil ? "Field '\(field)' must be a boolean." : nil
        case "number":
            return value.numberValue == nil ? "Field '\(field)' must be a number." : nil
        case "integer":
            return value.intValue == nil ? "Field '\(field)' must be an integer." : nil
        case "array":
            return value.arrayValue == nil ? "Field '\(field)' must be an array." : nil
        case "object":
            return value.objectValue == nil ? "Field '\(field)' must be an object." : nil
        default:
            return nil
        }
    }
}
