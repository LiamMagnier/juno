import Foundation
import JunoCodeCore

public struct MCPImplementation: Equatable, Sendable {
    public let name: String
    public let version: String
    public let title: String?

    public init(name: String, version: String, title: String? = nil) {
        self.name = name
        self.version = version
        self.title = title
    }

    init(json: JSONValue, context: String) throws {
        guard case let .object(fields) = json else {
            throw MCPError.malformedMessage("\(context) must be an object")
        }
        guard let name = fields["name"]?.stringValue, !name.isEmpty else {
            throw MCPError.malformedMessage("\(context).name must be a non-empty string")
        }
        guard let version = fields["version"]?.stringValue, !version.isEmpty else {
            throw MCPError.malformedMessage("\(context).version must be a non-empty string")
        }
        if let title = fields["title"], title.stringValue == nil && !title.isNull {
            throw MCPError.malformedMessage("\(context).title must be a string")
        }
        self.init(name: name, version: version, title: fields["title"]?.stringValue)
    }
}

public struct MCPInitializeResult: Equatable, Sendable {
    public let protocolVersion: String
    public let capabilities: JSONValue
    public let serverInfo: MCPImplementation
    public let instructions: String?

    init(json: JSONValue) throws {
        guard case let .object(fields) = json else {
            throw MCPError.malformedMessage("initialize result must be an object")
        }
        guard let protocolVersion = fields["protocolVersion"]?.stringValue,
              !protocolVersion.isEmpty
        else {
            throw MCPError.malformedMessage("initialize result.protocolVersion must be a string")
        }
        guard let capabilities = fields["capabilities"] else {
            throw MCPError.malformedMessage("initialize result.capabilities was missing")
        }
        guard let serverInfo = fields["serverInfo"] else {
            throw MCPError.malformedMessage("initialize result.serverInfo was missing")
        }
        if let instructions = fields["instructions"],
           instructions.stringValue == nil,
           !instructions.isNull
        {
            throw MCPError.malformedMessage("initialize result.instructions must be a string")
        }

        self.protocolVersion = protocolVersion
        self.capabilities = capabilities
        self.serverInfo = try MCPImplementation(json: serverInfo, context: "initialize result.serverInfo")
        self.instructions = fields["instructions"]?.stringValue
    }
}

/// The schema-bearing contract advertised by one MCP server.
public struct MCPToolDefinition: Equatable, Sendable {
    public let name: String
    public let title: String?
    public let description: String?
    public let inputSchema: JSONValue
    public let outputSchema: JSONValue?
    public let annotations: JSONValue?

    public init(
        name: String,
        title: String? = nil,
        description: String? = nil,
        inputSchema: JSONValue,
        outputSchema: JSONValue? = nil,
        annotations: JSONValue? = nil
    ) {
        self.name = name
        self.title = title
        self.description = description
        self.inputSchema = inputSchema
        self.outputSchema = outputSchema
        self.annotations = annotations
    }

    fileprivate init(json: JSONValue) throws {
        guard case let .object(fields) = json else {
            throw MCPError.malformedMessage("tools/list item must be an object")
        }
        guard let name = fields["name"]?.stringValue, !name.isEmpty else {
            throw MCPError.malformedMessage("MCP tool name must be a non-empty string")
        }
        if let title = fields["title"], title.stringValue == nil && !title.isNull {
            throw MCPError.malformedMessage("MCP tool '\(name)' title must be a string")
        }
        if let description = fields["description"],
           description.stringValue == nil,
           !description.isNull
        {
            throw MCPError.malformedMessage("MCP tool '\(name)' description must be a string")
        }
        guard let inputSchema = fields["inputSchema"], inputSchema.objectValue != nil else {
            throw MCPError.malformedMessage("MCP tool '\(name)' inputSchema must be an object")
        }
        self.init(
            name: name,
            title: fields["title"]?.stringValue,
            description: fields["description"]?.stringValue,
            inputSchema: inputSchema,
            outputSchema: fields["outputSchema"],
            annotations: fields["annotations"]
        )
    }
}

public struct MCPToolListPage: Equatable, Sendable {
    public let tools: [MCPToolDefinition]
    public let nextCursor: String?

