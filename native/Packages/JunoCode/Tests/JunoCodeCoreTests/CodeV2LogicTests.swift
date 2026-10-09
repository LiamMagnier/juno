import Foundation
import XCTest
@testable import JunoCodeCore

/// The Code v2 logic the Mac Studio draws from: context tiers and prices,
/// composer decisions, role drafts, the provider directory, the session
/// reducer, turn folding and unified diffs (Code v2 DESIGN §5, SPEC §3–§4).
final class CodeV2LogicTests: XCTestCase {
    // MARK: Fixtures

    private let standard = CodeV2.ContextTier(tokens: 272_000, label: "272K", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2)
    private let long = CodeV2.ContextTier(tokens: 1_000_000, label: "1M", inputPerMTok: 4, outputPerMTok: 15, cachedInputPerMTok: 0.4)

    private func at(_ seconds: Int) -> String {
        CodeV2Dates.string(Date(timeIntervalSince1970: 1_800_000_000 + TimeInterval(seconds)))
    }

    private let selection = CodeV2.ModelSelection(instanceId: "alevr", model: "openai:gpt-6.1", effort: .high, contextTokens: 272_000)

    // MARK: Context math

    func testContextLabelsMatchTheWeb() {
        XCTAssertEqual(CodeV2ContextMath.label(tokens: 272_000), "272K")
        XCTAssertEqual(CodeV2ContextMath.label(tokens: 1_000_000), "1M")
        XCTAssertEqual(CodeV2ContextMath.label(tokens: 1_048_576), "1M")
        XCTAssertEqual(CodeV2ContextMath.label(tokens: 262_144), "256K")
        XCTAssertEqual(CodeV2ContextMath.label(tokens: 1_050_000), "1.05M")
        XCTAssertEqual(CodeV2ContextMath.compactCount(184_400), "184K")
        XCTAssertEqual(CodeV2ContextMath.compactCount(1_240_000), "1.2M")
        XCTAssertEqual(CodeV2ContextMath.dollars(0.15), "$0.15")
        XCTAssertEqual(CodeV2ContextMath.estimate(0.001), "< $0.01")
        XCTAssertEqual(CodeV2ContextMath.estimate(0.37), "≈ $0.37")
    }

    func testAutoCompactThresholdIsTheSpecFormula() {
        // floor(min(0.8·W, W − O − 65536)) with O = 32K.
        XCTAssertEqual(CodeV2ContextMath.autoCompactThreshold(window: 272_000), 174_464)
        XCTAssertEqual(CodeV2ContextMath.autoCompactThreshold(window: 1_000_000), 800_000)
        // Never below a quarter of a tiny window.
        XCTAssertEqual(CodeV2ContextMath.autoCompactThreshold(window: 64_000), 16_000)
        XCTAssertEqual(CodeV2ContextMath.autoCompactThreshold(window: 0), 0)
    }

    func testEstimateBillsTheBandThePromptFallsIn() throws {
        // 100K of a thread sent on the 1M tier is billed at the 272K rates.
        let cost = try XCTUnwrap(CodeV2ContextMath.estimateCost(threadTokens: 100_000, tier: long, tiers: [standard, long], outputTokens: 2_000))
        XCTAssertEqual(cost, 0.22, accuracy: 0.0001)
        // Past 272K it is the long rate.
        let longCost = try XCTUnwrap(CodeV2ContextMath.estimateCost(threadTokens: 400_000, tier: long, tiers: [standard, long]))
        XCTAssertEqual(longCost, 1.6, accuracy: 0.0001)
        // A thread larger than the window does not fit.
        XCTAssertNil(CodeV2ContextMath.estimateCost(threadTokens: 300_000, tier: standard))
        // Cached input bills at the cached rate.
        let cached = try XCTUnwrap(CodeV2ContextMath.estimateCost(threadTokens: 100_000, tier: standard, cachedInputTokens: 100_000))
        XCTAssertEqual(cached, 0.02, accuracy: 0.0001)
    }

