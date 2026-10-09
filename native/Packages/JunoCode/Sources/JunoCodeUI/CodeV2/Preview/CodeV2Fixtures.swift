import Foundation
import JunoCodeCore

/// Real-looking content for the Code v2 surfaces: the product shots, the
/// offscreen snapshot tests and SwiftUI previews. One story across all of
/// them (the design mocks' "Move checkout totals to the server"), so a
/// screenshot of one surface reads as a frame of the same session.
public enum CodeV2Fixtures {
    /// 2026-10-09 14:20:00 UTC. Every timestamp is an offset from here.
    public static let origin = Date(timeIntervalSince1970: 1_791_642_000)
    /// "Now" for elapsed times in the working-state shots.
    public static let now = origin.addingTimeInterval(400)

    static func at(_ seconds: Int) -> String {
        CodeV2Dates.string(origin.addingTimeInterval(TimeInterval(seconds)))
    }

    // MARK: Models and instances

    public static let gpt = CodeV2.ProviderModel(
        id: "openai:gpt-6.1", label: "GPT-6.1 Sol",
        contextTiers: [
            CodeV2.ContextTier(tokens: 272_000, label: "272K", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2),
            CodeV2.ContextTier(tokens: 1_000_000, label: "1M", inputPerMTok: 4, outputPerMTok: 15, cachedInputPerMTok: 0.4),
        ],
        effortLevels: [.low, .medium, .high, .xhigh], defaultEffort: .high, supportsFast: true
    )
    public static let opusAlevr = CodeV2.ProviderModel(
        id: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5",
        contextTiers: [
            CodeV2.ContextTier(tokens: 200_000, label: "200K", inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5),
            CodeV2.ContextTier(tokens: 1_000_000, label: "1M", inputPerMTok: 10, outputPerMTok: 37.5, cachedInputPerMTok: 1),
        ],
        effortLevels: [.low, .medium, .high, .max], defaultEffort: .high
    )
    public static let flash = CodeV2.ProviderModel(
        id: "deepseek:deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash",
        contextTiers: [CodeV2.ContextTier(tokens: 128_000, label: "128K", inputPerMTok: 0.15, outputPerMTok: 0.6)],
        effortLevels: [.low, .high]
    )

    public static let alevr = CodeV2.ProviderInstance(
        id: "alevr", kind: .alevr, label: "Alevr", account: CodeV2.ProviderAccount(plan: "Plus"),
        status: .ready, capabilities: CodeV2KnownSubscription.alevrEngineCapabilities,
        models: [opusAlevr, gpt, flash]
    )

    static let claudeTier = [CodeV2.ContextTier(tokens: 1_000_000, label: "1M", inputPerMTok: 0, outputPerMTok: 0)]

    public static let claude = CodeV2.ProviderInstance(
        id: "claude-agent:default", kind: .claudeAgent, label: "Claude (your subscription)",
        binaryPath: "/Users/maya/.local/bin/claude",
        account: CodeV2.ProviderAccount(email: "maya@okafor.dev", plan: "max", tokenSource: "claude.ai"),
        status: .ready, version: "2.1.40",
        limits: [
            CodeV2.UsageWindow(id: "five_hour", label: "5-hour", usedPct: 38, resetsAt: at(8_400)),
            CodeV2.UsageWindow(id: "weekly", label: "Weekly", usedPct: 12, resetsAt: at(400_000)),
        ],
        capabilities: CodeV2.ProviderCapabilities(
            steering: true, queue: true, interrupt: true, resume: true, fork: true, rollback: true, planMode: true,
            approvals: [.readOnly, .ask, .autoEdit, .auto, .full], subagents: true, computerUse: true,
            contextTiers: false, effortLevels: [.low, .medium, .high, .max], images: true, mcpInjection: true
        ),
        models: [
            CodeV2.ProviderModel(id: "claude-opus-5-5", label: "Claude Opus 5.5", contextTiers: claudeTier, effortLevels: [.low, .medium, .high, .max], defaultEffort: .high),
            CodeV2.ProviderModel(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextTiers: claudeTier, effortLevels: [.low, .medium, .high, .max]),
            CodeV2.ProviderModel(id: "claude-haiku-4-5", label: "Claude Haiku 4.5",
                                 contextTiers: [CodeV2.ContextTier(tokens: 200_000, label: "200K", inputPerMTok: 0, outputPerMTok: 0)],
                                 effortLevels: [.low, .high]),
        ]
    )

