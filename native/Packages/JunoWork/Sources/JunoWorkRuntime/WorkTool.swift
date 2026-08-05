import Foundation
import JunoWorkCore

// MARK: - The value tree arguments and results travel in

/// The JSON tree a tool's arguments and its structured result are expressed in.
///
/// Declared here rather than borrowed from `JunoCodeCore.JSONValue` or
/// `JunoCore.JunoJSONValue`, both of which are the same shape. JunoWork depends
/// on neither package and must not start: the alternative to thirty lines of
/// duplication is a dependency edge from the layer that touches somebody's
/// documents to a layer carrying a network client and a UI framework, which is
/// exactly the edge the package split exists to forbid. The app converts at its
/// own boundary, where a conversion is a visible, reviewable piece of code.
public indirect enum WorkToolValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([WorkToolValue])
    case object([String: WorkToolValue])

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        guard case .number(let value) = self,
            value.rounded() == value,
            value >= Double(Int.min), value <= Double(Int.max)
        else { return nil }
        return Int(value)
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [WorkToolValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: WorkToolValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> WorkToolValue? {
        objectValue?[key]
    }

    /// Deterministic encoding — sorted keys, no whitespace — used as the input
    /// to an action digest.
    ///
    /// Two structurally equal argument sets must produce the same bytes. If they
    /// did not, an approval granted for one spelling of a call would stop
    /// matching the identical call a moment later, and every gated tool would
    /// fail closed for no reason a person could see.
    public func canonicalJSONString() -> String {
        switch self {
        case .null:
            return "null"
        case .bool(let value):
            return value ? "true" : "false"
        case .number(let value):
            if value.rounded() == value, value >= -1e15, value <= 1e15 {
                return String(Int64(value))
            }
            return String(value)
        case .string(let value):
            return Self.escaped(value)
        case .array(let items):
            return "[" + items.map { $0.canonicalJSONString() }.joined(separator: ",") + "]"
        case .object(let fields):
            let body = fields.keys.sorted().map { key in
                Self.escaped(key) + ":" + (fields[key] ?? .null).canonicalJSONString()
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    private static func escaped(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

extension WorkToolValue: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([WorkToolValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: WorkToolValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

extension WorkToolValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByNilLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: WorkToolValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, WorkToolValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}

// MARK: - What a tool accepts

/// One tool's argument contract, stated as typed fields rather than as a JSON
/// Schema document that something then has to interpret.
///
/// The shape is deliberately smaller than JSON Schema. A validator that accepts
/// arbitrary schemas is a second language to get wrong, and the failures it
/// produces — a constraint silently ignored because this particular keyword was
/// never implemented — are invisible until an argument nobody validated reaches
/// the disk. Five field types cover every tool Work has, and anything more
/// structured than that is parsed by the tool itself, where the error message
/// can say what was actually wrong with operation eleven.
public struct WorkToolSchema: Hashable, Sendable {
    public enum FieldType: Hashable, Sendable {
        case string
        case integer
        case boolean
        case stringArray
        case objectArray

        func accepts(_ value: WorkToolValue) -> Bool {
            switch self {
            case .string: value.stringValue != nil
            case .integer: value.intValue != nil
            case .boolean: value.boolValue != nil
            case .stringArray: value.arrayValue?.allSatisfy { $0.stringValue != nil } ?? false
            case .objectArray: value.arrayValue?.allSatisfy { $0.objectValue != nil } ?? false
            }
        }

        /// The word used in a refusal a model reads and has to act on.
        var readableName: String {
            switch self {
            case .string: "a string"
            case .integer: "a whole number"
            case .boolean: "true or false"
            case .stringArray: "an array of strings"
            case .objectArray: "an array of objects"
            }
        }

        var jsonSchemaFragment: WorkToolValue {
            switch self {
            case .string: ["type": "string"]
            case .integer: ["type": "integer"]
            case .boolean: ["type": "boolean"]
            case .stringArray: ["type": "array", "items": ["type": "string"]]
            case .objectArray: ["type": "array", "items": ["type": "object"]]
            }
        }
    }

    public struct Field: Hashable, Sendable {
        public let name: String
        public let type: FieldType
        public let description: String
        public let isRequired: Bool

        public init(_ name: String, _ type: FieldType, _ description: String, required: Bool = false) {
            self.name = name
            self.type = type
            self.description = description
            self.isRequired = required
        }
    }

    public let fields: [Field]

    public init(_ fields: [Field]) {
        self.fields = fields
    }

    /// The reason these arguments are unusable, or nil.
    ///
    /// An argument the tool does not know is **refused**, not ignored. A model
    /// that passes `recursive: true` to a tool with no such option has asked for
    /// something the tool will not do, and quietly doing the other thing is how
    /// a person ends up approving a summary of a call that did not happen.
    public func validate(_ input: WorkToolValue) -> String? {
        guard let arguments = input.objectValue else {
            return "Arguments must be a JSON object."
        }
        for field in fields where field.isRequired {
            guard let value = arguments[field.name], !value.isNull else {
                return "Missing required argument '\(field.name)'."
            }
        }
        for (name, value) in arguments.sorted(by: { $0.key < $1.key }) {
            guard let field = fields.first(where: { $0.name == name }) else {
                let known = fields.map(\.name).sorted().joined(separator: ", ")
                return "Unknown argument '\(name)'. This tool takes: \(known)."
            }
            if value.isNull, !field.isRequired { continue }
            guard field.type.accepts(value) else {
                return "'\(name)' must be \(field.type.readableName)."
            }
        }
        return nil
    }

    /// The contract as a model is shown it.
    public var jsonSchema: WorkToolValue {
        var properties: [String: WorkToolValue] = [:]
        for field in fields {
            var fragment = field.type.jsonSchemaFragment.objectValue ?? [:]
            fragment["description"] = .string(field.description)
            properties[field.name] = .object(fragment)
        }
        return .object([
            "type": "object",
            "properties": .object(properties),
            "required": .array(fields.filter(\.isRequired).map { .string($0.name) }),
        ])
    }
}

// MARK: - Failures

public enum WorkToolError: Error, Equatable, Sendable {
    case unknownTool(name: String)
    case invalidInput(message: String)
    case denied(reason: String)
    case executionFailed(message: String)
}

extension WorkToolError: LocalizedError {
    /// Written for the person watching on a phone, not for a log line.
    public var errorDescription: String? {
        switch self {
        case .unknownTool(let name):
            "This Mac's version of Juno has no \"\(name)\" tool, so it did nothing."
        case .invalidInput(let message):
            message
        case .denied(let reason):
            reason
        case .executionFailed(let message):
            message
        }
    }
}

// MARK: - What a tool hands back

public struct WorkToolResult: Sendable {
    /// Text for the model. Grant-relative locations may appear here — the model
    /// needs them to name the next thing it acts on — but an absolute path never
    /// does, because nothing in this package ever holds one outside
    /// ``GrantAccessing``.
    public let content: String
    public let isError: Bool
    /// Structured detail for the phone: counts, names and digests. **Never a
    /// location**, for the reason ``WorkBatchPreview`` spells out — a
    /// grant-relative path still describes how somebody organises their life,
    /// and this value reaches a lock screen.
    public let detail: [String: WorkToolValue]

    public init(
        content: String,
        isError: Bool = false,
        detail: [String: WorkToolValue] = [:]
    ) {
        self.content = content
        self.isError = isError
        self.detail = detail
    }
}

// MARK: - Per-invocation services

/// What one tool call is handed beyond its arguments.
public struct WorkToolContext: Sendable {
    public let runID: String
    public let toolCallID: String
    /// The authority this call runs under, decided by ``WorkToolRegistry``
    /// before the tool started. A tool that performs something irreversible
    /// re-checks it here rather than trusting that it was gated, so that calling
    /// ``WorkToolRegistry/executeAuthorized(toolName:input:context:)`` directly
    /// cannot skip the question.
    public let authorization: WorkAuthorization
    /// The gate itself, for the one tool whose approval cannot be bound to its
    /// arguments. See ``WorkApprovalBinding``.
    public let approvals: WorkApprovalCoordinator
    /// Streams progress into the transcript — the batch preview a person is
    /// about to be asked about, in particular.
    public let emit: @Sendable (String) async -> Void

    public init(
        runID: String,
        toolCallID: String,
        authorization: WorkAuthorization,
        approvals: WorkApprovalCoordinator,
        emit: @escaping @Sendable (String) async -> Void = { _ in }
    ) {
        self.runID = runID
        self.toolCallID = toolCallID
        self.authorization = authorization
        self.approvals = approvals
        self.emit = emit
    }
}

// MARK: - How a tool's approval is bound

/// What an approval for this tool is bound to.
///
/// Nearly every tool is ``itsArguments``: the registry can hash the call and ask
/// before anything starts, which is the only ordering that lets a refusal cost
/// nothing. One tool cannot work that way, and pretending otherwise would be
/// worse than admitting it — see ``aPlanTheToolBuilds``.
public enum WorkApprovalBinding: Hashable, Sendable {
    /// The digest over the tool name and its arguments is what the person is
    /// approving, so ``WorkToolRegistry`` asks before the tool runs.
    case itsArguments
    /// What a person would be agreeing to cannot be known from the arguments.
    ///
    /// A batch of file operations is ordered, analysed for conflicts and sealed
    /// against a photograph of the folder before it has a digest at all, and it
    /// is *that* digest — the one on the preview they read — an approval has to
    /// bind to. So the registry hands the gate to the tool instead of asking
    /// first, and the tool asks once it has something real to ask about.
    ///
    /// This is the only weakening of the "gate before you start" rule in Work,
    /// and it is deliberately narrow: a tool declaring it is handed
    /// ``WorkAuthorization/deferredToTheTool`` and nothing else, so a tool that
    /// forgot to ask has no authority to execute with.
    case aPlanTheToolBuilds
}

// MARK: - The tool

/// One thing a run can do to a granted folder.
///
/// Two rules hold for every conformance, and both are checked by
/// ``WorkToolRegistry`` rather than left to each implementation to remember:
///
/// 1. **Every touch of the disk goes through ``GrantAccessing`` immediately
///    before it happens.** In practice that means going through
///    ``WorkFileService`` or ``WorkBatchExecutor``, which is where the rule has
///    exactly one implementation to audit.
/// 2. **A tool that can do something irreversible says so from its arguments**,
///    via ``irreversibleAction(input:)``. The registry raises the effective risk
///    to `.irreversible` when it does, so a tool cannot under-declare itself
///    into a lower tier by returning something gentler from ``assessRisk(input:)``.
public protocol WorkTool: Sendable {
    var name: String { get }
    var description: String { get }
    var schema: WorkToolSchema { get }
    var approvalBinding: WorkApprovalBinding { get }

    /// The risk of this exact call, from its arguments. "Move one file" and
    /// "move four hundred" are the same tool and not the same decision.
    func assessRisk(input: WorkToolValue) -> WorkRiskLevel

    /// The irreversible action this call performs, when it performs one.
    ///
    /// Named from ``WorkIrreversibleAction`` rather than guessed from the tool
    /// name, for the reason that type gives: a rule that looks for "delete" in a
    /// name decides `delete_draft` is a permanent delete and `send_to_trash` is
    /// a send, and both mistakes are found by a person afterwards.
    func irreversibleAction(input: WorkToolValue) -> WorkIrreversibleAction?

    /// The sentence a person is shown when asked. Stored with the approval, so
    /// an audit can prove what was on screen.
    func summary(input: WorkToolValue) -> String

    /// A refusal decided before any authorization, for arguments that must never
    /// run at all — so they cannot even be offered for approval.
    func precheck(input: WorkToolValue) -> WorkToolError?

    func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult
}

extension WorkTool {
    public var approvalBinding: WorkApprovalBinding { .itsArguments }
    public func irreversibleAction(input: WorkToolValue) -> WorkIrreversibleAction? { nil }
    public func precheck(input: WorkToolValue) -> WorkToolError? { nil }
}

extension WorkTool {
    /// Namespaced and versioned so an action digest can never be mistaken for a
    /// batch plan digest, and so a future change to the canonical form
    /// invalidates stored approvals loudly instead of colliding with them.
    public static var actionDigestDomain: String { "juno.work.action.v1" }

    /// The digest binding an approval to this exact call.
    public func actionDigest(input: WorkToolValue) -> String {
        WorkDigests.sha256Hex(
            WorkDigests.canonicalRecord([
                Self.actionDigestDomain, name, input.canonicalJSONString(),
            ])
        )
    }
}