    func testTierChoicesCarryPricesDeltasAndLean() throws {
        let rows = CodeV2TierChoice.choices(tiers: [long, standard], threadTokens: 184_000)
        XCTAssertEqual(rows.map(\.kind), [.standard, .long, .lean])
        XCTAssertEqual(rows[0].name, "Standard")
        XCTAssertEqual(rows[0].priceLine, "$2.00 in · $10.00 out per million tokens")
        XCTAssertEqual(rows[0].deltaLine, "Compacts at 174K.")
        XCTAssertTrue(rows[0].compactsNow == true)
        XCTAssertEqual(rows[1].priceLine, "Same rates up to 272K, then $4.00 in · $15.00 out")
        XCTAssertNotNil(rows[1].deltaLine)
        XCTAssertFalse(rows[1].compactsNow)
        XCTAssertEqual(rows[2].windowTokens, CodeV2ContextMath.leanWindow)
        XCTAssertTrue(rows[2].compactsNow)
        // Subscriptions print no dollars.
        let plan = CodeV2TierChoice.choices(tiers: [standard], threadTokens: 10_000, billsInDollars: false)
        XCTAssertNil(plan.first?.nextTurnEstimate)
        XCTAssertTrue(plan.allSatisfy { $0.kind != .lean } || CodeV2ContextMath.offersLean([standard]))
    }

    func testLeanIsOfferedOnlyAboveTheFloor() {
        XCTAssertTrue(CodeV2ContextMath.offersLean([standard]))
        XCTAssertFalse(CodeV2ContextMath.offersLean([CodeV2.ContextTier(tokens: 200_000, label: "200K", inputPerMTok: 3, outputPerMTok: 15)]))
    }

    func testPressureTurnsAtEightyPercentOfTheThreshold() {
        let threshold = CodeV2ContextMath.autoCompactThreshold(window: 272_000)
        XCTAssertLessThan(CodeV2ContextMath.pressure(used: threshold / 2, window: 272_000), CodeV2ContextMath.warningPressure)
        XCTAssertGreaterThan(CodeV2ContextMath.pressure(used: threshold * 9 / 10, window: 272_000), CodeV2ContextMath.warningPressure)
    }

    // MARK: Composer

    func testSubmissionLanes() {
        typealias L = CodeV2ComposerLogic
        XCTAssertEqual(L.submission(command: false, shift: false, option: false, isRunning: false, canSteer: true, draftIsEmpty: false), .send)
        XCTAssertEqual(L.submission(command: false, shift: false, option: false, isRunning: true, canSteer: true, draftIsEmpty: false), .queue)
        XCTAssertEqual(L.submission(command: true, shift: false, option: false, isRunning: true, canSteer: true, draftIsEmpty: false), .steer)
        XCTAssertEqual(L.submission(command: true, shift: false, option: false, isRunning: true, canSteer: false, draftIsEmpty: false), .queue)
        XCTAssertEqual(L.submission(command: false, shift: true, option: false, isRunning: false, canSteer: true, draftIsEmpty: false), .ignore)
        XCTAssertEqual(L.submission(command: false, shift: false, option: false, isRunning: false, canSteer: true, draftIsEmpty: true), .ignore)
    }

    func testPrimaryButtonBecomesStopOnlyWhenRunningWithAnEmptyDraft() {
        XCTAssertEqual(CodeV2ComposerLogic.primaryButton(isRunning: true, draft: "  "), .stop)
        XCTAssertNotEqual(CodeV2ComposerLogic.primaryButton(isRunning: true, draft: "also fix the test"), .stop)
        XCTAssertEqual(CodeV2ComposerLogic.primaryButton(isRunning: false, draft: ""), .send(enabled: false))
        XCTAssertEqual(CodeV2ComposerLogic.primaryButton(isRunning: false, draft: "go"), .send(enabled: true))
    }

