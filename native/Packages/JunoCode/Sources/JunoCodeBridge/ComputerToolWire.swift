import Foundation
import JunoCodeCore
import JunoCodeRuntime

/// How computer use goes on the wire, per route (CODE_AGENT_SPEC §3.4).
///
/// The runtime always speaks one tool, `computer`, with the 17 toolset
/// actions in `input.action`. This file translates at the provider boundary:
///
/// - **Anthropic, toolset models** (Opus 5.5, Sonnet 5.5, Opus 5): the
///   `computer` function tool becomes `{"type": "computer_toolset_20260801"}`
///   — no name, no display size, all 17 members on by default. Claude then
///   calls the members by name (`left_click`, `screenshot`), each block
///   carrying `"toolset_name": "computer"`; the decoder maps them back to
///   `computer` with `action`, and replayed history goes out in the member
///   form with `toolset_name` echoed on every result (a result without it is
///   rejected). `computer_20251124` is never sent: it returns 400 on Opus 5.5.
///   `computer_batch` is dropped there, since the toolset batches natively.
/// - **Anthropic, other models**: the `computer` function tool as is.
/// - **OpenAI**: the function tools; screenshots carry `detail: "original"`
///   on Responses, and `high` on Chat Completions — which has no `original`
///   — with images the harness already fitted inside the box `high` resizes
///   to, so the model's coordinates stay in Juno's frame.
/// - **Every other route**: no screen tools. Their coordinate conventions are
///   unverified, and a wrong convention clicks in the wrong place.
enum ComputerToolWire {
    static let toolsetType = "computer_toolset_20260801"
    static let toolsetName = "computer"

    /// The fields a toolset member's input has. Juno's function-form extras
    /// (`app`, `element`, `mode`) are not among them.
    static let memberFields: Set<String> = [
        "coordinate", "start_coordinate", "region", "text", "repeat", "duration",
        "scroll_direction", "scroll_amount",
    ]

    // MARK: Requests

    /// Rewrites an Anthropic Messages body for the route.
    static func anthropic(_ body: JSONValue, providerModelID: String) -> JSONValue {
        guard ComputerUseRoutes.toolsetModels.contains(providerModelID.lowercased()),
              case var .object(object) = body,
              case let .array(tools)? = object["tools"],
              tools.contains(where: { $0["name"]?.stringValue == ComputerUseToolName.computer })
        else { return body }

        // The declaration.
        var rewritten: [JSONValue] = []
        var movedCache: JSONValue?
        for tool in tools {
            let name = tool["name"]?.stringValue
            if name == ComputerUseToolName.computer {
                movedCache = tool["cache_control"] ?? movedCache
                rewritten.append(.object(["type": .string(toolsetType)]))
            } else if name == ComputerUseToolName.batch {
                movedCache = tool["cache_control"] ?? movedCache
            } else {
                rewritten.append(tool)
            }
        }
        // The last tool carried the tools breakpoint; keep it on a function
        // tool, where `cache_control` is certainly accepted.
        if let movedCache,
           let index = rewritten.lastIndex(where: { $0["name"] != nil }),
           case var .object(tool) = rewritten[index]
        {
            tool["cache_control"] = movedCache
            rewritten[index] = .object(tool)
        }
        object["tools"] = .array(rewritten)

        // The history.
        if case let .array(messages)? = object["messages"] {
            var memberCalls = Set<String>()
            var out: [JSONValue] = []
            for message in messages {
                guard case var .object(fields) = message, case let .array(blocks)? = fields["content"] else {
                    out.append(message)
                    continue
                }
                let mapped = blocks.map { block -> JSONValue in
                    guard case var .object(block) = block else { return block }
                    switch block["type"]?.stringValue {
                    case "tool_use" where block["name"]?.stringValue == ComputerUseToolName.computer:
                        guard let input = block["input"]?.objectValue,
                              let action = input["action"]?.stringValue
                        else { return .object(block) }
                        if let id = block["id"]?.stringValue { memberCalls.insert(id) }
                        block["name"] = .string(action)
                        block["toolset_name"] = .string(toolsetName)
                        block["input"] = .object(input.filter { memberFields.contains($0.key) })
                        return .object(block)
                    case "tool_result":
                        if let id = block["tool_use_id"]?.stringValue, memberCalls.contains(id) {
                            block["toolset_name"] = .string(toolsetName)
                        }
                        return .object(block)
                    default:
                        return .object(block)
                    }
                }
                fields["content"] = .array(mapped)
                out.append(.object(fields))
            }
            object["messages"] = .array(out)
        }
        return .object(object)
    }

    /// Rewrites an OpenAI-compatible body (Chat Completions or Responses).
    static func openAI(_ body: JSONValue, providerID: String, wire: CodeModelWireProtocol) -> JSONValue {
        guard case var .object(object) = body else { return body }
        if providerID.lowercased() != "openai" {
            // No verified coordinate convention: no screen tools at all.
            if case let .array(tools)? = object["tools"] {
                let kept = tools.filter { tool in
                    let name = tool["function"]?["name"]?.stringValue ?? tool["name"]?.stringValue ?? ""
                    return !isComputerUseTool(name)
                }
                object["tools"] = kept.isEmpty ? nil : .array(kept)
            }
            return .object(object)
        }
        guard wire == .openAIChat, case let .array(messages)? = object["messages"] else { return .object(object) }
        object["messages"] = .array(messages.map(chatDetail))
        return .object(object)
    }

    /// Whether a tool is one of the computer tools (not the Simulator tool,
    /// which needs no coordinates).
    static func isComputerUseTool(_ name: String) -> Bool {
        name == ComputerUseToolName.computer || name.hasPrefix("computer_") || name == "inspect_active_editor"
    }

    /// `detail: original` → `high` inside a Chat Completions message.
    private static func chatDetail(_ value: JSONValue) -> JSONValue {
        switch value {
        case let .object(fields):
            var copy = fields
            if fields["detail"]?.stringValue == ModelImage.Detail.original.rawValue {
                copy["detail"] = .string(ModelImage.Detail.high.rawValue)
            }
            for (key, child) in fields where key != "detail" {
                copy[key] = chatDetail(child)
            }
            return .object(copy)
        case let .array(items):
            return .array(items.map(chatDetail))
        default:
            return value
        }
    }

    // MARK: Responses

    /// The call the runtime runs for a streamed `tool_use` block: a toolset
    /// member becomes `computer` with `action` set to the member.
    static func internalCall(name: String, toolsetName: String?, arguments: String) -> (name: String, arguments: String) {
        guard toolsetName == Self.toolsetName else { return (name, arguments) }
        var input: [String: JSONValue] = [:]
        let trimmed = arguments.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            guard let data = trimmed.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
                  case let .object(fields) = decoded
            else {
                // Leave malformed arguments for the malformed-call path.
                return (ComputerUseToolName.computer, arguments)
            }
            input = fields
        }
        input["action"] = .string(name)
        let encoded = JSONValue.object(input).canonicalJSONString()
        return (ComputerUseToolName.computer, encoded)
    }
}
