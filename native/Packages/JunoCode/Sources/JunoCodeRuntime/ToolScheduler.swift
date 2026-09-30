import Foundation
import JunoCodeCore

/// Schedules model tool requests, identifying conflict boundaries,
/// parallelizing independent read and search operations, and serializing
/// conflicting writes and exclusive processes.
public actor ToolScheduler {
    public struct ExecutionResult: Sendable {
        public let callID: String
        public let toolName: String
        public let input: JSONValue
        public let content: String
        public let isError: Bool
        public let images: [ModelImage]
        public let sideEffects: [SessionEventPayload]
        /// A hook answered `"continue": false` around this call, so the run
        /// ends once the batch is answered.
        public let haltReason: String?
        /// The tool itself ended the run (see ``ToolResult/endsRun``).
        public let endsRun: String?
        /// Context to follow the bounded content (see
        /// ``ToolResult/appendedContext``).
        public let appendedContext: String?

        public init(
            callID: String,
            toolName: String,
            input: JSONValue,
            content: String,
            isError: Bool,
            images: [ModelImage] = [],
            sideEffects: [SessionEventPayload] = [],
            haltReason: String? = nil,
            endsRun: String? = nil,
            appendedContext: String? = nil
        ) {
            self.callID = callID
            self.toolName = toolName
            self.input = input
            self.content = content
            self.isError = isError
            self.images = images
            self.sideEffects = sideEffects
            self.haltReason = haltReason
            self.endsRun = endsRun
            self.appendedContext = appendedContext
        }
    }

    public typealias Executor = @Sendable (
        _ id: String,
        _ name: String,
        _ input: JSONValue
    ) async -> ExecutionResult

    public init() {}

    /// Partitions an ordered sequence of tool requests into waves of concurrent calls.
    /// Calls within the same wave are guaranteed not to conflict with each other.
    public static func partitionIntoWaves(
        _ calls: [(id: String, name: String, input: JSONValue, extraContent: JSONValue?)]
    ) -> [[(id: String, name: String, input: JSONValue, extraContent: JSONValue?)]] {
        guard !calls.isEmpty else { return [] }

        var waves: [[(id: String, name: String, input: JSONValue, extraContent: JSONValue?)]] = []
        var currentWave: [(id: String, name: String, input: JSONValue, extraContent: JSONValue?)] = []
        var currentEffects: [ToolConflictEffect] = []

        for call in calls {
            let effect = ToolEffectClassifier.classify(toolName: call.name, input: call.input)

            if currentWave.isEmpty {
                currentWave.append(call)
                currentEffects.append(effect)
                continue
            }

            // An exclusive effect cannot share a wave with anything else.
            if case .exclusive = effect {
                waves.append(currentWave)
                currentWave = [call]
                currentEffects = [effect]
                continue
            }

            // If the current wave already contains an exclusive effect, start a new wave.
            if currentEffects.contains(where: { if case .exclusive = $0 { return true }; return false }) {
                waves.append(currentWave)
                currentWave = [call]
                currentEffects = [effect]
                continue
            }

            // Check if this effect conflicts with any effect currently in this wave.
            let hasConflict = currentEffects.contains { $0.conflicts(with: effect) }
            if hasConflict {
                waves.append(currentWave)
                currentWave = [call]
                currentEffects = [effect]
            } else {
                currentWave.append(call)
                currentEffects.append(effect)
            }
        }

        if !currentWave.isEmpty {
            waves.append(currentWave)
        }

        return waves
    }

    /// Executes tool calls wave-by-wave, running safe concurrent calls in parallel
    /// and serializing conflicting calls. Halts between waves if `shouldInterrupt`
    /// returns true (e.g. on steering or cancellation).
    public func execute(
        calls: [(id: String, name: String, input: JSONValue, extraContent: JSONValue?)],
        shouldInterrupt: @Sendable () async -> Bool,
        executor: @escaping Executor
    ) async -> [ExecutionResult] {
        let waves = Self.partitionIntoWaves(calls)
        var allResults: [ExecutionResult] = []

        for wave in waves {
            if Task.isCancelled { break }
            if await shouldInterrupt() { break }

            if wave.count == 1 {
                let call = wave[0]
                let result = await executor(call.id, call.name, call.input)
                allResults.append(result)
            } else {
                // Execute independent tools concurrently within this wave
                let waveResults = await withTaskGroup(
                    of: (Int, ExecutionResult).self,
                    returning: [ExecutionResult].self
                ) { group in
                    for (index, call) in wave.enumerated() {
                        group.addTask {
                            let res = await executor(call.id, call.name, call.input)
                            return (index, res)
                        }
                    }

                    var collected: [(Int, ExecutionResult)] = []
                    for await indexedResult in group {
                        collected.append(indexedResult)
                    }
                    // Restore original relative order within the wave
                    return collected.sorted { $0.0 < $1.0 }.map { $0.1 }
                }
                allResults.append(contentsOf: waveResults)
            }
        }

        return allResults
    }

    /// Executes a single tool call through the provided registry and permission coordinator,
    /// recording lifecycle events into the session store.
    public static func executeCall(
        id: String,
        name: String,
        input: JSONValue,
        sessionID: CodeSessionID,
        registry: ToolRegistry,
        permissions: PermissionCoordinator,
        lifecycleHooks: (any AgentLifecycleHooks)?,
        store: CodeSessionStore,
        maximumToolImages: Int = 10,
        maximumToolImageBytes: Int = 20 * 1024 * 1024
    ) async -> ExecutionResult {
        let startedAt = Date()
        let hookInvocation = AgentToolHookInvocation(
            sessionID: sessionID,
            toolCallID: id,
            toolName: name,
            input: input
        )

        var hookPermission: AgentHookPermission?
        if let lifecycleHooks {
            let response = await lifecycleHooks.beforeTool(hookInvocation)
            // Stop can land while a `PreToolUse` hook runs. The hook is killed,
            // and a killed hook reads as a non-blocking failure, so without
            // this the call would go on: in Full access to run the tool, and
            // in a mode that asks to raise a new prompt for a run the reader
            // has just stopped — one `stop()` would then sit waiting on.
            guard !Task.isCancelled else {
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .toolCompleted(
                        ToolCompletedEvent(
                            toolCallID: id,
                            status: .cancelled,
                            resultSummary: "Stopped before it ran.",
                            durationSeconds: Date().timeIntervalSince(startedAt)
                        )
                    )
                )
                return ExecutionResult(
                    callID: id,
                    toolName: name,
                    input: input,
                    content: ConversationIntegrity.notExecutedMessage,
                    isError: true
                )
            }
            await record(response.notices, sessionID: sessionID, store: store)
            // `"continue": false` outranks every other answer, as it does in
            // Claude Code: the call does not run and neither does the rest
            // of the turn.
            if let reason = response.haltReason ?? response.blockReason {
                let message = response.haltReason != nil
                    ? "Action not run: a hook ended the run. \(reason)"
                    : "Action blocked by hook: \(reason)"
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .toolCompleted(
                        ToolCompletedEvent(
                            toolCallID: id,
                            status: .denied,
                            resultSummary: message,
                            durationSeconds: Date().timeIntervalSince(startedAt)
                        )
                    )
                )
                return ExecutionResult(
                    callID: id,
                    toolName: name,
                    input: input,
                    content: message,
                    isError: true,
                    haltReason: response.haltReason
                )
            }
            hookPermission = response.permission
        }

        do {
            try await registry.authorizeInvocation(
                toolName: name,
                input: input,
                permissions: permissions,
                hookPermission: hookPermission
            )
        } catch {
            let reason = deniedReason(from: error)
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: id,
                        status: .denied,
                        resultSummary: reason,
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            return ExecutionResult(
                callID: id,
                toolName: name,
                input: input,
                content: "Action not permitted: \(reason)",
                isError: true
            )
        }

        _ = try? await store.appendEvent(
            sessionID: sessionID,
            payload: .toolStarted(ToolStartedEvent(toolCallID: id))
        )

        let context = ToolContext(
            sessionID: sessionID,
            toolCallID: id,
            emitOutput: { channel, text in
                let limited = OutputLimiter.apply(.streamChunk, to: text)
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .toolOutput(
                        ToolOutputEvent(toolCallID: id, channel: channel, text: limited.text)
                    )
                )
            }
        )

        do {
            let result = try await registry.executeAuthorized(
                toolName: name,
                input: input,
                context: context
            )
            let imageBytes = result.images.reduce(into: 0) { total, image in
                total += image.data.count
            }
            guard result.images.count <= maximumToolImages,
                  imageBytes <= maximumToolImageBytes
            else {
                let message = "Tool image output exceeded the safe request limit."
                _ = try? await store.appendEvent(
                    sessionID: sessionID,
                    payload: .toolCompleted(
                        ToolCompletedEvent(
                            toolCallID: id,
                            status: .failed,
                            resultSummary: message,
                            durationSeconds: Date().timeIntervalSince(startedAt)
                        )
                    )
                )
                return ExecutionResult(
                    callID: id,
                    toolName: name,
                    input: input,
                    content: message,
                    isError: true
                )
            }

            for sideEffect in result.sideEffects {
                _ = try? await store.appendEvent(sessionID: sessionID, payload: sideEffect)
            }

            let firstLineResult = result.content.components(separatedBy: "\n").first ?? result.content
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: id,
                        status: result.isError ? .failed : .succeeded,
                        resultSummary: firstLineResult,
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            // PostToolUse runs for a call that ran and answered, as in Claude
            // Code; a call that threw never produced a result to look at.
            // What a post hook says reaches the model with the result, since
            // the tool has already happened and cannot be taken back.
            let after = await lifecycleHooks?.afterTool(
                hookInvocation,
                succeeded: !result.isError,
                content: result.content
            ) ?? .empty
            await record(after.notices, sessionID: sessionID, store: store)
            var notes: [String] = []
            if let reason = after.blockReason {
                notes.append("PostToolUse hook feedback:\n" + reason)
            }
            let content = AgentHookContext.appending(
                after.context,
                to: ([result.content] + notes).joined(separator: "\n\n")
            )

            return ExecutionResult(
                callID: id,
                toolName: name,
                input: input,
                content: content,
                isError: result.isError,
                images: result.images,
                sideEffects: result.sideEffects,
                haltReason: after.haltReason,
                endsRun: result.endsRun,
                appendedContext: result.appendedContext
            )
        } catch {
            let message = String(describing: error)
            _ = try? await store.appendEvent(
                sessionID: sessionID,
                payload: .toolCompleted(
                    ToolCompletedEvent(
                        toolCallID: id,
                        status: .failed,
                        resultSummary: message,
                        durationSeconds: Date().timeIntervalSince(startedAt)
                    )
                )
            )
            return ExecutionResult(
                callID: id,
                toolName: name,
                input: input,
                content: "Tool execution failed: \(message)",
                isError: true
            )
        }
    }

    /// Writes what hooks asked the thread to show, where they ran.
    static func record(
        _ notices: [HookActivityEvent],
        sessionID: CodeSessionID,
        store: CodeSessionStore
    ) async {
        for notice in notices {
            _ = try? await store.appendEvent(sessionID: sessionID, payload: .hookActivity(notice))
        }
    }

    private static func deniedReason(from error: Error) -> String {
        if case let ToolError.denied(reason) = error {
            return reason
        }
        if case let ToolError.invalidInput(message) = error {
            return message
        }
        let text = String(describing: error)
        return text.count > 300 ? String(text.prefix(300)) + "…" : text
    }
}