    func testToneFollowsTheSessionState() {
        XCTAssertEqual(CodeV2ComposerLogic.tone(state: .running, hasPendingRequest: false), .working)
        XCTAssertEqual(CodeV2ComposerLogic.tone(state: .running, hasPendingRequest: true), .needsYou)
        XCTAssertEqual(CodeV2ComposerLogic.tone(state: .limited, hasPendingRequest: false), .limited)
        XCTAssertEqual(CodeV2ComposerLogic.tone(state: .idle, hasPendingRequest: false), .idle)
    }

    func testDoubleEscapeFiresWithinTheWindowOnly() {
        var escape = CodeV2DoubleEscape()
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(escape.press(at: start), .armed)
        XCTAssertEqual(escape.press(at: start.addingTimeInterval(0.4)), .fire)
        XCTAssertEqual(escape.press(at: start.addingTimeInterval(1)), .armed)
        XCTAssertEqual(escape.press(at: start.addingTimeInterval(1.7)), .armed)
    }

    func testQueueDockShowsThreeThenACount() {
        let items = (0..<5).map { CodeV2.QueuedInput(id: "q\($0)", input: CodeV2.UserInput(text: "item \($0)"), queuedAt: at($0)) }
        let dock = CodeV2QueueDockModel(items: items)
        XCTAssertEqual(dock.visible.count, 3)
        XCTAssertEqual(dock.overflowLabel, "+2 more")
        XCTAssertEqual(dock.lastEditable?.id, "q4")
        XCTAssertEqual(CodeV2QueueDockModel.moving(items, from: 0, to: 2).map(\.id).prefix(3), ["q1", "q2", "q0"])
    }

    func testTraitsLabelAndEffortCycling() {
        XCTAssertEqual(CodeV2Traits.label(effort: .high, contextTokens: 1_000_000, fast: false), "High · 1M")
        XCTAssertEqual(CodeV2Traits.label(effort: .high, contextTokens: 1_000_000, fast: true), "High · 1M · Fast")
        XCTAssertEqual(CodeV2Traits.label(effort: .medium, contextTokens: 1_000_000, fast: false, lean: true), "Medium · 128K")
        XCTAssertEqual(CodeV2Traits.label(effort: nil, contextTokens: nil, fast: false), "Default")
        XCTAssertEqual(CodeV2.EffortLevel.cycled(from: .high, in: [.low, .medium, .high]), .low)
        XCTAssertEqual(CodeV2.EffortLevel.cycled(from: nil, in: [.low, .medium]), .low)
    }

    // MARK: Orchestration

    func testRoleDraftRoutingPerPreset() {
        var draft = CodeV2RoleDraft(lead: selection)
        XCTAssertEqual(draft.label, "Solo")
        XCTAssertEqual(draft.routing.preset, .solo)
        XCTAssertNil(draft.routing.workers)

        draft.preset = .leadWorkers
        draft.setWorkers(9)
        XCTAssertEqual(draft.workerCount, 6)
        XCTAssertEqual(draft.label, "Lead + 6")
        XCTAssertEqual(draft.routing.workers?.count, 6)

        draft.preset = .bestOfN
        draft.setCandidateCount(1)
        XCTAssertEqual(draft.candidates.count, 2)
        draft.setCandidateCount(4)
        XCTAssertEqual(draft.label, "Best of 4")
        XCTAssertEqual(draft.routing.workers?.count, 4)
        XCTAssertEqual(draft.routing.budget?.maxUsd, CodeV2RoleDraft.defaultBudgetUsd)

        let back = CodeV2RoleDraft(routing: draft.routing)
        XCTAssertEqual(back.preset, .bestOfN)
        XCTAssertEqual(back.candidates.count, 4)
    }