    public static let codex = CodeV2.ProviderInstance(
        id: "codex:default", kind: .codex, label: "ChatGPT (Codex)", binaryPath: "/opt/homebrew/bin/codex",
        account: CodeV2.ProviderAccount(email: "maya@okafor.dev", plan: "pro"), status: .ready, version: "0.62.0",
        limits: [CodeV2.UsageWindow(id: "primary", label: "5-hour", usedPct: 64, resetsAt: at(5_000))],
        capabilities: CodeV2.ProviderCapabilities(
            steering: true, queue: true, interrupt: true, resume: true, rollback: true, planMode: true,
            approvals: [.readOnly, .ask, .autoEdit, .auto, .full], effortLevels: [.low, .medium, .high, .xhigh]
        ),
        models: [
            CodeV2.ProviderModel(id: "gpt-6.1-codex", label: "GPT-6.1 Sol", contextTiers: [CodeV2.ContextTier(tokens: 272_000, label: "272K", inputPerMTok: 0, outputPerMTok: 0)],
                                 effortLevels: [.low, .medium, .high, .xhigh], defaultEffort: .high),
        ]
    )

    public static let gemini = CodeV2.ProviderInstance(
        id: "acp:gemini", kind: .acp, label: "Gemini CLI", acpCommand: ["gemini", "--experimental-acp"],
        status: .signedOut, version: "0.19.0"
    )

    public static let grok = CodeV2KnownSubscription.grok.placeholder(envServerRunning: false)

    public static let deepseekHarness = CodeV2.ProviderInstance(
        id: "acp:dsh", kind: .acp, label: "DeepSeek Harness", acpCommand: ["dsh", "--profile", "acp"],
        status: .signedOut, statusMessage: "Sign-in expired. Sign in again to keep using your DeepSeek plan", version: "1.4.2"
    )

    public static let opencode = CodeV2KnownSubscription.opencode.placeholder(envServerRunning: false)
    public static let antigravity = CodeV2.ProviderInstance(
        id: CodeV2KnownSubscription.antigravity.instanceId, kind: .acp, label: "Antigravity",
        acpCommand: ["antigravity-acp"], status: .signedOut, version: "1.4.2"
    )

    public static let anthropicKey = CodeV2.ProviderInstance(
        id: "byok:anthropic", kind: .byok, label: "Anthropic key", status: .ready,
        capabilities: CodeV2KnownSubscription.alevrEngineCapabilities, models: [opusAlevr]
    )

    public static var directory: CodeV2ProviderDirectory {
        CodeV2ProviderDirectory.build(
            alevr: alevr,
            envInstances: [claude, codex, gemini, grok, deepseekHarness, opencode, anthropicKey],
            byokKeys: [.anthropic]
        )
    }

    // MARK: Selections

    public static let alevrSelection = CodeV2.ModelSelection(instanceId: "alevr", model: gpt.id, effort: .high, contextTokens: 1_000_000)
    public static let claudeSelection = CodeV2.ModelSelection(instanceId: claude.id, model: "claude-opus-5-5", effort: .high, contextTokens: 1_000_000)
    public static let codexSelection = CodeV2.ModelSelection(instanceId: codex.id, model: "gpt-6.1-codex", effort: .high, contextTokens: 272_000)
    public static let flashSelection = CodeV2.ModelSelection(instanceId: "alevr", model: flash.id, effort: .low, contextTokens: 128_000)

    public static var leadWorkers: CodeV2RoleDraft {
        var draft = CodeV2RoleDraft(preset: .leadWorkers, lead: claudeSelection, workerCount: 3, worker: codexSelection,
                                    reviewer: alevrSelection, explorer: flashSelection)
        draft.budgetUsd = 4
        return draft
    }

    // MARK: Threads

    static let diffTotal = """
        diff --git a/src/server/cart/total.ts b/src/server/cart/total.ts
        --- a/src/server/cart/total.ts
        +++ b/src/server/cart/total.ts
        @@ -1,9 +1,10 @@
         import { applyCoupon } from "./pricing";
        +import { taxFor } from "./tax";

        -export function total(items, coupon) {
        +export function total(items: Item[], coupon?: Coupon) {
        +  // Same order as the payment intent: tax first, then the coupon.
           const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
        -  return applyCoupon(subtotal, coupon) + taxFor(subtotal);
        +  const taxed = subtotal + taxFor(subtotal);
        +  return coupon ? applyCoupon(taxed, coupon) : taxed;
         }
        diff --git a/src/cart/useCartTotal.ts b/src/cart/useCartTotal.ts
        --- a/src/cart/useCartTotal.ts
        +++ b/src/cart/useCartTotal.ts
        @@ -12,3 +12,3 @@
        -  const total = useSelector(selectCartTotal);
        +  const { data: total } = useQuery(cartTotalQuery(cartId));
           return total ?? null;
        diff --git a/src/server/cart/total.server.test.ts b/src/server/cart/total.server.test.ts
        new file mode 100644
        --- /dev/null
        +++ b/src/server/cart/total.server.test.ts
        @@ -0,0 +1,4 @@
        +import { total } from "./total";
        +test("tax before coupon", () => {
        +  expect(total([{ price: 10, qty: 1 }], { off: 0.1 })).toBe(9.9);
        +});
        """

