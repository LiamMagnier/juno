import Foundation
import JunoCodeCore
import JunoScreenControl

// `computer_use`: computer use for every model (Alevr Code v2 SPEC §3.12).
//
// Anthropic's toolset and OpenAI's function form keep the 17-action
// `computer` tool. Everything else — Gemini, Grok, DeepSeek, Qwen, Mistral,
// and any model that cannot see — gets this one: a flat schema every
// vendor's function calling accepts (plain x/y numbers, no tuples, no
// oneOf), coordinates in the convention the frame header states, and
// accessibility targeting (`ax_find`, then `ax_press` with an element id)
// that hits the exact control without guessing pixels. A model that cannot
// see gets the words of the screen (its controls) instead of the picture,
// while the picture still goes to the thread's timeline.
//
// Approvals are the same as the `computer` tool's (see the top of
// ComputerUseTools.swift): the tool asks the session's coordinator itself,
// once, with the full card, through `ScreenActionRunner`. The env server's
// Alevr MCP server exposes the same vocabulary to subscription agents
// (runner/env-server/src/mcp/computer-tools.ts); the Mac's bridge executor
// runs those calls (JunoCodeLocal/ComputerBridgeExecutor.swift).

/// The latest frame size per session, for converting a call's coordinates
/// into the frame's convention.
public actor PortableFrameMemory {
    private var sizes: [String: PixelSize] = [:]

    public init() {}

    public func size(sessionID: String) -> PixelSize? { sizes[sessionID] }

    public func remember(_ result: ScreenActionResult, sessionID: String) {
        if let size = result.frame?.size { sizes[sessionID] = size }
    }

    public func forget(sessionID: String) { sizes[sessionID] = nil }
}

/// Every screen step as a `computer_action` turn item (Code v2 SPEC §3.2):
/// `running` when it starts, then `completed` / `failed` / `declined` /
/// `interrupted` with its sentence, the after-frame stored as a screenshot
/// reference, and where it landed — what the thread's timeline draws.
public actor ComputerActionRecorder {
    /// Stores a frame; returns its `alevr-shot://` reference.
    public typealias Store = @Sendable (_ sessionID: String, _ callID: String, _ frame: EncodedFrame) async -> String?

    private let store: Store?
    private let publish: @Sendable (_ sessionID: String, _ item: CodeV2.TurnItem) -> Void
    private let now: @Sendable () -> Date
    private var order: [String] = []
    private var latest: [String: CodeV2.TurnItem] = [:]

    public init(
        store: Store? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        publish: @escaping @Sendable (_ sessionID: String, _ item: CodeV2.TurnItem) -> Void = { _, _ in }
    ) {
        self.store = store
        self.now = now
        self.publish = publish
    }

    /// Every item recorded, latest version of each, in the order they began.
    public var items: [CodeV2.TurnItem] { order.compactMap { latest[$0] } }

    /// The thread's word for a toolset action.
    public static func itemKind(for kind: ScreenActionKind) -> CodeV2.ComputerActionKind {
        switch kind {
        case .screenshot, .cursorPosition: .screenshot
        case .zoom: .zoom
        case .leftClick, .middleClick, .tripleClick, .leftMouseDown, .leftMouseUp: .click
        case .doubleClick: .doubleClick
        case .rightClick: .rightClick
        case .leftClickDrag: .drag
        case .mouseMove: .move
        case .scroll: .scroll
        case .type: .type
        case .key, .holdKey: .key
        case .wait: .wait
        }
    }

    @discardableResult
    public func began(sessionID: String, callID: String, action: CodeV2.ComputerActionKind, app: String?) -> Date {
        let started = now()
        emit(sessionID, ComputerActionItems.item(callID: callID, action: action, status: .running, at: started, app: app))
        return started
    }

    public func finished(
        sessionID: String,
        callID: String,
        action: CodeV2.ComputerActionKind,
        started: Date?,
        prepared: PreparedScreenAction?,
        result: ScreenActionResult?,
        failure: Error?,
        target: String? = nil
    ) async {
        let ended = now()
        var ref: String?
        if let frame = result?.frame, let store { ref = await store(sessionID, callID, frame) }
        let size = result?.frame?.size
        let status: CodeV2.ItemStatus
        var error: String?
        if let failure {
            error = screenToolFailure(failure).content.replacingOccurrences(of: "Not done: ", with: "")
            switch failure {
            case is ScreenToolDenial: status = .declined
            case is CancellationError: status = .interrupted
            case let screen as ScreenControlError where screen.endsTurn: status = .interrupted
            default: status = .failed
            }
        } else {
            status = .completed
        }
        emit(sessionID, ComputerActionItems.item(
            callID: callID,
            action: action,
            status: status,
            at: started ?? ended,
            app: prepared?.target.appName ?? previousApp(callID),
            target: target ?? prepared?.target.element,
            summary: result?.summary ?? error,
            screenshotRef: ref,
            framePoint: prepared?.framePoint,
            frameSize: size.map { ($0.width, $0.height) },
            error: error,
            durationMs: started.map { max(0, ended.timeIntervalSince($0) * 1_000) }
        ))
    }

    private func previousApp(_ callID: String) -> String? {
        if case let .computerAction(item)? = latest["ca_\(callID)"] { return item.app }
        return nil
    }

    private func emit(_ sessionID: String, _ item: CodeV2.TurnItem) {
        if latest[item.id] == nil { order.append(item.id) }
        latest[item.id] = item
        // Bounded: the store keeps the screenshots; this is a recent window.
        if order.count > 500 {
            let dropped = order.removeFirst()
            latest[dropped] = nil
        }
        publish(sessionID, item)
    }
}