    func testRunEstimateSkipsSubscriptionRoles() {
        var draft = CodeV2RoleDraft(preset: .leadWorkers, lead: selection, workerCount: 2)
        draft.worker = CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5")
        let dollars = CodeV2RunEstimate.dollars(
            for: draft,
            rate: { _ in self.standard },
            billsInDollars: { CodeV2.instanceKind(of: $0.instanceId).map(CodeV2ProviderDirectory.billsInDollars) ?? true }
        )
        // Lead only: 160K × $2 + 8K × $10 per million.
        XCTAssertEqual(dollars, 0.40, accuracy: 0.0001)
        XCTAssertEqual(
            CodeV2RunEstimate.subscriptionNote(vendorNames: ["Claude", "ChatGPT", "Claude"]),
            "Subscription roles count against your Claude and ChatGPT plans, not this budget."
        )
        XCTAssertNil(CodeV2RunEstimate.subscriptionNote(vendorNames: []))
    }

    // MARK: Provider directory

    func testInstanceKindsRouteToTheRightEngine() {
        XCTAssertEqual(CodeV2.instanceKind(of: "alevr"), .alevr)
        XCTAssertEqual(CodeV2.instanceKind(of: "claude-agent:default"), .claudeAgent)
        XCTAssertEqual(CodeV2.instanceKind(of: "codex:work"), .codex)
        XCTAssertEqual(CodeV2.instanceKind(of: "acp:gemini"), .acp)
        XCTAssertEqual(CodeV2.instanceKind(of: "byok:anthropic"), .byok)
        XCTAssertTrue(CodeV2.runsOnEnvServer(.claudeAgent))
        XCTAssertTrue(CodeV2.runsOnEnvServer(.acp))
        XCTAssertFalse(CodeV2.runsOnEnvServer(.alevr))
        XCTAssertFalse(CodeV2.runsOnEnvServer(.byok))
    }

    func testDirectoryOrdersTheRailAndHidesAntigravity() {
        let alevr = CodeV2.ProviderInstance(id: "alevr", kind: .alevr, label: "Alevr", status: .ready)
        let claude = CodeV2.ProviderInstance(
            id: "claude-agent:default", kind: .claudeAgent, label: "Claude (your subscription)",
            binaryPath: "/usr/local/bin/claude", account: CodeV2.ProviderAccount(email: "maya@example.com", plan: "max"),
            status: .ready, version: "2.1.0",
            limits: [CodeV2.UsageWindow(id: "5h", label: "5-hour", usedPct: 38)]
        )
        let directory = CodeV2ProviderDirectory.build(alevr: alevr, envInstances: [claude], byokKeys: [.anthropic])
        XCTAssertFalse(directory.instances.contains { $0.id == "acp:antigravity" })
        let rail = directory.rail.map(\.id)
        XCTAssertEqual(rail.first, "alevr")
        XCTAssertEqual(rail[1], "claude-agent:default")
        XCTAssertEqual(rail.last, "byok:anthropic")
        XCTAssertEqual(directory.neighbour(of: "alevr", step: -1)?.id, "byok:anthropic")

        XCTAssertEqual(
            CodeV2ProviderDirectory.statusSentence(claude),
            "Your own claude, version 2.1.0. Signed in as maya@example.com, Max plan."
        )
        XCTAssertEqual(CodeV2ProviderDirectory.tooltip(claude), "Claude (your subscription): Max plan, 5-hour window 38% used")
        XCTAssertTrue(CodeV2ProviderDirectory.headerSentence(claude).hasPrefix("Runs your own claude on this Mac."))
        XCTAssertEqual(
            CodeV2ProviderDirectory.headerSentence(directory.instance("byok:anthropic")!),
            "Your Anthropic key. Billed by Anthropic, not Alevr."
        )

        let withGate = CodeV2ProviderDirectory.build(alevr: alevr, envInstances: nil, antigravityEnabled: true)
        XCTAssertEqual(withGate.instance("acp:antigravity")?.status, .notInstalled)
    }

