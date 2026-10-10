import Foundation
import JunoCodeCore

/// A Plan → Build → Verify team on the Mac engine (team lane; the same run
/// as the cloud runner's `SubagentManager.runTeam` in agent-core).
///
/// With a `plan-build-verify` routing the orchestrator runs this before the
/// lead's own loop: the Architect plans on its model, one Builder per routing
/// worker implements a part of the plan in its own worktree on its model, and
/// the Verifier reviews and tests the result on its model. Each phase is one
/// `delegate_task` call, so children keep their own sessions, show in the
/// thread's agent tree ("Architect · Plan", "Builder 1 · …", "Verifier ·
/// Verify") and are charged to the run's shared budget. The budget is checked
/// before every phase; once it is spent, no later phase starts.
public struct TeamPipeline: Sendable {
    public let routing: CodeV2.RoleRouting

    /// Nil unless the routing is a Plan → Build → Verify team.
    public init?(routing: CodeV2.RoleRouting?) {
        guard let routing, routing.preset == .planBuildVerify else { return nil }
        self.routing = routing
    }

    public var builderCount: Int { max(1, routing.workers?.count ?? 1) }

    public struct Part: Equatable, Sendable {
        public let title: String
        public let prompt: String
    }

    public struct PhaseResult: Sendable {
        public let phase: CodeV2.TeamPhase
        public let report: String
        public let failed: Bool
    }

    public enum StopReason: String, Sendable {
        case budget
        case cannotWrite = "cannot-write"
    }

    public struct Run: Sendable {
        public var plan: String?
        public var parts: [Part] = []
        public var phases: [PhaseResult] = []
        public var stopReason: StopReason?
        public var stopNote: String?
    }

    /// Runs the three phases in order. `tool` is read for the budget and
    /// whether builders can write; every phase is dispatched through `invoke`,
    /// which the orchestrator binds to the registry's full `invoke` (schema,
    /// permission and approval), so a team phase is gated like any other
    /// `delegate_task`. Throws on cancellation (Stop) or a refused phase,
    /// which the orchestrator reports by letting the lead run alone.
    public func run(
        prompt: String,
        tool: DelegateTaskTool,
        sessionID: CodeSessionID,
        callPrefix: String,
        invoke: @Sendable (JSONValue, ToolContext) async throws -> ToolResult
    ) async throws -> Run {
        var run = Run()
        func spent() async -> Bool {
            guard let reason = await tool.runBudget?.exhaustedReason else { return false }
            run.stopReason = .budget
            run.stopNote = reason
            return true
        }
        func context(_ phase: CodeV2.TeamPhase) -> ToolContext {
            ToolContext(sessionID: sessionID, toolCallID: "\(callPrefix)-\(phase.rawValue)", emitOutput: { _, _ in })
        }

        // 1. Plan.
        if await spent() { return run }
        let planned = try await invoke(
            [
                "task": .string(Self.architectPrompt(prompt, builders: builderCount)),
                "agent": "architect",
                "title": "Architect · Plan",
            ],
            context(.plan)
        )
        try Task.checkCancellation()
        let answer = Self.answer(of: planned.content)
        run.phases.append(PhaseResult(phase: .plan, report: answer, failed: planned.isError))
        let parsed = Self.parsePlan(answer, builders: builderCount)
        run.plan = parsed.plan
        run.parts = parsed.parts
        if await spent() { return run }

        // 2. Build, each part in its own worktree.
        guard tool.canWrite else {
            run.stopReason = .cannotWrite
            run.stopNote = "Builders need an isolated worktree, which this workspace cannot make. Build the plan yourself, then check it."
            return run
        }
        let tasks: [JSONValue] = parsed.parts.enumerated().map { index, part in
            [
                "task": .string(Self.builderPrompt(prompt, plan: parsed.plan, part: part)),
                "title": .string((parsed.parts.count > 1 ? "Builder \(index + 1) · " : "Builder · ") + part.title),
                "mode": .string(SubagentExecutionMode.workspaceWrite.rawValue),
                "team_ordinal": .number(Double(index)),
            ]
        }
        let built = try await invoke(["tasks": .array(tasks)], context(.build))
        try Task.checkCancellation()
        run.phases.append(PhaseResult(phase: .build, report: built.content, failed: built.isError))
        if await spent() { return run }

        // 3. Verify.
        let verified = try await invoke(
            [
                "task": .string(Self.verifierPrompt(prompt, plan: parsed.plan, built: built.content)),
                "agent": "verifier",
                "title": "Verifier · Verify",
            ],
            context(.verify)
        )
        try Task.checkCancellation()
        run.phases.append(PhaseResult(phase: .verify, report: Self.answer(of: verified.content), failed: verified.isError))
        _ = await spent()
        return run
    }