    public static var diffFiles: [CodeV2DiffFile] { CodeV2UnifiedDiff.parse(diffTotal) }

    /// The working state: a folded first turn with its receipt, then a second
    /// turn running a command, with a follow-up queued.
    public static var workingSnapshot: CodeV2.SessionSnapshot {
        CodeV2.SessionSnapshot(
            id: "env-1", cwd: "/Users/maya/code/storefront", title: "Move checkout totals to the server",
            selection: claudeSelection, runtimeMode: .autoEdit, state: .running, activeTurnId: "t2",
            items: [
                .userMessage(.init(id: "u1", turnId: "t1", createdAt: at(0), text: "Move the checkout total to the server. Today the cart computes it in the browser and drifts from what Stripe charges. Add tests.")),
                .reasoning(.init(id: "r1", turnId: "t1", createdAt: at(2), text: "The selector and the payment intent disagree on coupon order.", summary: true)),
                .search(.init(id: "s1", turnId: "t1", createdAt: at(16), callId: "s1", query: "cartTotal", scope: .content, matches: 11, status: .completed)),
                .fileChange(.init(id: "f1", turnId: "t1", createdAt: at(60), callId: "f1", changes: [
                    .init(path: "src/server/cart/total.ts", change: .modify, additions: 5, deletions: 2),
                ], status: .completed)),
                .fileChange(.init(id: "f2", turnId: "t1", createdAt: at(120), callId: "f2", changes: [
                    .init(path: "src/cart/useCartTotal.ts", change: .modify, additions: 1, deletions: 1),
                    .init(path: "src/server/cart/total.server.test.ts", change: .add, additions: 4, deletions: 0),
                ], status: .completed)),
                .assistantMessage(.init(id: "a1", turnId: "t1", createdAt: at(252), text: "The browser total and the charged total come from two different sums: `selectCartTotal` applies the coupon before tax, the payment intent applies it after. I moved the sum into `/api/cart/total` and the cart now reads it from there.")),
                .checkpoint(.init(id: "k1", turnId: "t1", createdAt: at(253), checkpointId: "cp1", turnOrdinal: 1, filesChanged: 3, additions: 10, deletions: 3)),
                .userMessage(.init(id: "u2", turnId: "t2", createdAt: at(300), text: "Run the cart suite before you call it done.")),
                .reasoning(.init(id: "r2", turnId: "t2", createdAt: at(301), text: "Typecheck first, then the cart tests.", summary: true)),
                .commandExecution(.init(id: "c1", turnId: "t2", createdAt: at(307), callId: "c1", command: "pnpm typecheck", exitCode: 0, durationMs: 18_000, status: .completed)),
                .commandExecution(.init(id: "c2", turnId: "t2", createdAt: at(359), callId: "c2", command: "pnpm test --filter cart",
                                        output: "✓ cart/total.server.test.ts (9)\n✓ cart/useCartTotal.test.tsx (6)\n… cart/checkout.e2e.test.ts", status: .running)),
            ],
            queue: [CodeV2.QueuedInput(id: "q1", input: .init(text: "Also update the README section on how totals are computed"), queuedAt: at(380))],
            usage: CodeV2.SessionUsage(inputTokens: 184_000, outputTokens: 9_400, cachedInputTokens: 120_000, contextTokens: 184_000, contextWindow: 1_000_000)
        )
    }