    func testKnownSubscriptionsNeverCallClaudeOurs() {
        XCTAssertEqual(CodeV2KnownSubscription.claude.displayName, "Claude (your subscription)")
        XCTAssertEqual(CodeV2KnownSubscription.claude.fallbackStep(.login)?.command, "claude auth login")
        XCTAssertEqual(CodeV2KnownSubscription.codex.fallbackStep(.login)?.command, "codex login")
        XCTAssertNil(CodeV2KnownSubscription.grok.fallbackStep(.install))
        for known in CodeV2KnownSubscription.allCases {
            XCTAssertFalse(known.displayName.contains("Claude Code"))
        }
    }

    func testMaskedKeysShowOnlyThePrefixAndTheLastFour() {
        XCTAssertEqual(CodeV2.ByokProvider.maskedKey("sk-ant-api03-abcdefghijklmnop4f2a"), "sk-ant-…4f2a")
        XCTAssertEqual(CodeV2.ByokProvider.maskedKey("short"), "…")
    }

    // MARK: Reducer

    func testReducerAppliesInOrderAndAsksToReopenOnAGap() {
        var state = CodeV2SessionState(snapshot: CodeV2.SessionSnapshot(id: "s1", cwd: "/tmp", selection: selection))
        let snapshot = CodeV2.ServerEventEnvelope(sessionId: "s1", sequence: 4, at: at(0), event: .sessionSnapshot(
            snapshotSequence: 4, session: CodeV2.SessionSnapshot(id: "s1", cwd: "/tmp", selection: selection)
        ))
        XCTAssertEqual(CodeV2SessionReducer.apply(snapshot, to: &state), .none)
        XCTAssertEqual(state.cursor, 4)

        let started = CodeV2.ServerEventEnvelope(sessionId: "s1", sequence: 5, at: at(1), event: .turnStarted(turnId: "t1", selection: selection))
        CodeV2SessionReducer.apply(started, to: &state)
        XCTAssertEqual(state.snapshot.state, .running)

        let message = CodeV2.TurnItem.assistantMessage(CodeV2.AssistantMessage(id: "a1", turnId: "t1", createdAt: at(2), text: "Hel", streaming: true))
        CodeV2SessionReducer.apply(.init(sessionId: "s1", sequence: 6, at: at(2), event: .itemAdded(message)), to: &state)
        CodeV2SessionReducer.apply(.init(sessionId: "s1", sequence: 7, at: at(3), event: .itemDelta(itemId: "a1", field: "text", append: "lo")), to: &state)
        // A duplicate is ignored.
        CodeV2SessionReducer.apply(.init(sessionId: "s1", sequence: 7, at: at(3), event: .itemDelta(itemId: "a1", field: "text", append: "lo")), to: &state)
        guard case let .assistantMessage(text)? = state.item("a1") else { return XCTFail("missing message") }
        XCTAssertEqual(text.text, "Hello")

        // A gap asks for a re-open from the cursor and applies nothing.
        let effect = CodeV2SessionReducer.apply(.init(sessionId: "s1", sequence: 10, at: at(4), event: .turnCompleted(turnId: "t1", outcome: .completed, usage: nil)), to: &state)
        XCTAssertEqual(effect, .reopen(afterSequence: 7))
        XCTAssertEqual(state.snapshot.state, .running)

        CodeV2SessionReducer.apply(.init(sessionId: "s1", sequence: 8, at: at(5), event: .turnCompleted(turnId: "t1", outcome: .completed, usage: nil)), to: &state)
        XCTAssertEqual(state.snapshot.state, .idle)
        guard case let .assistantMessage(settled)? = state.item("a1") else { return XCTFail("missing message") }
        XCTAssertFalse(settled.streaming)
    }

