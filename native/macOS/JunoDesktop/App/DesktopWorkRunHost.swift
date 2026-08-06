import Foundation
import JunoAuth
import JunoCodeCore
import JunoCodeRuntime
import JunoCore
import JunoWorkCore
import JunoWorkKit
import JunoWorkRuntime

/// The model loop for one Juno Work run on this Mac.
///
/// `WorkRunHosting` had no production conformance at all, which is why every
/// `start` this Mac could have claimed would have failed at the first line of
/// `LocalWorkExecutor.execute`: the grants existed, the tools existed, the
/// approval gate existed, and nothing drove them.
///
/// The loop is deliberately the *only* thing here that is new. It claims no
/// authority of its own:
///
/// * **Every tool call goes through `WorkToolRegistry.invoke`**, which validates,
///   prechecks, asks the person if the risk calls for it, and re-verifies the
///   action digest against the arguments about to run. There is no second path,
///   and this file must never grow one — a loop that reached
///   `executeAuthorized` directly would be a loop that could skip the question.
/// * **The tools it can call are assembled from the request's grants**, not from
///   anything the instruction said. `WorkRunRequest.payload` is read for the
///   goal, the model and the approval mode, and for nothing else — which is the
///   whole escalation boundary: a phone says what it wants done and cannot say
///   what this Mac may do. The mode is not an exception to that. It goes through
///   `WorkApprovalCoordinator.setRunPolicy`, which takes the `min` of it and
///   this Mac's own switch, so the only thing an instruction can do to the gate
///   is tighten it; and an instruction that names no mode gets Manual, not the
///   Mac's setting.
/// * **The transcript is reported, not inferred.** Everything a watcher sees is
///   an event this loop emitted at the moment it happened, drained through
///   ``WorkRunReporting``.
///
/// Turns are streamed through `JunoCodeRuntime.AgentModelClient`. Juno Work has
/// no transport of its own and should not grow one: both products stream from
/// `/api/agent` through the account's authenticated runtime, and a second client
/// would be a second thing to keep correct rather than a boundary worth having.
actor DesktopWorkRunHost: WorkRunHosting {
    struct Dependencies: Sendable {
        let hostID: String
        let accountID: AccountID
        let model: any AgentModelClient
        let reporter: any WorkRunReporting
        /// The model a run uses when its instruction did not name one.
        let defaultModelID: String
        /// Tools that are not bound to a granted folder — screen, app and
        /// browser control. Asked per run rather than held, because whether this
        /// Mac holds the macOS permissions behind them can change between runs.
        let automationTools: @Sendable () async -> [any WorkTool]
        /// How many runs are live, for the host's advertisement. The relay reads
        /// it to tell a busy Mac from an idle one.
        let activityChanged: @Sendable (Int) async -> Void
    }

    /// The ceiling on turns in one run.
    ///
    /// A loop that cannot end is the failure mode this shape has: a model that
    /// keeps calling one more tool costs the account money for as long as the Mac
    /// is awake, and nobody watching a progress spinner can tell that from work.
    /// Ending with a stated reason is recoverable — the person can resume — and
    /// running forever is not.
    static let maximumTurns = 64

    /// How many unsent events one run may hold while the relay is unreachable.
    static let maximumBufferedEvents = 2_000

    private let dependencies: Dependencies
    private var runs: [String: Task<Void, Never>] = [:]
    private var paused: Set<String> = []
    private var resumeGates: [String: CheckedContinuation<Void, Never>] = [:]
    /// What the person has said that the next turn has not consumed yet.
    ///
    /// One queue for answers and instructions rather than two, because the order
    /// they arrived in is the order they have to reach the model. Somebody who
    /// answers a question and then adds "and use the March figures" has said the
    /// second thing about the first, and two queues drained one after the other
    /// would put them in the transcript in whichever order the drain happened to
    /// pick.
    private var inbound: [String: [Said]] = [:]
    private var outboxes: [String: Outbox] = [:]
    /// The gate each live run was pinned against, so `retire` can unpin it.
    ///
    /// Held rather than reached for through the request, because `stopRun` and
    /// the end of `drive` both retire a run and neither has the request in
    /// hand. It is the same coordinator every time in practice — one per Mac —
    /// and keeping it per run is what makes "unpin exactly the run that ended"
    /// expressible rather than assumed.
    private var gates: [String: WorkApprovalCoordinator] = [:]

    init(dependencies: Dependencies) {
        self.dependencies = dependencies
    }

    // MARK: - WorkRunHosting

    func startRun(_ request: WorkRunRequest) async throws {
        guard runs[request.runID] == nil else {
            throw DesktopWorkRunError.alreadyRunning
        }
        let goal = Self.goal(in: request.payload)
        guard let goal, !goal.isEmpty else { throw DesktopWorkRunError.noGoal }
        let automation = await dependencies.automationTools()
        guard !request.grants.isEmpty || !automation.isEmpty else {
            throw DesktopWorkRunError.nothingGranted
        }
        try await begin(request, goal: goal, automation: automation, resuming: false)
    }

    /// Resuming a run this Mac is already driving is a no-op rather than a
    /// second loop.
    ///
    /// The relay re-delivers a command whose lease lapsed, and a Mac that was
    /// merely slow to acknowledge would otherwise answer by starting the same
    /// run twice — two loops sharing one approval coordinator, each acting on
    /// the other's answers.
    func resumeRun(_ request: WorkRunRequest) async throws {
        if runs[request.runID] != nil {
            guard paused.contains(request.runID) else { return }
            paused.remove(request.runID)
            resumeGates.removeValue(forKey: request.runID)?.resume()
            await emit(request.runID, "resumed")
            return
        }
        guard let goal = Self.goal(in: request.payload), !goal.isEmpty else {
            throw DesktopWorkRunError.noGoal
        }
        try await begin(
            request,
            goal: goal,
            automation: await dependencies.automationTools(),
            resuming: true
        )
    }

    /// Parks the run before its next turn.
    ///
    /// Between turns, not mid-turn. A pause that cancelled a streaming turn would
    /// throw away the tokens the account has already paid for, and a pause that
    /// interrupted a tool call would leave the folder halfway through a batch —
    /// which is the one state undo exists to avoid having to reason about.
    func pauseRun(runID: String) async throws {
        guard runs[runID] != nil else { throw DesktopWorkRunError.notLive }
        guard !paused.contains(runID) else { return }
        paused.insert(runID)
        await emit(runID, "paused")
    }

    func stopRun(runID: String, reason: String) async throws {
        guard let task = runs[runID] else { throw DesktopWorkRunError.notLive }
        // The gate first. A parked loop is suspended on a continuation, and
        // cancelling a task that is waiting on one leaves it suspended for ever —
        // the run would never finish, never report, and never release its slot.
        paused.remove(runID)
        resumeGates.removeValue(forKey: runID)?.resume()
        task.cancel()
        await emit(runID, "run_finished", ["reason": .string(reason), "outcome": .string("stopped")])
        await retire(runID)
    }

    /// Hands the person's reply to a run.
    ///
    /// Queued rather than injected mid-turn: a message appended while a turn is
    /// streaming would reach the model in the *next* request anyway, and pretending
    /// otherwise would have the transcript claim an answer was seen a turn before
    /// it could be.
    func deliverAnswer(runID: String, text: String) async throws {
        guard runs[runID] != nil else { throw DesktopWorkRunError.notLive }
        inbound[runID, default: []].append(.answer(text))
        await emit(runID, "question_answered", ["text": .string(text)])
    }

    /// Hands the run something nobody asked it for.
    ///
    /// Queued exactly as an answer is, and for a stronger version of the same
    /// reason. `scripts/work-runner.ts` wraps the cloud provider so a steer is
    /// appended to the messages of the *next* request rather than aborting the
    /// one in flight — the abort-and-restore alternative reaches the model no
    /// sooner and throws away every tool call that was running when the person
    /// pressed Enter, and a folder left halfway through a batch is the one state
    /// undo exists so nobody has to reason about. This loop drains the queue at
    /// the top of its turn, before it builds the request, which is the same
    /// moment by construction.
    ///
    /// No event is emitted. The row is already in the run's log — the route
    /// wrote `user_message` before it queued this command, which is what the
    /// cloud runner reads too — and emitting a second one would show the person
    /// their own sentence twice in their own thread. The acknowledgement this
    /// command carries is what says it landed.
    func deliverInstruction(runID: String, text: String) async throws {
        guard runs[runID] != nil else { throw DesktopWorkRunError.notLive }
        inbound[runID, default: []].append(.instruction(text))
    }

    // MARK: - Driving one run

    private func begin(
        _ request: WorkRunRequest,
        goal: String,
        automation: [any WorkTool],
        resuming: Bool
    ) async throws {
        let bindings = Self.bindings(for: request, automationTools: automation)
        // The mode this task was dispatched under, pinned onto the gate before
        // the first turn can call a tool.
        //
        // Read from the payload beside the goal, and read the same way: the
        // instruction says what the person asked for, and `setRunPolicy` can
        // only narrow against this Mac's own switch — so this is data the run
        // reads, never authority it claims. Without it every task landing here
        // was gated on the Mac's standing policy alone, which made the control
        // in the composer describe a narrowing that stopped at the relay.
        await request.approvals.setRunPolicy(
            Self.permissionPolicy(in: request.payload), for: request.runID
        )
        gates[request.runID] = request.approvals
        outboxes[request.runID] = Outbox()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.drive(request, goal: goal, bindings: bindings)
        }
        runs[request.runID] = task
        await emit(
            request.runID,
            resuming ? "resumed" : "run_started",
            ["goal": .string(goal), "tools": .number(Double(bindings.count))]
        )
        await dependencies.activityChanged(runs.count)
    }

    private func drive(_ request: WorkRunRequest, goal: String, bindings: [ToolBinding]) async {
        var messages: [ModelMessage] = [.user(goal)]
        let descriptors = bindings.map(\.descriptor)
        let modelID = request.payload["model"]?.stringValue ?? dependencies.defaultModelID
        let sessionID = CodeSessionID(value: request.sessionID)

        var turn = 0
        while turn < Self.maximumTurns {
            if Task.isCancelled { return }
            await waitWhilePaused(request.runID)
            if Task.isCancelled { return }
            for said in takeInbound(request.runID) { messages.append(.user(said.modelText)) }
            turn += 1

            var reply = ""
            var calls: [(id: String, name: String, input: JSONValue)] = []
            var stop = ModelStopReason.endTurn
            do {
                let stream = dependencies.model.streamTurn(
                    ModelTurnRequest(
                        sessionID: sessionID,
                        systemPrompt: Self.systemPrompt(for: request, bindings: bindings),
                        messages: messages,
                        tools: descriptors,
                        modelID: modelID,
                        // No thinking parameter. Work's model is chosen by the
                        // dispatching client and this Mac has no manifest to
                        // check it against; several providers reject the field
                        // outright, and an omitted one costs a shallower answer
                        // where a wrong one fails the whole turn.
                        reasoningEffort: nil
                    )
                )
                for try await event in stream {
                    switch event {
                    case .textDelta(let delta):
                        reply += delta
                    case .toolCallRequested(let id, let name, let input):
                        calls.append((id: id, name: name, input: input))
                    case .turnCompleted(let reason):
                        stop = reason
                    case .reasoningSummary, .usage:
                        // Neither belongs in a Work transcript: the summary is
                        // the model talking to itself, and usage is an account
                        // fact the relay already bills from its own side.
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                await emit(request.runID, "error", ["message": .string(error.localizedDescription)])
                await finish(request.runID, outcome: "failed", reason: error.localizedDescription)
                return
            }

            if !reply.isEmpty {
                messages.append(.assistant(reply))
                await emit(request.runID, "assistant_message", ["text": .string(reply)])
            }

            guard stop == .toolUse, !calls.isEmpty else {
                let outcome = stop == .maxTokens ? "truncated" : "succeeded"
                await finish(
                    request.runID,
                    outcome: outcome,
                    reason: stop == .maxTokens
                        ? "The model ran out of room before it finished."
                        : "Finished."
                )
                return
            }

            for call in calls {
                if Task.isCancelled { return }
                messages.append(.toolCall(id: call.id, name: call.name, input: call.input))
                let result = await perform(call, in: request, bindings: bindings)
                messages.append(
                    .toolResult(id: call.id, content: result.content, isError: result.isError)
                )
            }
        }

        await finish(
            request.runID,
            outcome: "truncated",
            reason: "This task reached the limit of \(Self.maximumTurns) steps and stopped."
        )
    }

    /// One gated tool call.
    ///
    /// Every failure comes back as a tool *result* rather than being thrown,
    /// because the model has to be told what happened in the only channel it
    /// reads. A refusal that unwound the loop would end the run without the model
    /// ever learning that the thing it asked for is not allowed — so it would ask
    /// for it again on the next run, and the person would refuse it again.
    private func perform(
        _ call: (id: String, name: String, input: JSONValue),
        in request: WorkRunRequest,
        bindings: [ToolBinding]
    ) async -> WorkToolResult {
        guard let binding = bindings.first(where: { $0.modelName == call.name }) else {
            let known = bindings.map(\.modelName).sorted().joined(separator: ", ")
            return WorkToolResult(
                content: "This Mac has no \"\(call.name)\" tool. It has: \(known).",
                isError: true
            )
        }
        let input = Self.toolValue(call.input)
        await emit(
            request.runID, "tool_started",
            ["tool": .string(call.name), "toolCallId": .string(call.id)]
        )
        do {
            let result = try await binding.registry.invoke(
                toolName: binding.toolName,
                input: input,
                runID: request.runID,
                toolCallID: call.id,
                approvals: request.approvals,
                emit: { [weak self] text in
                    await self?.emit(
                        request.runID, "step_started",
                        ["tool": .string(call.name), "text": .string(text)]
                    )
                }
            )
            await emit(
                request.runID, "tool_finished",
                [
                    "tool": .string(call.name),
                    "toolCallId": .string(call.id),
                    "isError": .bool(result.isError),
                    "detail": .object(result.detail.mapValues(DesktopWorkValueBridge.jsonValue)),
                ]
            )
            return result
        } catch let error as WorkToolError {
            let message = error.errorDescription ?? "Juno could not do that."
            if case .denied = error {
                await emit(
                    request.runID, "tool_denied",
                    ["tool": .string(call.name), "reason": .string(message)]
                )
            } else {
                await emit(
                    request.runID, "tool_finished",
                    [
                        "tool": .string(call.name),
                        "toolCallId": .string(call.id),
                        "isError": .bool(true),
                    ]
                )
            }
            return WorkToolResult(content: message, isError: true)
        } catch {
            let message = error.localizedDescription
            await emit(
                request.runID, "tool_finished",
                [
                    "tool": .string(call.name),
                    "toolCallId": .string(call.id),
                    "isError": .bool(true),
                ]
            )
            return WorkToolResult(content: message, isError: true)
        }
    }

    private func finish(_ runID: String, outcome: String, reason: String) async {
        await emit(
            runID, "run_finished",
            ["outcome": .string(outcome), "reason": .string(reason)]
        )
        await retire(runID)
    }

    /// Takes a run off the books.
    ///
    /// The approval coordinator is not swept here: `LocalWorkExecutor` denies a
    /// run's pending questions *before* it calls `stopRun`, deliberately, so that
    /// an approval tapped in the window between the two cannot authorise work
    /// nobody wants any more. Doing it again from here would be a second place
    /// with an opinion about that ordering.
    private func retire(_ runID: String) async {
        // Unpinned before anything else, and unpinned rather than left: a mode
        // keyed by run id on a Mac that stays signed in for weeks would only
        // ever accumulate, and a run id is never reused so nothing else can
        // read it again.
        await gates.removeValue(forKey: runID)?.clearRunPolicy(for: runID)
        runs.removeValue(forKey: runID)
        paused.remove(runID)
        resumeGates.removeValue(forKey: runID)?.resume()
        inbound.removeValue(forKey: runID)
        await flush(runID)
        outboxes.removeValue(forKey: runID)
        await dependencies.activityChanged(runs.count)
    }

    private func waitWhilePaused(_ runID: String) async {
        while paused.contains(runID), !Task.isCancelled {
            await withCheckedContinuation { continuation in
                // Re-checked inside the continuation: `resumeRun` may have landed
                // between the loop's test and this suspension, and a gate
                // installed after the resume that was meant to clear it is a run
                // parked for ever with nothing left to wake it.
                guard paused.contains(runID) else {
                    continuation.resume()
                    return
                }
                resumeGates[runID] = continuation
            }
        }
    }

    private func takeInbound(_ runID: String) -> [Said] {
        let queued = inbound[runID] ?? []
        inbound[runID] = []
        return queued
    }

    /// One thing the person has said, and how it reaches the model.
    ///
    /// The distinction is kept all the way down to the text because it changes
    /// the text. An answer is passed on as it was typed: the run asked, so the
    /// context is already in the transcript above it. An instruction is framed,
    /// because the transcript at that point is a goal, a plan and a run of tool
    /// results, and an unlabelled sentence dropped into it reads as one more
    /// tool result — or, worse, as the goal being restated.
    private enum Said: Sendable {
        case answer(String)
        case instruction(String)

        var modelText: String {
            switch self {
            case .answer(let text): text
            case .instruction(let text): DesktopWorkRunHost.framedInstruction(text)
            }
        }
    }

    /// The frame around an instruction, word for word what the cloud runner
    /// uses.
    ///
    /// Deliberately identical to `framedInstruction` in `scripts/work-runner.ts`
    /// rather than merely similar. The same task can run in the cloud on Monday
    /// and on this Mac on Tuesday, and a model told its correction "wins where
    /// the two disagree" in one place and something looser in the other would
    /// obey the same sentence differently depending on where the run landed —
    /// which is the one thing about steering nobody could debug from the outside.
    ///
    /// "After the task started" rather than "while you were working", because
    /// both are read by the same prompt: an instruction added while a run sat
    /// queued is delivered on its first turn, and telling the model it
    /// interrupted work that had not begun is the sort of small false note it
    /// then reasons from.
    private static func framedInstruction(_ instruction: String) -> String {
        [
            "The user added this after the task started. It comes after the goal and wins where the two",
            "disagree. Carry on from where you are rather than starting again.",
            "",
            instruction,
        ].joined(separator: "\n")
    }

    // MARK: - Reporting

    /// One run's unsent events.
    private struct Outbox {
        var nextSeq = 1
        var acceptedThrough = 0
        var buffered: [WorkRunEvent] = []
    }

    private func emit(
        _ runID: String,
        _ kind: String,
        _ payload: [String: JunoJSONValue] = [:]
    ) async {
        guard var box = outboxes[runID] else { return }
        let event = WorkRunEvent(
            seq: box.nextSeq,
            kind: kind,
            payload: payload,
            // Keyed on the producer sequence, which is unique per run and stable
            // across a re-send. That is what lets the relay recognise a batch it
            // has already stored instead of appending the same minute of the
            // transcript twice.
            eventKey: "\(runID).\(box.nextSeq)"
        )
        box.nextSeq += 1
        box.buffered.append(event)
        if box.buffered.count > Self.maximumBufferedEvents {
            // The relay has been unreachable long enough that holding the rest
            // would cost more than losing it. The oldest go, and the accepted
            // cursor moves past them so the next batch is contiguous — this
            // states plainly that the dropped span is gone rather than leaving a
            // hole the relay would keep asking to have filled for ever.
            let overflow = box.buffered.count - Self.maximumBufferedEvents
            box.acceptedThrough = box.buffered[overflow - 1].seq
            box.buffered.removeFirst(overflow)
        }
        outboxes[runID] = box
        await flush(runID)
    }

    private func flush(_ runID: String) async {
        guard let box = outboxes[runID], !box.buffered.isEmpty else { return }
        let batch = Array(box.buffered.prefix(NativeWorkClient.maximumOutboxBatch))
        let afterSeq = box.acceptedThrough
        do {
            let receipt = try await dependencies.reporter.appendRunEvents(
                hostID: dependencies.hostID,
                runID: runID,
                afterSeq: afterSeq,
                events: batch,
                for: dependencies.accountID
            )
            // Re-read across the await: the loop kept running while this request
            // was in flight, so the buffer this returns to is not the one it left.
            guard var current = outboxes[runID] else { return }
            // A gap means the relay truncated the batch there. Rewinding to just
            // before it is what makes the next drain re-send the missing event
            // rather than the whole buffer.
            current.acceptedThrough = receipt.firstGap.map { $0 - 1 } ?? receipt.acceptedThrough
            current.buffered.removeAll { $0.seq <= current.acceptedThrough }
            outboxes[runID] = current
        } catch {
            // Left buffered on purpose. The next emit tries again, and a run that
            // finishes while the relay is down drains on `retire`; anything more
            // eager here would retry inside a loop that is already retrying.
        }
    }

    // MARK: - Tools

    /// One model-facing tool name, and what it actually runs.
    private struct ToolBinding: Sendable {
        let modelName: String
        let toolName: String
        let registry: WorkToolRegistry
        let descriptor: ModelToolDescriptor
    }

    /// Builds the run's tool table from its grants.
    ///
    /// A run may hold several folders, and every folder's registry offers the
    /// same six tool names — so with more than one grant the names are qualified
    /// by the folder they act in. Unqualified when there is exactly one, because
    /// a prefix nobody needs is a prefix a model gets wrong.
    ///
    /// Only the folder's own name reaches the model, never its path. It already
    /// knows the name — it is the folder it was asked to work in — and the path
    /// is what names the person and their disk layout.
    private static func bindings(
        for request: WorkRunRequest,
        automationTools: [any WorkTool]
    ) -> [ToolBinding] {
        var bindings: [ToolBinding] = []
        var usedPrefixes: Set<String> = []
        let qualifies = request.grants.count > 1

        for runtime in request.grants {
            var prefix = ""
            if qualifies {
                let base = slug(runtime.access.rootURL.lastPathComponent)
                var candidate = base
                var ordinal = 2
                while !usedPrefixes.insert(candidate).inserted {
                    candidate = "\(base)_\(ordinal)"
                    ordinal += 1
                }
                prefix = candidate + "_"
            }
            for tool in runtime.tools.allTools {
                bindings.append(
                    ToolBinding(
                        modelName: prefix + tool.name,
                        toolName: tool.name,
                        registry: runtime.tools,
                        descriptor: descriptor(for: tool, modelName: prefix + tool.name)
                    )
                )
            }
        }

        guard !automationTools.isEmpty else { return bindings }
        // Unqualified, and never per grant: driving an app is not something that
        // happens *inside* a folder, so a copy of `app_control` per shared folder
        // would offer the model three names for one capability.
        let registry = WorkToolRegistry.automation(tools: automationTools)
        for tool in registry.allTools {
            bindings.append(
                ToolBinding(
                    modelName: tool.name,
                    toolName: tool.name,
                    registry: registry,
                    descriptor: descriptor(for: tool, modelName: tool.name)
                )
            )
        }
        return bindings
    }

    private static func descriptor(
        for tool: any WorkTool, modelName: String
    ) -> ModelToolDescriptor {
        ModelToolDescriptor(
            name: modelName,
            description: tool.description,
            inputSchema: jsonValue(tool.schema.jsonSchema)
        )
    }

    /// Lower-cased, non-identifier characters folded to underscores.
    ///
    /// Tool names travel to providers that accept `[a-zA-Z0-9_-]` and refuse the
    /// whole request otherwise, so a folder called "Q4 — final" must not be able
    /// to fail every turn of a run by being the name it is.
    private static func slug(_ name: String) -> String {
        let folded = name.lowercased().map { character -> Character in
            character.isLetter || character.isNumber ? character : "_"
        }
        let trimmed = String(folded).trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return trimmed.isEmpty ? "folder" : String(trimmed.prefix(24))
    }

    private static func systemPrompt(
        for request: WorkRunRequest, bindings: [ToolBinding]
    ) -> String {
        var lines = [
            "You are Juno, working on somebody's own Mac on a task they asked for.",
            "You can only reach what they have shared with you. Nothing else on this Mac exists to you.",
        ]
        if request.grants.isEmpty {
            lines.append("No folder has been shared with you for this task.")
        } else {
            let names = request.grants.map { $0.access.rootURL.lastPathComponent }
            lines.append(
                "Folders shared with you: " + names.joined(separator: ", ") + "."
            )
            if request.grants.count > 1 {
                lines.append(
                    "Each folder has its own copy of the file tools, named after that folder."
                )
            }
        }
        lines.append(
            "Some actions stop and ask the person before they happen. A refusal is their answer, "
                + "not an error to work around: say what you were refused and stop."
        )
        lines.append("Say what you did in plain language. Never print a full filesystem path.")
        lines.append("When the task is done, reply without calling a tool.")
        return lines.joined(separator: "\n")
    }

    private static func goal(in payload: [String: WorkToolValue]) -> String? {
        payload["goal"]?.stringValue ?? payload["prompt"]?.stringValue
    }

    /// The approval mode the instruction asked for, or the strictest one.
    ///
    /// `conservative` — Manual — for a missing key, an unreadable value, or a
    /// word this build does not know, and all three for the same reason the
    /// server's own serialiser gives: never widen on a parse. Silence here is a
    /// relay or a deployment that predates the key, and reading it as "whatever
    /// this Mac's switch happens to say" would mean the one case where nobody
    /// stated a mode is the case where the widest one applies.
    ///
    /// The cost of being wrong this way is a run that asks more often than it
    /// needed to, which the person can answer; the cost of the other way is a
    /// run that changed a file it should have asked about first.
    private static func permissionPolicy(
        in payload: [String: WorkToolValue]
    ) -> WorkPermissionPolicy {
        guard let raw = payload["permissionPolicy"]?.stringValue,
            let policy = WorkPermissionPolicy(rawValue: raw)
        else { return .conservative }
        return policy
    }

    // MARK: - The third JSON tree

    /// `JunoCodeCore.JSONValue` is the model transport's tree, and
    /// `WorkToolValue` is the tool layer's. Same shape, different packages, and
    /// for the same reason — neither may depend on the other. Both directions
    /// are total, because an argument silently flattened on the way in is an
    /// approval digest computed over something the tool never received.
    private static func toolValue(_ value: JSONValue) -> WorkToolValue {
        switch value {
        case .null: .null
        case .bool(let flag): .bool(flag)
        case .number(let number): .number(number)
        case .string(let text): .string(text)
        case .array(let items): .array(items.map(toolValue))
        case .object(let fields): .object(fields.mapValues(toolValue))
        }
    }

    private static func jsonValue(_ value: WorkToolValue) -> JSONValue {
        switch value {
        case .null: .null
        case .bool(let flag): .bool(flag)
        case .number(let number): .number(number)
        case .string(let text): .string(text)
        case .array(let items): .array(items.map(jsonValue))
        case .object(let fields): .object(fields.mapValues(jsonValue))
        }
    }
}

/// Why this Mac would not drive a run.
///
/// Sentences rather than codes because they travel back through the command
/// acknowledgement and are shown to whoever dispatched the task.
enum DesktopWorkRunError: Error, LocalizedError, Equatable {
    case alreadyRunning
    case noGoal
    case nothingGranted
    case notLive

    var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            "This Mac is already running that task."
        case .noGoal:
            "That task arrived without anything to do, so this Mac did not start it."
        case .nothingGranted:
            "Nothing has been shared with Juno Work on this Mac yet, so there is nothing a task can use."
        case .notLive:
            "That task is not running on this Mac."
        }
    }
}