    // MARK: Prompts

    static func architectPrompt(_ request: String, builders: Int) -> String {
        """
        You plan for a team: \(builders) builder\(builders == 1 ? "" : "s") will implement your plan in parallel, then a verifier checks the result.

        Read enough of the project to plan well, then answer with ONE JSON object and nothing else:
        {"plan": "<the structure and approach: the files, the interfaces, the order>", "tasks": [{"title": "<short imperative title>", "prompt": "<everything one builder needs>"}]}
        Give at most \(builders) task\(builders == 1 ? "" : "s"), independent enough to build in parallel without touching the same lines.

        <request>
        \(request)
        </request>
        """
    }

    static func builderPrompt(_ request: String, plan: String, part: Part) -> String {
        """
        You are a builder on a team. The architect planned the work; implement your part completely, and check it builds or passes its tests where you can. Other builders are doing the other parts in parallel, so change only what your part needs.

        <request>
        \(request)
        </request>

        <plan>
        \(plan)
        </plan>

        <your_part title="\(part.title)">
        \(part.prompt)
        </your_part>
        """
    }

    static func verifierPrompt(_ request: String, plan: String, built: String) -> String {
        """
        You verify a team's work. The architect planned and the builders implemented, each on its own worktree branch (their reports below name them). Review and test the result: read the changes, run the checks you can, and decide whether the request is met. Report each requirement as met, not met or failing, with the evidence. End with one line: "Verdict: pass" or "Verdict: needs work".

        <request>
        \(request)
        </request>

        <plan>
        \(plan)
        </plan>

        <builders>
        \(String(built.prefix(12_000)))
        </builders>
        """
    }

    // MARK: Parsing

    /// The text after `delegate_task`'s one-line headline.
    static func answer(of content: String) -> String {
        guard let range = content.range(of: "\n\n") else { return content }
        return String(content[range.upperBound...])
    }

    /// The Architect's JSON plan, or one part carrying its whole answer.
    /// More parts than builders fold round-robin, so every part is built.
    public static func parsePlan(_ text: String, builders: Int) -> (plan: String, parts: [Part]) {
        let object = jsonObject(in: text)
        let plan = (object?["plan"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
            ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
        var parts: [Part] = ((object?["tasks"] as? [Any]) ?? []).enumerated().compactMap { index, raw in
            guard let entry = raw as? [String: Any],
                  let prompt = (entry["prompt"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty
            else { return nil }
            let title = (entry["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return Part(title: String((title?.isEmpty == false ? title! : "Part \(index + 1)").prefix(80)), prompt: prompt)
        }
        if parts.isEmpty { parts = [Part(title: "Implement the plan", prompt: plan)] }
        let n = max(1, builders)
        if parts.count > n {
            var merged = Array(parts.prefix(n))
            for (index, extra) in parts.dropFirst(n).enumerated() {
                let into = merged[index % n]
                merged[index % n] = Part(title: into.title, prompt: into.prompt + "\n\nAlso: \(extra.title)\n\(extra.prompt)")
            }
            parts = merged
        }
        return (plan, parts)
    }

    private static func jsonObject(in text: String) -> [String: Any]? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end else { return nil }
        let data = Data(text[start...end].utf8)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: The lead's brief

    /// What the lead reads after the team ran, folded into the turn's message.
    public static func report(_ run: Run) -> String {
        var lines = ["<team_run preset=\"plan-build-verify\">"]
        if let plan = run.plan { lines.append("<plan>\n\(String(plan.prefix(6_000)))\n</plan>") }
        for phase in run.phases {
            lines.append("<phase name=\"\(phase.phase.rawValue)\"\(phase.failed ? " failed=\"true\"" : "")>\n\(String(phase.report.prefix(8_000)))\n</phase>")
        }
        if let reason = run.stopReason {
            lines.append("<stopped reason=\"\(reason.rawValue)\">\(run.stopNote ?? "")</stopped>")
        }
        lines.append("</team_run>")
        switch run.stopReason {
        case .budget?:
            lines.append("The run's budget stopped the team. Do not continue the work: tell the person in two sentences which phases finished and that raising the budget in Team lets it carry on.")
        case .cannotWrite?:
            lines.append("The team could only plan. Carry out the plan yourself, then check it and summarise for the person.")
        case nil:
            lines.append("Your team has finished: the architect planned, the builders implemented on their worktree branches and the verifier checked. Read the verifier's verdict, fix anything small yourself, then tell the person what was built, by whom, and what was verified, and that the builders' changes are ready to review and apply.")
        }
        return lines.joined(separator: "\n")
    }
}
