import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

/// Arguments that do not parse are answered with the parser's complaint and
/// never run as `{}`; arguments that parse but arrive as the wrong scalar
/// type are converted where the conversion is exact.
final class MalformedToolInputTests: XCTestCase {
    private var baseURL: URL!
    private var store: CodeSessionStore!
    private var session: CodeSession!

    override func setUp() async throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-malformed-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: baseURL.appendingPathComponent("store"))
        session = try await store.createSession(
            workspaceID: WorkspaceID(),
            workspaceName: "Demo",
            title: "Malformed",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    // MARK: - Parsing

    func testArgumentsParseOrSayWhyNot() {
        XCTAssertEqual(ToolArguments.parse(""), .value(.object([:])), "a call with no parameters")
        XCTAssertEqual(ToolArguments.parse(#"{"path":"a.swift"}"#), .value(["path": "a.swift"]))
        guard case let .malformed(error) = ToolArguments.parse(#"{"path":"a.sw"#) else {
            return XCTFail("a truncated object is not an input")
        }
        XCTAssertFalse(error.isEmpty)

        let answer = ToolArguments.malformedResult(
            toolName: "read_file",
            rawArguments: #"{"path":"a.sw"#,
            error: error
        )
        XCTAssertTrue(answer.contains("read_file"))
        XCTAssertTrue(answer.contains(error))
        XCTAssertTrue(answer.contains(#"{"path":"a.sw"#))
    }

    func testAMalformedCallIsAnsweredAndNeverRun() async throws {
        let recorder = CallRecorder()
        let model = ScriptedModelClient(steps: [
            .events([
                .toolCallMalformed(
                    id: "bad",
                    name: "recording_tool",
                    rawArguments: #"{"count": 3, "label": "unfin"#,
                    error: "Unexpected end of file",
                    extraContent: nil
                ),
                .toolCallRequested(id: "good", name: "recording_tool", input: ["count": 1]),
                .turnCompleted(.toolUse),
            ]),
            .text("Resent it."),
        ])
        let orchestrator = AgentOrchestrator(
            sessionID: session.id,
            model: model,
            registry: ToolRegistry(tools: [RecordingTool(recorder: recorder)]),
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            store: store,
            configuration: AgentOrchestrator.Configuration(systemPrompt: "sys"),
            modelID: "test-model",
            reasoningEffort: nil
        )

        try await orchestrator.submit(prompt: "Count")
        await orchestrator.awaitCompletion()

        XCTAssertEqual(recorder.inputs, [["count": 1]], "only the well-formed call ran")
        let followUp = try XCTUnwrap(model.receivedRequests.last)
        XCTAssertTrue(ConversationIntegrity.isValid(followUp.messages))
        var results: [String: (String, Bool)] = [:]
        for case let .toolResult(id, content, isError) in followUp.messages {
            results[id] = (content, isError)
        }
        let bad = try XCTUnwrap(results["bad"])
        XCTAssertTrue(bad.1)
        XCTAssertTrue(bad.0.contains("not valid JSON"))
        XCTAssertTrue(bad.0.contains("Unexpected end of file"))
        XCTAssertTrue(bad.0.contains("recording_tool"))
        XCTAssertFalse(try XCTUnwrap(results["good"]).1)
        // The call is kept in the history in a shape every provider replays.
        XCTAssertTrue(followUp.messages.contains(.toolCall(id: "bad", name: "recording_tool", input: [:])))
        let completed = await store.events(for: session.id).compactMap { event -> ToolCompletedEvent? in
            if case let .toolCompleted(done) = event.payload, done.toolCallID == "bad" { return done }
            return nil
        }
        XCTAssertEqual(completed.map(\.status), [.failed])
    }

    // MARK: - Coercion

    private let schema: JSONValue = [
        "type": "object",
        "properties": [
            "count": ["type": "integer"],
            "ratio": ["type": "number"],
            "force": ["type": "boolean"],
            "paths": ["type": "array", "items": ["type": "string"]],
            "sizes": ["type": "array", "items": ["type": "integer"]],
            "options": ["type": "object"],
            "limit": ["type": ["integer", "null"]],
            "name": ["type": "string"],
        ],
    ]

    func testExactScalarConversionsFollowTheSchema() {
        let coerced = SchemaValidator.coerced(
            input: [
                "count": "3",
                "ratio": " 0.5 ",
                "force": "TRUE",
                "paths": #"["a", "b"]"#,
                "sizes": ["1", 2],
                "options": #"{"deep": true}"#,
                "limit": "10",
                "name": "7",
            ],
            against: schema
        )
        XCTAssertEqual(coerced, [
            "count": 3,
            "ratio": 0.5,
            "force": true,
            "paths": ["a", "b"],
            "sizes": [1, 2],
            "options": ["deep": true],
            "limit": 10,
            "name": "7",
        ])
        XCTAssertNil(SchemaValidator.validate(input: coerced, against: schema))
    }

    func testWhatDoesNotConvertExactlyIsLeftForValidationToName() {
        let coerced = SchemaValidator.coerced(input: ["count": "3.5", "force": "yes"], against: schema)
        XCTAssertEqual(coerced, ["count": "3.5", "force": "yes"])
        XCTAssertEqual(
            SchemaValidator.validate(input: ["count": "3.5"], against: schema),
            "Field 'count' must be an integer."
        )
    }

    func testArgumentsSentAsOneJSONStringAreUnwrapped() {
        XCTAssertEqual(
            SchemaValidator.coerced(input: .string(#"{"count": "4"}"#), against: schema),
            ["count": 4]
        )
    }

    func testAnMCPSchemaWithoutATopLevelTypeStillValidates() {
        let mcp: JSONValue = ["properties": ["query": ["type": "string"]], "required": ["query"]]
        XCTAssertNil(SchemaValidator.validate(input: ["query": "x"], against: mcp))
        XCTAssertEqual(SchemaValidator.validate(input: [:], against: mcp), "Missing required field 'query'.")
        XCTAssertNil(SchemaValidator.validate(input: ["anything": 1], against: [:]), "no properties, no key constraint")
    }

    func testTheToolRunsWithTheConvertedArguments() async throws {
        let recorder = CallRecorder()
        let registry = ToolRegistry(tools: [RecordingTool(recorder: recorder)])
        let result = await ToolScheduler.executeCall(
            id: "c1",
            name: "recording_tool",
            input: ["count": "5"],
            sessionID: session.id,
            registry: registry,
            permissions: PermissionCoordinator(sessionID: session.id, mode: .fullAccess),
            lifecycleHooks: nil,
            store: store
        )
        XCTAssertFalse(result.isError, result.content)
        XCTAssertEqual(recorder.inputs, [["count": 5]])
        XCTAssertEqual(result.input, ["count": 5])
    }
}

private final class CallRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [JSONValue] = []

    func record(_ input: JSONValue) {
        lock.lock(); recorded.append(input); lock.unlock()
    }

    var inputs: [JSONValue] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }
}

private struct RecordingTool: CodeTool {
    let recorder: CallRecorder
    let name = "recording_tool"
    let description = "Records its input."
    let inputSchema: JSONValue = [
        "type": "object",
        "properties": [
            "count": ["type": "integer"],
            "label": ["type": "string"],
        ],
        "required": ["count"],
    ]

    func assessRisk(input: JSONValue) -> ActionRisk { .read }
    func summary(input: JSONValue) -> String { "Record" }

    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        recorder.record(input)
        return ToolResult(content: "recorded")
    }
}