    func testAPendingApprovalPutsTheSessionInWaiting() {
        var state = CodeV2SessionState(snapshot: CodeV2.SessionSnapshot(id: "s1", cwd: "/tmp", selection: selection, state: .running, activeTurnId: "t1"), cursor: 0)
        let pending = CodeV2.ApprovalRequest(id: "ap1", turnId: "t1", createdAt: at(0), callId: "c1", requestId: "r1", action: .command, summary: "pnpm test", status: .pending)
        CodeV2SessionReducer.reduce(.itemAdded(.approvalRequest(pending)), into: &state)
        XCTAssertEqual(state.snapshot.state, .waiting)
        var resolved = pending
        resolved.status = .resolved
        resolved.decision = .accept
        CodeV2SessionReducer.reduce(.itemUpdated(.approvalRequest(resolved)), into: &state)
        XCTAssertEqual(state.snapshot.state, .running)
    }

    // MARK: Turn folding

    private func sampleItems(running: Bool) -> [CodeV2.TurnItem] {
        [
            .userMessage(CodeV2.UserMessage(id: "u1", turnId: "t1", createdAt: at(0), text: "Make the cart total server-side")),
            .reasoning(CodeV2.Reasoning(id: "r1", turnId: "t1", createdAt: at(1), text: "Look at the client first.")),
            .commandExecution(CodeV2.CommandExecution(id: "c1", turnId: "t1", createdAt: at(15), callId: "c1", command: "pnpm test cart", output: "a\nb\nc\nd", exitCode: 1, durationMs: 9_000, status: .completed)),
            .fileChange(CodeV2.FileChange(id: "f1", turnId: "t1", createdAt: at(30), callId: "f1", changes: [
                CodeV2.FileChangeEntry(path: "src/cart/total.ts", change: .modify, additions: 12, deletions: 4),
            ], status: .completed)),
            .fileChange(CodeV2.FileChange(id: "f2", turnId: "t1", createdAt: at(40), callId: "f2", changes: [
                CodeV2.FileChangeEntry(path: "src/cart/total.ts", change: .modify, additions: 3, deletions: 1),
                CodeV2.FileChangeEntry(path: "src/api/cart.ts", change: .add, additions: 40, deletions: 0),
            ], status: .completed)),
            .subagent(CodeV2.Subagent(id: "s1", turnId: "t1", createdAt: at(50), agentId: "w1", role: .worker, model: selection, status: .running, task: "Write the tests")),
            .assistantMessage(CodeV2.AssistantMessage(id: "a1", turnId: "t1", createdAt: at(252), text: "The total now comes from the server.", streaming: running)),
        ]
    }

    func testTurnsGroupStepsAndKeepTheAnswerVisible() throws {
        let turns = CodeV2TurnFolding.turns(from: sampleItems(running: false))
        XCTAssertEqual(turns.count, 1)
        let turn = try XCTUnwrap(turns.first)
        XCTAssertEqual(turn.userMessages.first?.text, "Make the cart total server-side")
        XCTAssertEqual(turn.answer?.text, "The total now comes from the server.")
        XCTAssertEqual(turn.subagents.count, 1)
        XCTAssertFalse(turn.steps.contains { if case .assistantMessage = $0 { return true } else { return false } })
        // Edits to one file merge in the receipt.
        XCTAssertEqual(turn.changedFiles.map(\.path), ["src/cart/total.ts", "src/api/cart.ts"])
        XCTAssertEqual(turn.additions, 55)
        XCTAssertEqual(turn.deletions, 5)
        XCTAssertEqual(turn.durationSeconds, 252)
        XCTAssertTrue(turn.canFold)
    }

    func testRunningOrBlockedTurnsCannotFold() throws {
        let running = try XCTUnwrap(CodeV2TurnFolding.turns(from: sampleItems(running: true), activeTurnId: "t1").first)
        XCTAssertTrue(running.isRunning)
        XCTAssertFalse(running.canFold)

        var items = sampleItems(running: false)
        items.append(.approvalRequest(CodeV2.ApprovalRequest(id: "ap", turnId: "t1", createdAt: at(260), callId: "c9", requestId: "r9", action: .command, summary: "rm -rf build", status: .pending)))
        let blocked = try XCTUnwrap(CodeV2TurnFolding.turns(from: items).first)
        XCTAssertFalse(blocked.canFold)
        XCTAssertEqual(CodeV2TurnFolding.pendingRequests(in: items).count, 1)
    }

