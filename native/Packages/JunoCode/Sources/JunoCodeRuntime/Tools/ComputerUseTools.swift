import Foundation
import JunoCodeCore

/// Agent-facing Computer Use tools. They only know the safe coordinator
/// protocol; the raw ScreenCaptureKit / CGEvent driver is intentionally not
/// reachable from the runtime.
public struct ComputerScreenshotTool: CodeTool {
    private let computer: any ComputerUseCoordinating

    public init(computer: any ComputerUseCoordinating) {
        self.computer = computer
    }

    public let name = "computer_screenshot"
    public let description =
        "Capture the Mac display after the user has explicitly activated Computer Use."
    public var inputSchema: JSONValue {
        ["type": "object", "properties": [:], "required": []]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }
    public func summary(input: JSONValue) -> String { "Capture the active display" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let capture = try await computer.perform(.screenshot, sessionID: context.sessionID)
        let bounds = try await computer.displayBounds()
        // Kept ephemeral and sent as a real multimodal input to the current
        // model turn. It is not written into session events, sync, analytics
        // or the local transcript.
        return ToolResult(
            content: """
            Screenshot captured. Coordinates use macOS display points with \
            origin (\(Int(bounds.origin.x)), \(Int(bounds.origin.y))) and size \
            \(Int(bounds.size.width)) × \(Int(bounds.size.height)).
            """,
            images: [
                ModelImage(mediaType: "image/jpeg", data: capture.after, detail: .high),
            ]
        )
    }
}

public struct ComputerClickTool: CodeTool {
    private let computer: any ComputerUseCoordinating

    public init(computer: any ComputerUseCoordinating) {
        self.computer = computer
    }

    public let name = "computer_click"
    public let description = "Click display coordinates while Computer Use is active."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "x": ["type": "number"],
                "y": ["type": "number"],
                "double": ["type": "boolean"],
            ],
            "required": ["x", "y"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .critical }
    public func summary(input: JSONValue) -> String {
        "Click at \(number(input["x"])), \(number(input["y"]))"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let x = input["x"]?.numberValue, let y = input["y"]?.numberValue else {
            throw ToolError.invalidInput(message: "x and y must be numbers.")
        }
        let action: ComputerUseActionKind = input["double"]?.boolValue == true
            ? .doubleClick(x: x, y: y) : .click(x: x, y: y)
        _ = try await computer.perform(action, sessionID: context.sessionID)
        return ToolResult(content: "Click completed.")
    }

    private func number(_ value: JSONValue?) -> String {
        value?.numberValue.map { String(format: "%.0f", $0) } ?? "?"
    }
}

public struct ComputerTypeTool: CodeTool {
    private let computer: any ComputerUseCoordinating

    public init(computer: any ComputerUseCoordinating) {
        self.computer = computer
    }

    public let name = "computer_type"
    public let description = "Type text into the focused Mac control while Computer Use is active."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["text": ["type": "string"]],
            "required": ["text"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .critical }
    public func summary(input: JSONValue) -> String {
        "Type \(input["text"]?.stringValue?.count ?? 0) characters"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let text = input["text"]?.stringValue else {
            throw ToolError.invalidInput(message: "text is required.")
        }
        _ = try await computer.perform(.typeText(text), sessionID: context.sessionID)
        return ToolResult(content: "Typing completed.")
    }
}

public struct ComputerKeyTool: CodeTool {
    private let computer: any ComputerUseCoordinating

    public init(computer: any ComputerUseCoordinating) {
        self.computer = computer
    }

    public let name = "computer_press_key"
    public let description = "Press one named keyboard key while Computer Use is active."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["key": ["type": "string"]],
            "required": ["key"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .critical }
    public func summary(input: JSONValue) -> String {
        "Press \(input["key"]?.stringValue ?? "a key")"
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let key = input["key"]?.stringValue else {
            throw ToolError.invalidInput(message: "key is required.")
        }
        _ = try await computer.perform(.pressKey(key), sessionID: context.sessionID)
        return ToolResult(content: "Key press completed.")
    }
}

public struct ComputerScrollTool: CodeTool {
    private let computer: any ComputerUseCoordinating

    public init(computer: any ComputerUseCoordinating) {
        self.computer = computer
    }

    public let name = "computer_scroll"
    public let description = "Scroll at display coordinates while Computer Use is active."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "x": ["type": "number"],
                "y": ["type": "number"],
                "delta_y": ["type": "number"],
            ],
            "required": ["x", "y", "delta_y"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .critical }
    public func summary(input: JSONValue) -> String { "Scroll the active display" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let x = input["x"]?.numberValue,
              let y = input["y"]?.numberValue,
              let delta = input["delta_y"]?.numberValue
        else {
            throw ToolError.invalidInput(message: "x, y and delta_y must be numbers.")
        }
        _ = try await computer.perform(
            .scroll(x: x, y: y, deltaY: delta),
            sessionID: context.sessionID
        )
        return ToolResult(content: "Scroll completed.")
    }
}
