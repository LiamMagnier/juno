import Foundation
import JunoAPI
import JunoAuth
import JunoCodeBridge
import JunoCodeRuntime
import JunoCore
import JunoSync
import JunoWorkAutomation
import JunoWorkCore
import JunoWorkKit
import JunoWorkRuntime

/// The conversion the app owes the two halves of Juno Work.
///
/// `JunoWorkKit.WorkCommandExecuting` and `JunoWorkRuntime.WorkLocalCommandExecuting`
/// are the same idea seen from opposite sides of a dependency edge that must not
/// exist: JunoWork may not depend on JunoNativeKit, because that would put a
/// network client inside the layer that touches somebody's documents. So the two
/// protocols are declared separately and the app translates, here, where the
/// translation is a visible piece of code a person can read — which is exactly
/// what `LocalWorkExecutor`'s own note asks for.
///
/// Until this existed, `DesktopWorkHostModel.executorProvider` was declared and
/// never assigned, so `syncRemoteHost` fell straight through to `phase = .off`
/// and this Mac never claimed a single command. The whole local Work runtime was
/// present in the source tree and unreachable from the running app.
struct DesktopWorkExecutorAdapter: WorkCommandExecuting {
    private let executor: LocalWorkExecutor

    init(executor: LocalWorkExecutor) {
        self.executor = executor
    }

    func execute(_ command: WorkCommand) async throws -> [String: JunoJSONValue] {
        let local = WorkLocalCommand(
            id: command.id,
            sessionID: command.sessionID,
            runID: command.runID,
            // Carried across raw, never decoded into `WorkLocalCommandKind` here.
            // An instruction this build does not understand has to survive as far
            // as the refusal so the refusal can name it, and a translation that
            // dropped an unknown kind would turn "Juno does not understand that"
            // into a command that silently did nothing.
            kind: command.kind,
            payload: command.payload.mapValues(DesktopWorkValueBridge.toolValue),
            expiresAt: command.expiresAt
        )
        let result = try await executor.execute(local)
        return result.mapValues(DesktopWorkValueBridge.jsonValue)
    }
}

/// Everything Juno Work needs on this Mac, assembled once and joined to the
/// host model.
///
/// The pieces only mean anything together, and each of them shipped without the
/// others: a host model whose `executorProvider` was never assigned advertised a
/// Mac that claimed nothing; an executor with no `WorkRunHosting` could not start
/// a run; a grant store nobody listened to was a folder shared with something
/// that never heard about it. One object owns the graph so there is a single
/// place to read what a dispatched task can reach.
///
/// The host row id is not available until registration lands, which is why this
/// hands back a *factory* rather than an executor: `LocalWorkExecutor` stamps the
/// id into a `ping`, the run host addresses the event outbox with it, and a grant
/// is recorded against it.
@MainActor
final class DesktopWorkLocalRuntime {
    private weak var host: DesktopWorkHostModel?
    private let grants: DesktopWorkGrantStore
    private let streamer: any NativeAuthenticatedByteStreaming
    private let reporter: any WorkRunReporting
    private let undo: WorkUndoLedger
    private let approvals: WorkApprovalCoordinator
    /// One stop and one audit for the whole app, not one per run.
    ///
    /// The emergency stop is the thing somebody reaches for when automation has
    /// gone wrong, and a per-run stop would only halt the run they happened to be
    /// looking at. The audit is capped and shared for the same reason: two logs
    /// are two things to read when explaining what a Mac did.
    private let emergencyStop = EmergencyStop()
    private let audit = AutomationAuditLog()
    private var executor: LocalWorkExecutor?

    init(
        host: DesktopWorkHostModel,
        grants: DesktopWorkGrantStore,
        streamer: any NativeAuthenticatedByteStreaming,
        reporter: any WorkRunReporting,
        undo: WorkUndoLedger
    ) {
        self.host = host
        self.grants = grants
        self.streamer = streamer
        self.reporter = reporter
        self.undo = undo
        self.approvals = WorkApprovalCoordinator(
            policy: Self.permissionPolicy(host.approvalPolicy)
        )
        observeApprovals()
    }