    /// The fan-out: a lead with three workers and an explorer, one worker
    /// waiting on an approval that has taken over the composer.
    public static var multiAgentSnapshot: CodeV2.SessionSnapshot {
        let worker = codexSelection
        return CodeV2.SessionSnapshot(
            id: "env-2", cwd: "/Users/maya/code/storefront", title: "Move checkout totals to the server",
            selection: claudeSelection,
            routing: leadWorkers.routing,
            runtimeMode: .autoEdit, state: .waiting, activeTurnId: "t1",
            items: [
                .userMessage(.init(id: "u1", turnId: "t1", createdAt: at(0), text: "Move checkout totals to the server and add tests. Split the call sites across workers.")),
                .reasoning(.init(id: "r1", turnId: "t1", createdAt: at(1), text: "Three call sites; one worker each.", summary: true)),
                .plan(.init(id: "p1", turnId: "t1", createdAt: at(10), text: "3 tasks, one per call site", steps: [
                    .init(text: "Server route for the total", status: .completed),
                    .init(text: "Client reads the server total", status: .inProgress),
                    .init(text: "Cart total regression suite", status: .pending),
                ])),
                .assistantMessage(.init(id: "a0", turnId: "t1", createdAt: at(12), text: "Three workers, one per call site. Explorer already mapped them; I'll merge their branches and have the reviewer read each diff.")),
                .subagent(.init(id: "sa1", turnId: "t1", createdAt: at(14), agentId: "w1", role: .worker, model: worker, status: .completed,
                                task: "Server route for the total", closingText: "Added /api/cart/total with tax before coupon.", tokens: .init(input: 62_000, output: 9_000))),
                .assistantMessage(.init(id: "w1-done", turnId: "t1", createdAt: at(126), text: "Added /api/cart/total with tax before coupon.", agentId: "w1")),
                .subagent(.init(id: "sa2", turnId: "t1", createdAt: at(239), agentId: "w2", role: .worker, model: worker, status: .running,
                                task: "Client reads the server total")),
                .assistantMessage(.init(id: "w2-live", turnId: "t1", createdAt: at(380), text: "Editing src/cart/useCartTotal.ts", streaming: true, agentId: "w2")),
                .subagent(.init(id: "sa3", turnId: "t1", createdAt: at(277), agentId: "w3", role: .worker, model: worker, status: .waiting,
                                task: "Cart total regression suite")),
                .subagent(.init(id: "sa4", turnId: "t1", createdAt: at(3), agentId: "e1", role: .explorer, model: flashSelection, status: .completed,
                                task: "Map every caller of selectCartTotal", closingText: "Found 3 call sites and 2 tests. Closed.")),
                .assistantMessage(.init(id: "e1-done", turnId: "t1", createdAt: at(41), text: "Found 3 call sites and 2 tests. Closed.", agentId: "e1")),
                .approvalRequest(.init(id: "ap1", turnId: "t1", createdAt: at(137), callId: "c9", requestId: "req-1", action: .command,
                                       summary: "pnpm test --filter cart -- --runInBand",
                                       justification: "To run the new regression suite against the server route. It reads files and writes nothing outside coverage/.",
                                       detail: "Worker 3", options: [.accept, .acceptForSession, .decline], status: .pending)),
            ],
            usage: CodeV2.SessionUsage(inputTokens: 240_000, outputTokens: 31_000, contextTokens: 96_000, contextWindow: 1_000_000, costUsd: 0.64)
        )
    }

    /// The same session once the second turn has settled: both turns fold,
    /// the composer is at rest.
    public static var settledSnapshot: CodeV2.SessionSnapshot {
        var snapshot = workingSnapshot
        snapshot.state = .idle
        snapshot.activeTurnId = nil
        snapshot.queue = []
        snapshot.items.removeLast()
        snapshot.items += [
            .commandExecution(.init(id: "c2", turnId: "t2", createdAt: at(359), callId: "c2", command: "pnpm test --filter cart",
                                    output: "✓ cart/total.server.test.ts (9)\n✓ cart/useCartTotal.test.tsx (6)\n✓ cart/checkout.e2e.test.ts (4)",
                                    exitCode: 0, durationMs: 41_000, status: .completed)),
            .fileChange(.init(id: "f3", turnId: "t2", createdAt: at(402), callId: "f3", changes: [
                .init(path: "README.md", change: .modify, additions: 6, deletions: 1),
            ], status: .completed)),
            .assistantMessage(.init(id: "a2", turnId: "t2", createdAt: at(431), text: "Typecheck is clean and the cart suite passes: 19 tests across the server total, the hook and the checkout flow. I also noted in the README that the total now comes from `/api/cart/total`, so the browser never sums prices itself.")),
            .checkpoint(.init(id: "k2", turnId: "t2", createdAt: at(432), checkpointId: "cp2", turnOrdinal: 2, filesChanged: 1, additions: 6, deletions: 1)),
        ]
        snapshot.usage = CodeV2.SessionUsage(inputTokens: 196_000, outputTokens: 11_200, cachedInputTokens: 140_000, contextTokens: 196_000, contextWindow: 1_000_000)
        return snapshot
    }

    /// A new session: no turns yet.
    public static var newSnapshot: CodeV2.SessionSnapshot {
        CodeV2.SessionSnapshot(
            id: "env-0", cwd: "/Users/maya/code/storefront", title: nil,
            selection: claudeSelection, state: .idle, items: []
        )
    }