public struct PortableComputerTool: CodeTool {
    let runner: ScreenActionRunner
    let seesImages: Bool
    let tracker: ScreenTurnTracker?
    let frames: PortableFrameMemory

    public init(
        computer: any ScreenControlling,
        permissions: PermissionCoordinator,
        budget: ImageBudget,
        seesImages: Bool,
        tracker: ScreenTurnTracker? = nil,
        recorder: ComputerActionRecorder? = nil,
        frames: PortableFrameMemory = PortableFrameMemory()
    ) {
        self.runner = ScreenActionRunner(computer: computer, permissions: permissions, budget: budget, recorder: recorder)
        self.seesImages = seesImages
        self.tracker = tracker
        self.frames = frames
    }

    public let name = ComputerUseToolName.portable

    public var description: String {
        let coordinates = runner.budget.coordinates == .normalized1000
            ? "x and y are 0-999 on each axis of the latest screenshot, whatever its size."
            : "x and y are pixels of the latest screenshot of that app; its size is in the first line of every result."
        let looking = seesImages
            ? "Start with screenshot (or open_app), then act; every action returns the screen after it settles. "
            : "You cannot see screenshots: screenshot and every action answer with the window's controls in words. Work with ax_find and ax_press. "
        return "Use an app on the reader's Mac that the reader granted (ask with computer_apps request). " + looking
            + "Prefer ax_find then ax_press with an element id over clicking coordinates: it hits the exact control. "
            + coordinates + " "
            + "Clicks, typing and keys ask the reader unless the session has Full access; sending, buying, deleting, signing in and changes in System Settings always ask. "
            + screenControlRules
    }

