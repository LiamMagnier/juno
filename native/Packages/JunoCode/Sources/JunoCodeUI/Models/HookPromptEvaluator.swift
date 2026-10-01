import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

/// Answers `prompt` hooks with one tool-less model turn (CODE_AGENT_SPEC
/// §5.9), over the session's own model client so it is billed and routed like
/// the rest of the session.
///
/// The hook names its model, or the session's model answers. The goal judge's
/// small-model route (D-020) is the intended default once it exists; until
/// then the session's model is the one Juno knows the reader can use.
struct ModelHookPromptEvaluator: HookPromptEvaluating {
    let client: any AgentModelClient
    let sessionID: CodeSessionID
    let defaultModelID: @Sendable () -> String
    /// Puts the call's spend in the session's usage ledger, so `/cost`
    /// counts what prompt hooks cost like every other call (§5.5).
    var recordUsage: @Sendable (SessionUsageLedger) async -> Void = { _ in }

    /// A `{ok, reason}` answer is short; a model that runs on is cut off
    /// rather than billed for an essay.
    static let maximumOutputTokens = 300

    func evaluate(system: String, user: String, model: String?) async throws -> String {
        let request = ModelTurnRequest(
            sessionID: sessionID,
            systemPrompt: system,
            messages: [.user(user)],
            tools: [],
            modelID: model ?? defaultModelID(),
            reasoningEffort: nil,
            maximumOutputTokens: Self.maximumOutputTokens
        )
        var text = ""
        var input: Int?
        var output: Int?
        var cacheRead: Int?
        var cacheWrite: Int?
        do {
            for try await event in client.streamTurn(request) {
                switch event {
                case let .textDelta(delta): text += delta
                case let .usage(inputTokens, outputTokens):
                    input = inputTokens ?? input
                    output = outputTokens ?? output
                case let .cacheUsage(readTokens, writeTokens):
                    cacheRead = readTokens ?? cacheRead
                    cacheWrite = writeTokens ?? cacheWrite
                default: break
                }
            }
        } catch {
            await record(input, output, cacheRead, cacheWrite, modelID: request.modelID)
            throw error
        }
        await record(input, output, cacheRead, cacheWrite, modelID: request.modelID)
        return text
    }

    private func record(_ input: Int?, _ output: Int?, _ cacheRead: Int?, _ cacheWrite: Int?, modelID: String) async {
        var ledger = SessionUsageLedger()
        ledger.record(ModelCallUsage(
            purpose: .turn,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            modelID: modelID
        ))
        guard !ledger.isEmpty else { return }
        await recordUsage(ledger)
    }
}