    /// Publishes this Mac's own pending approvals to the window.
    ///
    /// **Why a local run needs its own path.** A cloud run's approval is a
    /// `WorkApproval` row: the runner writes it, the relay serves it, and every
    /// client sees it. A run executing *here* never touches that table —
    /// `WorkApprovalCoordinator` suspends the tool in-process and waits on a
    /// continuation held in this app. So for exactly the runs that reach
    /// somebody's own documents, `NativeWorkModel.pendingApprovals` is empty by
    /// construction and the approval card cannot appear no matter what the
    /// server does.
    ///
    /// The coordinator already publishes `.requested` and `.resolved`; nothing
    /// was listening. This forwards them to ``DesktopWorkHostModel``, which the
    /// Work window already receives, so the decision is drawn from whichever
    /// side raised it.
    ///
    /// The observer is never removed. This object lives as long as the signed-in
    /// session and the coordinator lives inside it, so a token to cancel with
    /// would be a token nobody could ever be in a position to use.
    private func observeApprovals() {
        let coordinator = approvals
        guard let host else { return }
        Task { [weak host] in
            // The observer hops back to the main actor. The coordinator is an
            // actor and its updates cross isolation, while the host model is
            // main-actor isolated and weakly captured so sign-out can release
            // the window graph.
            _ = await coordinator.addObserver { [weak host] update in
                Task { @MainActor [weak host] in
                    guard let host else { return }
                    switch update {
                    case .requested(let request):
                        host.localApprovalRaised(Self.bridge(request))
                    case .resolved(let id, _):
                        host.localApprovalResolved(id)
                    }
                }
            }
            // Registration is asynchronous, so a very fast local run can ask
            // before the observer is attached. Reconcile the actor's current
            // state after registering; the model de-duplicates requests, and a
            // request that arrives between these two awaits is therefore safe
            // in either order.
            let pending = await coordinator.pendingApprovals
            await MainActor.run { [weak host] in
                for request in pending {
                    host?.localApprovalRaised(Self.bridge(request))
                }
            }
        }
    }

    /// The in-process request, in the shape the window's other approvals arrive
    /// in.
    ///
    /// `JunoWorkRuntime.WorkApprovalRequest` and `JunoWorkKit.WorkApprovalRequest`
    /// are the same idea either side of the dependency edge this file exists to
    /// bridge — the runtime may not see the relay's wire types, for the reason
    /// stated at the top of this file. Translating here means the thread has one
    /// approval type to render rather than a branch per executor.
    ///
    /// `detail` is deliberately empty. The relay's copy carries a structured
    /// breakdown the server assembled; the local coordinator holds only the
    /// sentence it was constructed with, and inventing a breakdown from the
    /// action name would put something on the consent card that nobody wrote.
    /// `decision` is `pending` because an approval that has been decided is
    /// removed from the coordinator rather than kept with an answer on it.
    private static func bridge(
        _ request: JunoWorkRuntime.WorkApprovalRequest
    ) -> JunoWorkKit.WorkApprovalRequest {
        JunoWorkKit.WorkApprovalRequest(
            approvalID: request.id,
            runID: request.runID,
            action: request.action,
            risk: request.risk.rawValue,
            summary: request.summary,
            detail: [:],
            actionDigest: request.actionDigest,
            expiresAt: request.expiresAt,
            decision: JunoWorkApprovalDecision.pending.rawValue
        )
    }

    /// Answers a question this Mac asked, from this Mac's own window.
    ///
    /// The digest travels with the answer for the same reason it does on the
    /// relay path: `WorkApprovalCoordinator.resolve` refuses an answer whose
    /// digest names a different action than the one it is holding, so a card
    /// left on screen while the run moved on cannot authorise what replaced it.
    ///
    /// **"Always allow" is a second, separate act.** The coordinator's
    /// `resolve` only knows approved and denied; a standing grant is
    /// `setAllowance`, and `WorkAlwaysAllowance` has a failable initialiser that
    /// refuses anything above `command` — so a sensitive or irreversible action
    /// *cannot* be turned into a standing yes, by construction. The allowance is
    /// set before the answer so the run's next question is already covered by
    /// it, and a risk the allowance refuses falls back to a one-time approval
    /// rather than silently granting less than the button promised. The window
    /// does not offer the button in that case — see
    /// `DesktopWorkApprovalCard.allowsStandingGrant` — so this is the belt to
    /// that surface's braces.
    func decideLocalApproval(
        id: String,
        decision: JunoWorkApprovalDecision,
        actionDigest: String,
        risk: String
    ) {
        Task { [approvals] in
            // Resolve first. `WorkApprovalCoordinator` invalidates a receipt
            // when authority narrows; changing the standing allowance before
            // resolving would make the approval that the user just accepted
            // fail its revision check. The current action must succeed, and
            // the standing allowance then applies to subsequent equivalent
            // actions.
            await approvals.resolve(
                approvalID: id,
                decision: decision == .denied ? .denied : .approved,
                actionDigest: actionDigest
            )
            // **Widen only, never narrow.**
            //
            // Resolving first (above) stops this from denying the approval it
            // is granting, but not from denying everything *else* that is
            // pending. `setAllowance` revokes every unanswered question the
            // moment the ceiling drops — deliberately, because a decision made
            // under a wider envelope must not survive the envelope shrinking.
            // Setting the allowance to *this* action's risk therefore lowers it
            // whenever the standing grant already covers more: allow-always on
            // a `command` action, then allow-always on an `edit` one, and every
            // other question waiting on this Mac is refused with "Juno's
            // permissions on this Mac changed before that could run" — caused
            // by a person granting a permission, not removing one.
            //
            // An allowance that already covers this risk is left exactly as it
            // is, so the button can only ever add authority.
            if decision == .allowedAlways, let level = WorkRiskLevel(rawValue: risk) {
                let existing = await approvals.standingAllowance
                if existing?.covers(level) != true,
                    let allowance = WorkAlwaysAllowance(upTo: level)
                {
                    await approvals.setAllowance(allowance)
                }
            }
        }
    }