    public var inputSchema: JSONValue {
        let unit = runner.budget.coordinates == .normalized1000 ? "0-999" : "screenshot pixels"
        return [
            "type": "object",
            "properties": [
                "action": [
                    "type": "string",
                    "enum": .array(CodeV2.ComputerActionKind.allCases.map { .string($0.rawValue) }),
                    "description": "screenshot | click | double_click | right_click | move | drag | scroll | type | key | wait | open_app | zoom | ax_find (list controls, optionally matching query) | ax_press (press a control by element or query) | menu (choose a menu bar item by path)",
                ],
                "app": ["type": "string", "description": "Bundle id or app name of a granted app. Defaults to the app last used."],
                "x": ["type": "number", "description": .string("Target x (\(unit)).")],
                "y": ["type": "number", "description": .string("Target y (\(unit)).")],
                "to_x": ["type": "number", "description": "drag: end x."],
                "to_y": ["type": "number", "description": "drag: end y."],
                "element": ["type": "string", "description": "Element id from ax_find, like e12. Replaces x/y."],
                "query": ["type": "string", "description": "ax_find / ax_press: text to match in titles, labels and values."],
                "text": ["type": "string", "description": "type: the text. key: a key or chord like return, cmd+s or cmd+shift+z."],
                "direction": ["type": "string", "enum": ["up", "down", "left", "right"], "description": "scroll direction."],
                "amount": ["type": "integer", "minimum": 1, "maximum": 30, "description": "scroll: wheel notches; 3 is about a paragraph."],
                "seconds": ["type": "number", "minimum": 0, "maximum": 30, "description": "wait: seconds."],
                "region": ["type": "array", "items": ["type": "number"], "description": "zoom: [x0, y0, x1, y1]."],
                "path": ["type": "array", "items": ["type": "string"], "description": "menu: titles from the menu bar down, like [\"File\", \"Export…\"]."],
            ],
            "required": ["action"],
        ]
    }