    func testStepRowsSayWhatHappenedInWords() throws {
        let failed = try XCTUnwrap(CodeV2StepRow.make(sampleItems(running: false)[2]))
        XCTAssertEqual(failed.glyph, .terminal)
        XCTAssertEqual(failed.state, .failed)
        XCTAssertEqual(failed.object, "pnpm test cart")
        XCTAssertLessThanOrEqual(failed.outputTail.count, 3)

        let edit = try XCTUnwrap(CodeV2StepRow.make(sampleItems(running: false)[3]))
        XCTAssertEqual(edit.verb, "Edited")
        XCTAssertEqual(edit.additions, 12)
        XCTAssertEqual(edit.deletions, 4)

        XCTAssertEqual(CodeV2TurnFolding.durationLabel(seconds: 252), "Worked for 4m 12s")
        XCTAssertEqual(CodeV2Formatting.modelName("anthropic:claude-opus-5-5"), "Claude Opus 5.5")
    }

    // MARK: Unified diff

    private let diff = """
        diff --git a/src/cart/total.ts b/src/cart/total.ts
        index 1111111..2222222 100644
        --- a/src/cart/total.ts
        +++ b/src/cart/total.ts
        @@ -1,4 +1,4 @@
         import { Cart } from "./cart";
        -export const total = (cart: Cart) => cart.items.reduce((s, i) => s + i.price, 0);
        +export const total = (cart: Cart) => cart.serverTotal;
         // keep
         export default total;
        @@ -20,2 +20,3 @@ function tail() {
         a
        +b
         c
        diff --git a/src/api/cart.ts b/src/api/cart.ts
        new file mode 100644
        --- /dev/null
        +++ b/src/api/cart.ts
        @@ -0,0 +1,2 @@
        +export const route = "/api/cart";
        +export default route;
        """

    func testUnifiedDiffParsesFilesHunksAndCounts() throws {
        let files = CodeV2UnifiedDiff.parse(diff)
        XCTAssertEqual(files.map(\.path), ["src/cart/total.ts", "src/api/cart.ts"])
        XCTAssertEqual(files[0].hunks.count, 2)
        XCTAssertEqual(files[0].additions, 2)
        XCTAssertEqual(files[0].deletions, 1)
        XCTAssertEqual(files[1].change, .add)
        XCTAssertEqual(files[1].additions, 2)
        XCTAssertEqual(files[0].fileName, "total.ts")
        XCTAssertEqual(files[0].directory, "src/cart/")

        let patch = CodeV2UnifiedDiff.patch(for: files[0].hunks[0], path: files[0].path)
        XCTAssertTrue(patch.hasPrefix("--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n@@ -1,4 +1,4 @@"))
    }

    func testHunkDecisionsAndWordLevelChange() throws {
        let files = CodeV2UnifiedDiff.parse(diff)
        let hunks = files[0].hunks
        var decisions = CodeV2HunkDecisions()
        XCTAssertEqual(decisions.nextUndecided(after: nil, in: hunks), 0)
        decisions.set(.accepted, for: hunks[0])
        XCTAssertEqual(decisions.decision(for: hunks[0]), .accepted)
        XCTAssertEqual(decisions.nextUndecided(after: nil, in: hunks), 1)

        let change = try XCTUnwrap(CodeV2UnifiedDiff.wordChange(old: "cart.items.total", new: "cart.serverTotal"))
        XCTAssertEqual(change.old.lowerBound, 5)
        XCTAssertEqual(change.new.lowerBound, 5)
    }
}
