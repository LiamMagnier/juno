import Foundation
import JunoCodeCore

/// Minimal JSON-schema-style validation for tool inputs: object shape,
/// required fields, per-property primitive types, and rejection of unknown
/// keys. Tools own richer semantic validation.
public enum SchemaValidator {
    public static func validate(input: JSONValue, against schema: JSONValue) -> String? {
        guard schema["type"]?.stringValue == "object" else {
            return "Schema must describe an object."
        }
        guard let object = input.objectValue else {
            return "Input must be an object."
        }
        let properties = schema["properties"]?.objectValue ?? [:]
        let required = schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? []

        for name in required where object[name] == nil || object[name]?.isNull == true {
            return "Missing required field '\(name)'."
        }
        for (key, value) in object {
            guard let property = properties[key] else {
                return "Unknown field '\(key)'."
            }
            if value.isNull { continue }
            if let expected = property["type"]?.stringValue,
               let problem = check(value: value, expectedType: expected, field: key)
            {
                return problem
            }
        }
        return nil
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