    /// The scheduler's view only; the tool asks itself.
    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        let app = input["app"]?.stringValue ?? "the current app"
        switch input["action"]?.stringValue {
        case "type": return "Type \(input["text"]?.stringValue?.count ?? 0) characters in \(app)"
        case "key": return "Press \(input["text"]?.stringValue ?? "a key") in \(app)"
        case "open_app": return "Open \(app)"
        case "ax_find": return "Read the controls of \(app)"
        case "ax_press": return "Press \(input["element"]?.stringValue ?? input["query"]?.stringValue ?? "a control") in \(app)"
        case "menu": return "Choose " + (input["path"]?.arrayValue?.compactMap(\.stringValue).joined(separator: " › ") ?? "a menu item")
        case let action?:
            let kind = PortableComputerVocabulary.screenKind(for: action)
            return kind.map { "\($0.progressive) \(app)" } ?? "Use \(app)"
        case nil:
            return "Use \(app)"
        }
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        if let tracker, await tracker.earlierCallFailed(before: context.toolCallID) {
            await tracker.markFailed(context.toolCallID)
            return ToolResult(content: ScreenControlError.notExecutedText, isError: true)
        }
        let sessionID = context.sessionID.value
        do {
            let call = try Self.decode(input)
            let plan = try PortableComputerVocabulary.plan(
                call,
                frameConvention: runner.budget.coordinates,
                frameSize: await frames.size(sessionID: sessionID)
            )
            let answer = try await run(plan, input: input, context: context)
            return answer
        } catch {
            await tracker?.markFailed(context.toolCallID)
            if let invalid = error as? PortableComputerError {
                return ToolResult(content: invalid.message, isError: true)
            }
            return screenToolFailure(error)
        }
    }

    static func decode(_ input: JSONValue) throws -> PortableComputerCall {
        let data = try JSONEncoder().encode(input)
        do {
            return try JSONDecoder().decode(PortableComputerCall.self, from: data)
        } catch {
            throw PortableComputerError("Arguments must be an object with an action.")
        }
    }

    // MARK: - Running a plan

    private func run(_ plan: PortableComputerPlan, input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let computer = runner.computer
        let sessionID = context.sessionID.value
        switch plan {
        case let .screen(action):
            let result = try await runner.run(action, toolName: name, input: input, context: context, attachFrame: true)
            await frames.remember(result, sessionID: sessionID)
            return try await answer(result, app: action.app, context: context)

        case let .openApp(app):
            let started = await runner.recorder?.began(sessionID: sessionID, callID: context.toolCallID, action: .openApp, app: app)
            do {
                await computer.setImageBudget(sessionID: sessionID, budget: runner.budget)
                try await ScreenTakeoverWait.untilResumed(computer, sessionID: sessionID)
                let result = try await computer.open(sessionID: sessionID, app: app)
                await frames.remember(result, sessionID: sessionID)
                await runner.recorder?.finished(
                    sessionID: sessionID, callID: context.toolCallID, action: .openApp, started: started,
                    prepared: nil, result: result, failure: nil, target: app
                )
                return try await answer(result, app: app, context: context)
            } catch {
                await runner.recorder?.finished(
                    sessionID: sessionID, callID: context.toolCallID, action: .openApp, started: started,
                    prepared: nil, result: nil, failure: error, target: app
                )
                throw error
            }

        case let .axFind(app, query):
            let started = await runner.recorder?.began(sessionID: sessionID, callID: context.toolCallID, action: .axFind, app: app)
            do {
                let text = try await controls(app: app, query: query, sessionID: sessionID)
                await runner.recorder?.finished(
                    sessionID: sessionID, callID: context.toolCallID, action: .axFind, started: started,
                    prepared: nil, result: ScreenActionResult(summary: query.map { "Found the controls matching “\($0)”." } ?? "Read the window's controls."),
                    failure: nil, target: query.map { "“\($0)”" }
                )
                return ToolResult(content: text)
            } catch {
                await runner.recorder?.finished(
                    sessionID: sessionID, callID: context.toolCallID, action: .axFind, started: started,
                    prepared: nil, result: nil, failure: error
                )
                throw error
            }

        case let .axPress(app, element, query):
            var id = element
            if id == nil, let query {
                let listing = try await controls(app: app, query: query, sessionID: sessionID)
                guard let match = PortableComputerVocabulary.uniqueMatch(for: query, in: listing) else {
                    let none = PortableComputerVocabulary.listedElements(in: listing).isEmpty
                    let lead = none
                        ? "Nothing pressable matches “\(query)”. Read the window with ax_find, or take a screenshot."
                        : "More than one control matches “\(query)”. Call ax_press again with one element id:"
                    return ToolResult(content: lead + "\n" + listing, isError: true)
                }
                id = match
            }
            let action = ScreenAction(kind: .leftClick, app: app, element: id)
            let result = try await runner.run(action, toolName: name, input: input, context: context, attachFrame: true, itemAction: .axPress)
            await frames.remember(result, sessionID: sessionID)
            return try await answer(result, app: app, context: context)

        case let .menu(app, path):
            let started = await runner.recorder?.began(sessionID: sessionID, callID: context.toolCallID, action: .menu, app: app)
            var prepared: PreparedScreenAction?
            do {
                await computer.setImageBudget(sessionID: sessionID, budget: runner.budget)
                try await ScreenTakeoverWait.untilResumed(computer, sessionID: sessionID)
                let ready = try await computer.prepareMenu(sessionID: sessionID, app: app, path: path)
                prepared = ready
                try await runner.approve(ready, toolName: name, input: input, sessionID: sessionID)
                let result = try await computer.performMenu(sessionID: sessionID, prepared: ready, path: path, toolCallID: context.toolCallID)
                await frames.remember(result, sessionID: sessionID)
                await runner.recorder?.finished(
                    sessionID: sessionID, callID: context.toolCallID, action: .menu, started: started,
                    prepared: ready, result: result, failure: nil, target: path.joined(separator: " › ")
                )
                return try await answer(result, app: app, context: context)
            } catch {
                await runner.recorder?.finished(
                    sessionID: sessionID, callID: context.toolCallID, action: .menu, started: started,
                    prepared: prepared, result: nil, failure: error, target: path.joined(separator: " › ")
                )
                throw error
            }
        }
    }

    private func controls(app: String?, query: String?, sessionID: String) async throws -> String {
        let computer = runner.computer
        await computer.setImageBudget(sessionID: sessionID, budget: runner.budget)
        try await ScreenTakeoverWait.untilResumed(computer, sessionID: sessionID)
        return try await computer.accessibility(sessionID: sessionID, app: app, query: query, filter: .interactive, depth: 12)
    }

    /// A model that sees gets the frame; one that cannot gets the controls.
    private func answer(_ result: ScreenActionResult, app: String?, context: ToolContext) async throws -> ToolResult {
        if seesImages { return ToolResult(content: result.text, images: ScreenActionRunner.images(result)) }
        let listing = (try? await controls(app: app, query: nil, sessionID: context.sessionID.value))
            ?? "The window's controls could not be read."
        let lines = ([result.summary] + result.notes + [listing]).filter { !$0.isEmpty }
        return ToolResult(content: lines.joined(separator: "\n"))
    }
}