    /// Narrows the local approval gate to match the switches.
    ///
    /// Only ever passed through, never combined with anything: `setPolicy`
    /// revokes every unanswered question when the authority shrinks, and an
    /// approval granted under a wider envelope must not survive it.
    func apply(_ policy: WorkHostPolicy) {
        let permission = Self.permissionPolicy(policy.approvalPolicy)
        // Nil means somebody is watching. `allowsBackground` is the switch that
        // says a run may continue with nobody at the Mac, and under that reading
        // the unattended rules are what decide instead of a person.
        let unattended: WorkRisk.UnattendedPolicy? = policy.allowsBackground
            ? .pauseForApproval
            : nil
        Task { [approvals] in
            await approvals.setPolicy(permission)
            await approvals.setUnattendedPolicy(unattended)
        }
    }

    /// Builds the thing a claimed command is handed to, for one host row.
    func makeExecutor(hostID: String, accountID: AccountID) -> any WorkCommandExecuting {
        grants.setHostID(hostID)
        let runs = DesktopWorkRunHost(
            dependencies: DesktopWorkRunHost.Dependencies(
                hostID: hostID,
                accountID: accountID,
                model: BackendCodeModelClient(streamer: streamer, accountID: accountID),
                reporter: reporter,
                defaultModelID: Self.defaultModelID,
                automationTools: { [weak self] in await self?.automationTools() ?? [] },
                activityChanged: { [weak host] active in
                    await MainActor.run {
                        // Queued is always zero here: this Mac holds at most the
                        // command it is running, and anything waiting is waiting
                        // in the relay's queue where the relay counts it.
                        host?.setActivity(active: active, queued: 0)
                    }
                }
            )
        )
        let executor = LocalWorkExecutor(
            hostID: hostID,
            approvals: approvals,
            undo: undo,
            runs: runs,
            grants: grants.liveRuntimes,
            grantRequests: DesktopWorkGrantRequests(store: grants),
            manifest: { [weak self] in await self?.manifest(hostID: hostID) ?? Self.emptyManifest(hostID: hostID) }
        )
        self.executor = executor
        // Pushed in rather than read out, so a folder shared — or taken back —
        // while a run is going reaches the executor that is already running. A
        // list snapshotted at construction is wrong the moment somebody shares a
        // second folder.
        grants.observe { [weak host] runtimes, summaries in
            host?.setGrants(summaries)
            Task { await executor.setGrants(runtimes) }
        }
        return DesktopWorkExecutorAdapter(executor: executor)
    }

    // MARK: - What this Mac can truthfully claim

    private func manifest(hostID: String) async -> WorkCapabilityManifest {
        let policy = host?.policy ?? .denied
        return WorkCapabilityManifest(
            hostID: hostID,
            displayName: Host.current().localizedName ?? "Mac",
            toggles: WorkHostToggles(
                workEnabled: policy.enabled,
                activeFolderGrants: grants.liveRuntimes.count,
                // The macOS permission, asked of macOS. A switch in Juno's own
                // settings says what the person wants; only TCC says whether it
                // is possible, and a manifest built from the wish wins this Mac
                // a task it cannot start.
                accessibilityPermissionGranted: SystemScreenPreflight.accessibilityAuthorized(),
                // A count of *profiles*, which the Apple-event driver does not
                // have a notion of: it drives whichever known browser is
                // already open, under whatever profile the user is signed into.
                // Zero is honest here rather than a claim of no driver — see
                // `automationTools()`, which offers browser control only when
                // `SystemBrowserDriver.isAvailable()` says the Automation grant
                // is really held.
                browserProfileGrants: 0,
                screenRecordingPermissionGranted: SystemScreenPreflight.screenRecordingAuthorized(),
                shellEnabled: policy.allowsShell
            ),
            generatedAt: Date()
        )
    }