    /// The sidebar's list of work, around the storefront session.
    public static var sidebarSessions: [CodeSidebarSession] {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        return CodeSidebarSession.ordered([
            CodeSidebarSession(id: "s1", title: "Move checkout totals to the server", project: "storefront", updatedAt: ago(1), state: .idle),
            CodeSidebarSession(id: "s2", title: "Check the receipt in Safari", project: "storefront", updatedAt: ago(4), state: .working),
            CodeSidebarSession(id: "s3", title: "Regression suite for cart totals", project: "storefront", updatedAt: ago(7), state: .needsYou),
            CodeSidebarSession(id: "s4", title: "Dark mode for the receipt email", project: "mailer", updatedAt: ago(52), state: .idle, isUnread: true),
            CodeSidebarSession(id: "s5", title: "Bump Stripe SDK to v19", project: "storefront", updatedAt: ago(180), state: .idle),
            CodeSidebarSession(id: "s6", title: "Why does the sitemap skip /gift-cards", project: "storefront", updatedAt: ago(600), state: .idle),
            CodeSidebarSession(id: "s7", title: "Rate limit the coupon endpoint", project: "api", updatedAt: ago(1_500), state: .idle),
            CodeSidebarSession(id: "s8", title: "Explain the order state machine", project: "api", updatedAt: ago(2_900), state: .idle),
            CodeSidebarSession(id: "s9", title: "Port the admin table to the new grid", project: "admin", updatedAt: ago(6_000), state: .idle),
        ])
    }

    /// A Claude plan limit hit mid-run.
    public static var limitedSnapshot: CodeV2.SessionSnapshot {
        var snapshot = workingSnapshot
        snapshot.state = .limited
        snapshot.activeTurnId = nil
        snapshot.resumeAt = at(8_400)
        snapshot.queue = []
        snapshot.items.removeLast()
        snapshot.items.append(.interrupt(.init(id: "i1", turnId: "t2", createdAt: at(390), reason: .limit, resumeAt: at(8_400))))
        return snapshot
    }

    /// A computer-use run: four frames, the latest still in progress.
    public static var computerSnapshot: CodeV2.SessionSnapshot {
        CodeV2.SessionSnapshot(
            id: "env-3", cwd: "/Users/maya/code/storefront", title: "Check the receipt in Safari",
            selection: claudeSelection, state: .running, activeTurnId: "t1",
            items: [
                .userMessage(.init(id: "u1", turnId: "t1", createdAt: at(0), text: "Open the checkout in Safari and check the receipt shows the server total.")),
                .computerAction(.init(id: "ca1", turnId: "t1", createdAt: at(4), callId: "ca1", action: .openApp, target: "Safari", screenshotRef: CodeV2FixtureFrames.path(.blank), status: .completed)),
                .computerAction(.init(id: "ca2", turnId: "t1", createdAt: at(9), callId: "ca2", action: .click, target: "Checkout", screenshotRef: CodeV2FixtureFrames.path(.cart), status: .completed)),
                .computerAction(.init(id: "ca3", turnId: "t1", createdAt: at(15), callId: "ca3", action: .type, target: "SPRING10", screenshotRef: CodeV2FixtureFrames.path(.typed), status: .completed)),
                .computerAction(.init(id: "ca4", turnId: "t1", createdAt: at(22), callId: "ca4", action: .screenshot, target: "Receipt", screenshotRef: CodeV2FixtureFrames.path(.receipt), status: .running)),
            ]
        )
    }

    public static var bestOfNCandidates: [CodeV2BestOfNCandidate] {
        [
            CodeV2BestOfNCandidate(id: "c1", selection: claudeSelection, instanceLabel: "Your subscription", elapsedSeconds: 252,
                                   costUsd: nil, additions: 10, deletions: 3, testsLine: "15 of 15 tests pass",
                                   summary: "Moves the sum server-side; client uses a query.", isFinished: true),
            CodeV2BestOfNCandidate(id: "c2", selection: codexSelection, instanceLabel: "ChatGPT (Codex)", elapsedSeconds: 198,
                                   costUsd: nil, additions: 96, deletions: 30, testsLine: "14 of 15 tests pass",
                                   summary: "Same route; keeps the selector as a fallback.", isFinished: true),
            CodeV2BestOfNCandidate(id: "c3", selection: alevrSelection, instanceLabel: "Alevr", elapsedSeconds: 161,
                                   costUsd: 0.41, additions: 0, deletions: 0, testsLine: nil,
                                   summary: "Running pnpm test", isFinished: false),
        ]
    }
}