    init(json: JSONValue) throws {
        guard case let .object(fields) = json else {
            throw MCPError.malformedMessage("tools/list result must be an object")
        }
        guard case let .array(rawTools)? = fields["tools"] else {
            throw MCPError.malformedMessage("tools/list result.tools must be an array")
        }
        if let cursor = fields["nextCursor"], cursor.stringValue == nil && !cursor.isNull {
            throw MCPError.malformedMessage("tools/list result.nextCursor must be a string")
        }
        self.tools = try rawTools.map(MCPToolDefinition.init(json:))
        self.nextCursor = fields["nextCursor"]?.stringValue
    }
}

/// A decoded MCP content block. `raw` is retained so a future MCP content
/// type remains inspectable even though this bounded client only gives typed
/// access to the standard text/image/audio/resource forms.
public struct MCPToolContentBlock: Equatable, Sendable {
    public let type: String
    public let text: String?
    public let data: String?
    public let mimeType: String?
    public let uri: String?
    public let name: String?
    public let resourceText: String?
    public let resourceBlob: String?
    public let annotations: JSONValue?
    public let raw: JSONValue

    fileprivate init(json: JSONValue) throws {
        guard case let .object(fields) = json else {
            throw MCPError.invalidToolResult("content block must be an object")
        }
        guard let type = fields["type"]?.stringValue, !type.isEmpty else {
            throw MCPError.invalidToolResult("content block.type must be a non-empty string")
        }

        let text = fields["text"]?.stringValue
        let data = fields["data"]?.stringValue
        let mimeType = fields["mimeType"]?.stringValue
        let uri = fields["uri"]?.stringValue
        let name = fields["name"]?.stringValue
        var resourceText: String?
        var resourceBlob: String?

        switch type {
        case "text":
            guard text != nil else {
                throw MCPError.invalidToolResult("text content block has no text")
            }
        case "image", "audio":
            guard data != nil, mimeType != nil else {
                throw MCPError.invalidToolResult("\(type) content block needs data and mimeType")
            }
        case "resource":
            guard case let .object(resourceFields)? = fields["resource"],
                  let resourceURI = resourceFields["uri"]?.stringValue,
                  !resourceURI.isEmpty
            else {
                throw MCPError.invalidToolResult("resource content block needs resource.uri")
            }
            guard resourceFields["text"]?.stringValue != nil
                    || resourceFields["blob"]?.stringValue != nil
            else {
                throw MCPError.invalidToolResult("resource content block needs resource.text or resource.blob")
            }
            resourceText = resourceFields["text"]?.stringValue
            resourceBlob = resourceFields["blob"]?.stringValue
        case "resource_link":
            guard let uri, !uri.isEmpty, let name, !name.isEmpty else {
                throw MCPError.invalidToolResult("resource_link content block needs uri and name")
            }
        default:
            // Preserve unknown blocks for forward compatibility. They are not
            // silently converted into executable or trusted local data.
            break
        }

        self.type = type
        self.text = text
        self.data = data
        let resolvedMimeType: String?
        if type == "resource", case let .object(resourceFields)? = fields["resource"] {
            self.uri = resourceFields["uri"]?.stringValue
            resolvedMimeType = resourceFields["mimeType"]?.stringValue
        } else {
            self.uri = uri
            resolvedMimeType = mimeType
        }
        self.mimeType = resolvedMimeType
        self.name = name
        self.resourceText = resourceText
        self.resourceBlob = resourceBlob
        self.annotations = fields["annotations"]
        self.raw = json
    }
}

public struct MCPToolResult: Equatable, Sendable {
    public let content: [MCPToolContentBlock]
    public let isError: Bool
    public let structuredContent: JSONValue?

    public init(
        content: [MCPToolContentBlock],
        isError: Bool = false,
        structuredContent: JSONValue? = nil
    ) {
        self.content = content
        self.isError = isError
        self.structuredContent = structuredContent
    }

    init(json: JSONValue) throws {
        guard case let .object(fields) = json else {
            throw MCPError.invalidToolResult("tools/call result must be an object")
        }
        guard case let .array(rawContent)? = fields["content"] else {
            throw MCPError.invalidToolResult("tools/call result.content must be an array")
        }
        if let isError = fields["isError"], isError.boolValue == nil && !isError.isNull {
            throw MCPError.invalidToolResult("tools/call result.isError must be a boolean")
        }
        self.content = try rawContent.map(MCPToolContentBlock.init(json:))
        self.isError = fields["isError"]?.boolValue ?? false
        self.structuredContent = fields["structuredContent"]
    }

    /// Text blocks are the safest compact representation for the existing
    /// Juno transcript/model bridge. Rich blocks remain available in `content`.
    public var textContent: String {
        content.compactMap(\.text).joined(separator: "\n")
    }
}