    /// What this Mac claims once the runtime that speaks for it is gone: nothing.
    ///
    /// `nonisolated` because it is reached from the executor's manifest closure
    /// after the owning runtime has been released, which is precisely the moment
    /// there is no main actor context to hop to.
    nonisolated private static func emptyManifest(hostID: String) -> WorkCapabilityManifest {
        WorkCapabilityManifest(
            hostID: hostID,
            displayName: Host.current().localizedName ?? "Mac",
            toggles: WorkHostToggles(workEnabled: false),
            generatedAt: Date()
        )
    }

    /// The automation controls this Mac can actually offer right now.
    ///
    /// Empty is a normal answer, and the question is asked afresh per run
    /// because none of it is stable: a person can revoke Accessibility or Screen
    /// Recording in System Settings between two runs, quit their browser, or
    /// flip a switch on the settings card. Registering a control whose
    /// permission has lapsed puts a tool in front of the model that fails on its
    /// first call, and a refusal reads to a model as the person's answer.
    ///
    /// The three controls, the drivers under them and the tier lattice that
    /// orders them are assembled by ``AutomationSuite``, which is also what
    /// decides — through each control's own `health()` — which of them may be
    /// advertised. That decision is deliberately not restated here: two places
    /// answering "is screen control usable right now" is two places that
    /// eventually disagree, and the one that is wrong is the one driving
    /// somebody's screen.
    private func automationTools() async -> [any WorkTool] {
        let policy = host?.policy ?? .denied
        guard policy.enabled else { return [] }
        // `WorkHostPolicy` has already folded the macOS permissions into these
        // two switches, so what reaches the gate is the wish and the grant
        // together rather than the wish alone.
        let permission = AutomationPermission(
            automationEnabled: true,
            allowsBrowserControl: policy.allowsBrowser,
            allowsAccessibilityControl: policy.allowsComputerUse,
            allowsVisualControl: policy.allowsComputerUse,
            allowedApps: policy.allowedApps,
            blockedApps: policy.blockedApps,
            allowedDomains: policy.allowedDomains
        )
        return await AutomationSuite.readyTools(
            permission: permission,
            stop: emergencyStop,
            screenshots: ScreenshotPolicy(
                capturePermitted: policy.allowsComputerUse,
                // Pictures of this Mac's screen stay on this Mac until there is
                // a switch for it that somebody has actually been shown.
                relayPermitted: false
            ),
            audit: audit,
            drivers: .system(permission: permission)
        )
    }

    /// Raw values are identical by design — both mirror `WORK_PERMISSION_POLICIES`
    /// in `src/lib/work/domain.ts` — but the two types live either side of the
    /// package split, so the mapping is written out rather than bridged by
    /// `rawValue` alone. `conservative` is the fallback because the strictest
    /// reading of a value nobody recognises is the only safe one.
    private static func permissionPolicy(
        _ policy: WorkHostPolicy.ApprovalPolicy
    ) -> WorkPermissionPolicy {
        switch policy {
        case .conservative: .conservative
        case .balanced: .balanced
        case .permissive: .permissive
        }
    }

    /// The model a Work run uses when the instruction did not name one.
    ///
    /// The same default the Code workbench bootstraps with, for the same reason:
    /// the account's manifest is not readable from here, and a run must not fail
    /// because nobody chose.
    private static let defaultModelID = "anthropic:claude-sonnet-5"
}

extension DesktopWorkSystemPermissions {
    /// Asked of macOS, every time.
    ///
    /// Never cached. A person can revoke Accessibility in System Settings while
    /// Juno is open, and a cached "yes" is a Mac that keeps advertising screen
    /// control it lost. Both calls are preflights and neither prompts —
    /// prompting belongs to an explicit gesture on the settings card.
    static var current: DesktopWorkSystemPermissions {
        DesktopWorkSystemPermissions(
            accessibility: SystemScreenPreflight.accessibilityAuthorized(),
            screenRecording: SystemScreenPreflight.screenRecordingAuthorized()
        )
    }
}

/// The two JSON trees Juno Work speaks, and the map between them.
///
/// `JunoCore.JunoJSONValue` and `JunoWorkRuntime.WorkToolValue` are structurally
/// identical and deliberately unrelated — see `WorkToolValue`'s own comment on
/// why the duplication is cheaper than the dependency. Both directions are total:
/// every case maps, so nothing is quietly flattened to null on the way across.
/// A lossy bridge here would be invisible until an approval digest computed over
/// one side stopped matching the arguments executed on the other.
enum DesktopWorkValueBridge {
    static func toolValue(_ value: JunoJSONValue) -> WorkToolValue {
        switch value {
        case .null: .null
        case .bool(let flag): .bool(flag)
        case .number(let number): .number(number)
        case .string(let text): .string(text)
        case .array(let items): .array(items.map(toolValue))
        case .object(let fields): .object(fields.mapValues(toolValue))
        }
    }

    static func jsonValue(_ value: WorkToolValue) -> JunoJSONValue {
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
