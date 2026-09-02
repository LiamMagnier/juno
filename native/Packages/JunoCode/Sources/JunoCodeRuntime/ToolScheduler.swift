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

        public init(
            callID: String,
            toolName: String,
            input: JSONValue,
            content: String,
            isError: Bool,
            images: [ModelImage] = [],
            sideEffects: [SessionEventPayload] = []
        ) {
            self.callID = callID
            self.toolName = toolName
            self.input = input
            self.content = content
            self.isError = isError
            self.images = images
            self.sideEffects = sideEffects
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
            toolName: name,
            input: input
        )

        if let lifecycleHooks {
            switch await lifecycleHooks.beforeTool(hookInvocation) {
            case .allow:
                break
            case let .deny(reason):
                let message = "Action blocked by hook: \(reason)"
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
                    isError: true
                )
            }
        }

        do {
            try await registry.authorizeInvocation(
                toolName: name,
                input: input,
                permissions: permissions
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
                await lifecycleHooks?.afterTool(
                    hookInvocation,
                    succeeded: false,
                    summary: message
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
            await lifecycleHooks?.afterTool(
                hookInvocation,
                succeeded: !result.isError,
                summary: firstLineResult
            )

            return ExecutionResult(
                callID: id,
                toolName: name,
                input: input,
                content: result.content,
                isError: result.isError,
                images: result.images,
                sideEffects: result.sideEffects
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
            await lifecycleHooks?.afterTool(
                hookInvocation,
                succeeded: false,
                summary: message
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
