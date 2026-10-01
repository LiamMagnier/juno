import Foundation
import JunoCodeCore

// The visual verify loop's deterministic half (CODE_AGENT_SPEC §4.6, Lane D).
//
// The trigger is a rule, never the model's judgement: an edit to a UI file
// under a web configuration's folder, with autoVerify on, and no fresh UI
// evidence at the current workspace revision, sends the agent back with the
// gate reason `ui_unchecked` naming the routes. Evidence is minted by the
// runtime from what the Preview observed, never claimed by the model. At most
// three verify rounds run per run, and the same failure twice stops the loop
// with `checksFailing`.
//
// The page-facing half (settle, baselines, screenshots) is
// `JunoCodeUI/Views/Preview/PreviewVerifyLoop.swift`.

/// Which edits count as UI edits, and which routes they touch.
public enum PreviewUIEdits {
    public static let extensions: Set<String> = [
        "tsx", "jsx", "ts", "js", "vue", "svelte", "astro", "css", "scss", "html", "mdx",
    ]
    public static let folders: Set<String> = ["public", "app", "pages", "components", "styles"]

    /// Whether `path` (workspace-relative) is a UI edit under one of
    /// `webRoots` (workspace-relative folders of web configurations, `.` for
    /// the root).
    public static func isUIEdit(_ path: String, webRoots: [String]) -> Bool {
        let normalized = path.hasPrefix("./") ? String(path.dropFirst(2)) : path
        guard let relative = webRoots.lazy.compactMap({ Self.relative(normalized, to: $0) }).first else {
            return false
        }
        let components = relative.split(separator: "/").map(String.init)
        if components.contains(where: { $0 == "node_modules" || $0.hasPrefix(".") }) { return false }
        let ext = (relative as NSString).pathExtension.lowercased()
        if extensions.contains(ext) {
            // Config and test files change no page.
            let name = (relative as NSString).lastPathComponent.lowercased()
            if name.contains(".test.") || name.contains(".spec.") || name.hasSuffix(".d.ts") { return false }
            if name.hasPrefix("next.config") || name.hasPrefix("vite.config") || name.hasPrefix("tailwind.config")
                || name.hasPrefix("postcss.config") || name.hasPrefix("eslint") || name.hasPrefix("vitest.config")
                || name.hasPrefix("jest.config") || name.hasPrefix("playwright.config")
            {
                return false
            }
            return true
        }
        return components.dropLast().contains { folders.contains($0) }
    }

    static func relative(_ path: String, to root: String) -> String? {
        let cleanRoot = root.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if cleanRoot.isEmpty || cleanRoot == "." { return path }
        if path == cleanRoot { return "" }
        guard path.hasPrefix(cleanRoot + "/") else { return nil }
        return String(path.dropFirst(cleanRoot.count + 1))
    }

    /// The routes a set of UI edits touches: Next.js `app/` and `pages/`,
    /// SvelteKit `routes/` and Astro `pages/` files map to their paths; other
    /// files (components, styles) map to `fallback`, the routes last checked,
    /// or `/`.
    public static func affectedRoutes(for paths: [String], webRoots: [String], fallback: [String] = []) -> [String] {
        var routes: [String] = []
        var other = false
        for path in paths {
            guard let relative = webRoots.lazy.compactMap({ Self.relative(path, to: $0) }).first else { continue }
            if let route = route(forFile: relative) {
                if !routes.contains(route) { routes.append(route) }
            } else {
                other = true
            }
        }
        if other || routes.isEmpty {
            for route in (fallback.isEmpty ? ["/"] : fallback) where !routes.contains(route) {
                routes.append(route)
            }
        }
        return Array(routes.prefix(4))
    }

    /// The route a page file serves, or nil when the file is not a page.
    public static func route(forFile relative: String) -> String? {
        var components = relative.split(separator: "/").map(String.init)
        if components.first == "src" { components.removeFirst() }
        guard components.count >= 1, let file = components.last else { return nil }
        let stem = (file as NSString).deletingPathExtension
        func path(_ segments: [String]) -> String {
            let kept = segments.filter { !($0.hasPrefix("(") && $0.hasSuffix(")")) && !$0.hasPrefix("@") }
            return "/" + kept.joined(separator: "/")
        }
        switch components.first {
        case "app":
            // Next.js app router: app/(group)/settings/page.tsx → /settings.
            guard stem == "page" else { return nil }
            return path(Array(components.dropFirst().dropLast()))
        case "pages":
            // Next.js pages router and Astro: pages/settings.tsx → /settings.
            let segments = Array(components.dropFirst().dropLast())
            if segments.first == "api" || stem.hasPrefix("_") { return nil }
            return stem == "index" ? path(segments) : path(segments + [stem])
        case "routes":
            // SvelteKit: routes/settings/+page.svelte → /settings.
            guard stem == "+page" else { return nil }
            return path(Array(components.dropFirst().dropLast()))
        default:
            if components.count == 1, stem == "index", (file as NSString).pathExtension.lowercased() == "html" {
                return "/"
            }
            if components.count == 1, (file as NSString).pathExtension.lowercased() == "html" {
                return "/" + file
            }
            return nil
        }
    }
}

/// Bounds of the loop.
public enum PreviewVerifyPolicy {
    /// At most this many `ui_unchecked` continuations per run.
    public static let maximumRounds = 3

    /// What a failure "is", to notice the same failure twice: the target and
    /// the failing checks with their first detail line.
    public static func signature(of record: UIVerificationRecord) -> String {
        // The detail when there is one ("TypeError: menu is undefined"), else
        // the check's name without its counts, so "1 new console error" and
        // "2 new console errors" with the same error read as one failure.
        let failing = record.checks.filter { !$0.passed }.map { check in
            check.detail?.split(separator: "\n").first.map(String.init)
                ?? check.name.filter { !$0.isNumber }.replacingOccurrences(of: "errors", with: "error")
        }
        return "\(record.surface.rawValue)|\(record.target)|\(failing.joined(separator: ";"))"
    }

    /// Whether the newest two failing web records share a signature.
    public static func repeatsFailure(_ records: [UIVerificationRecord]) -> Bool {
        let failing = records.filter { !$0.passed && $0.surface == .web }
        guard failing.count >= 2 else { return false }
        return signature(of: failing[failing.count - 1]) == signature(of: failing[failing.count - 2])
    }
}

/// What the Preview observed at the moment of a screenshot, from which the
/// runtime mints a record.
public struct PreviewObservation: Sendable {
    public var route: String
    public var viewport: String
    public var httpStatus: Int?
    /// Console errors since the baseline, newest last.
    public var newConsoleErrors: [String]
    public var errorOverlay: String?
    /// Server-log error lines since the baseline.
    public var newServerErrors: [String]
    public var screenshotHash: String?
    public var workspaceRevision: Int

    public init(
        route: String,
        viewport: String,
        httpStatus: Int?,
        newConsoleErrors: [String],
        errorOverlay: String?,
        newServerErrors: [String],
        screenshotHash: String?,
        workspaceRevision: Int
    ) {
        self.route = route
        self.viewport = viewport
        self.httpStatus = httpStatus
        self.newConsoleErrors = newConsoleErrors
        self.errorOverlay = errorOverlay
        self.newServerErrors = newServerErrors
        self.screenshotHash = screenshotHash
        self.workspaceRevision = workspaceRevision
    }
}

/// Mints UI evidence from observations (§4.6 step 5).
public enum PreviewEvidence {
    /// A record that passes only when the page answered 2xx, showed no new
    /// console errors against the baseline, no error overlay, no new server
    /// errors, and a screenshot was taken. A failing record says why.
    public static func mint(_ observation: PreviewObservation, at date: Date = Date()) -> UIVerificationRecord {
        func first(_ lines: [String]) -> String? {
            lines.last.map { String($0.split(separator: "\n").first ?? Substring($0)).prefix(240) }.map(String.init)
        }
        let status = observation.httpStatus
        let statusPassed = status.map { (200..<300).contains($0) } ?? true
        let checks = [
            UICheckResult(
                name: status.map { "HTTP \($0)" } ?? "HTTP status",
                passed: statusPassed,
                detail: statusPassed ? nil : "the page answered \(status.map(String.init) ?? "nothing")"
            ),
            UICheckResult(
                name: observation.newConsoleErrors.isEmpty
                    ? "no new console errors"
                    : "\(observation.newConsoleErrors.count) new console error\(observation.newConsoleErrors.count == 1 ? "" : "s")",
                passed: observation.newConsoleErrors.isEmpty,
                detail: first(observation.newConsoleErrors)
            ),
            UICheckResult(
                name: observation.errorOverlay == nil ? "no error overlay" : "error overlay",
                passed: observation.errorOverlay == nil,
                detail: observation.errorOverlay.map { String($0.prefix(240)) }
            ),
            UICheckResult(
                name: observation.newServerErrors.isEmpty ? "no new server errors" : "server log error",
                passed: observation.newServerErrors.isEmpty,
                detail: first(observation.newServerErrors)
            ),
            UICheckResult(
                name: observation.screenshotHash == nil ? "no screenshot" : "screenshot",
                passed: observation.screenshotHash != nil
            ),
        ]
        return UIVerificationRecord(
            surface: .web,
            target: observation.route,
            viewport: observation.viewport,
            checks: checks,
            passed: checks.allSatisfy(\.passed),
            screenshotHash: observation.screenshotHash,
            workspaceRevision: observation.workspaceRevision,
            at: date
        )
    }
}

/// What the stop check should do about UI edits.
public enum PreviewUIDecision: Equatable, Sendable {
    /// Nothing to check, or already checked: the base decision stands.
    case none
    /// Send the agent back with this note (gate reason `ui_unchecked`).
    case continueWith(String)
    /// The same failure twice, or rounds exhausted on a failure: finish as
    /// `checksFailing`.
    case stopFailing
}

/// Answers rule 8 of the stop check for the web surface.
public protocol PreviewUIVerifyAdvising: Sendable {
    func uiDecision(for context: CompletionGateContext) async -> PreviewUIDecision
}

/// Rule 8 of the stop check (§1.4) for the Preview, as a decorator over any
/// gate: when the base gate would finish a run as done, UI edits without fresh
/// evidence send it back first. It never changes permissions; the agent checks
/// through the same tools and the same approvals as ever. Lane A's
/// `CompletionGate` composes the same advisor at its rule 8.
public struct PreviewUIGate: CompletionGating {
    public let base: any CompletionGating
    public let advisor: any PreviewUIVerifyAdvising

    public init(base: any CompletionGating, advisor: any PreviewUIVerifyAdvising) {
        self.base = base
        self.advisor = advisor
    }

    public func evaluate(_ context: CompletionGateContext) async -> GateDecision {
        let decision = await base.evaluate(context)
        guard case let .finish(reason) = decision, reason == .doneChecked || reason == .doneUnchecked else {
            return decision
        }
        switch await advisor.uiDecision(for: context) {
        case .none:
            return decision
        case let .continueWith(detail):
            return .continueWith(.uiUnchecked, detail: detail)
        case .stopFailing:
            return .finish(.checksFailing)
        }
    }
}

/// What the advisor needs to know about the workspace's web previews.
public struct PreviewVerifyEnvironment: Sendable {
    /// `autoVerify` for web: `.juno/launch.json`, else on.
    public var autoVerify: Bool
    /// Workspace-relative folders of the web configurations.
    public var webRoots: [String]
    /// Whether the session has a running preview the agent can use.
    public var hasLiveServer: Bool
    /// Compile or server errors the log showed after the last UI edit.
    public var serverErrorsSinceEdit: [String]

    public init(autoVerify: Bool, webRoots: [String], hasLiveServer: Bool, serverErrorsSinceEdit: [String] = []) {
        self.autoVerify = autoVerify
        self.webRoots = webRoots
        self.hasLiveServer = hasLiveServer
        self.serverErrorsSinceEdit = serverErrorsSinceEdit
    }
}

/// A session's verify state, fed synchronously by the session store's
/// observer so it is current when the stop check runs: the workspace
/// revision (one per `fileChanged`), the run's UI edits and its UI records.
public final class PreviewVerifyState: @unchecked Sendable {
    public let sessionID: CodeSessionID
    private let lock = NSLock()
    private var revision = 0
    /// Each path changed this run, with the revision and time of its latest
    /// change.
    private var runChanges: [String: (revision: Int, at: Date)] = [:]
    private var runStartedAt: Date?
    private var records: [UIVerificationRecord] = []
    private var lastCheckedRoutes: [String] = []
    private var runIndex = 0
    private let environment: @Sendable () async -> PreviewVerifyEnvironment

    public init(sessionID: CodeSessionID, environment: @escaping @Sendable () async -> PreviewVerifyEnvironment) {
        self.sessionID = sessionID
        self.environment = environment
    }

    /// The workspace revision: `fileChanged` events seen so far.
    public var workspaceRevision: Int {
        lock.withLock { revision }
    }

    /// Bumped by every reader message, which starts a new run.
    public var currentRun: Int {
        lock.withLock { runIndex }
    }

    public var runRecords: [UIVerificationRecord] {
        lock.withLock { records }
    }

    public var runChangedFiles: [String] {
        lock.withLock { runChanges.keys.sorted() }
    }

    /// Replays a transcript (a session reopened after relaunch).
    public func replay(_ events: [SessionEvent]) {
        for event in events { observe(event.payload) }
    }

    /// One transcript event, as it is appended.
    public func observe(_ payload: SessionEventPayload) {
        lock.withLock {
            switch payload {
            case let .fileChanged(change):
                revision += 1
                runChanges[change.path.value] = (revision, Date())
            case .userPrompt:
                runIndex += 1
                runChanges.removeAll()
                records.removeAll()
                runStartedAt = Date()
            case let .uiVerificationRecorded(record):
                records.append(record)
                if record.surface == .web, !lastCheckedRoutes.contains(record.target) {
                    lastCheckedRoutes.append(record.target)
                    if lastCheckedRoutes.count > 4 { lastCheckedRoutes.removeFirst() }
                }
            default:
                break
            }
        }
    }

    /// The UI edits among `paths` (or this run's changes) under `webRoots`.
    public func uiEdits(webRoots: [String], in paths: Set<String>? = nil) -> [String] {
        let changed: [String] = lock.withLock { Array(runChanges.keys) }
        let candidates = paths.map { Array($0) } ?? changed
        return Array(Set(candidates.filter { PreviewUIEdits.isUIEdit($0, webRoots: webRoots) })).sorted()
    }

    /// The revision of the latest change to any of `paths` this run.
    func lastRevision(of paths: [String]) -> Int? {
        lock.withLock { paths.compactMap { runChanges[$0]?.revision }.max() }
    }

    /// Where "new" starts for console and server errors (§4.6 step 1): the
    /// latest UI edit of the run, else the run's start. Errors from before an
    /// edit belong to the old code, so a fixed error stops counting and a
    /// repeated one counts again. Recorded as the edit is appended, so no
    /// later action can race it.
    public func errorBaseline(webRoots: [String]) -> Date? {
        lock.withLock {
            let edits = runChanges.filter { PreviewUIEdits.isUIEdit($0.key, webRoots: webRoots) }
            return edits.values.map(\.at).max() ?? runStartedAt
        }
    }

    /// Rule 8 for the web surface (§1.4, §4.6).
    public func decide(for context: CompletionGateContext) async -> PreviewUIDecision {
        let environment = await environment()
        guard environment.autoVerify, !environment.webRoots.isEmpty else { return .none }
        let edits = uiEdits(webRoots: environment.webRoots, in: context.filesChanged)
        guard !edits.isEmpty else { return .none }
        let (currentRevision, records, checked) = lock.withLock { (revision, self.records, lastCheckedRoutes) }
        // UI evidence is fresh when it was made at or after the last UI edit:
        // an edit to a test file later does not change what the page shows.
        let since = lastRevision(of: edits) ?? currentRevision
        let fresh = records.filter { $0.workspaceRevision >= since && $0.surface == .web }
        if fresh.contains(where: \.passed) { return .none }
        if PreviewVerifyPolicy.repeatsFailure(records) { return .stopFailing }
        let rounds = context.continuations.filter { $0 == .uiUnchecked }.count
        let latestFailure = fresh.last(where: { !$0.passed })
        if rounds >= PreviewVerifyPolicy.maximumRounds {
            return latestFailure == nil ? .none : .stopFailing
        }
        let routes = PreviewUIEdits.affectedRoutes(for: edits, webRoots: environment.webRoots, fallback: checked)
        return .continueWith(Self.note(
            edits: edits,
            routes: routes,
            failure: latestFailure,
            hasLiveServer: environment.hasLiveServer,
            serverErrors: environment.serverErrorsSinceEdit
        ))
    }

    /// The runtime note, imperative, naming the concrete facts, under 600
    /// characters.
    static func note(
        edits: [String],
        routes: [String],
        failure: UIVerificationRecord?,
        hasLiveServer: Bool,
        serverErrors: [String]
    ) -> String {
        let routeList = routes.joined(separator: ", ")
        let files = edits.prefix(3).map { ($0 as NSString).lastPathComponent }.joined(separator: ", ")
            + (edits.count > 3 ? " and \(edits.count - 3) more" : "")
        var text: String
        if let failure {
            let reasons = failure.checks.filter { !$0.passed }.map { check in
                check.detail.map { "\(check.name): \($0)" } ?? check.name
            }.joined(separator: "; ")
            text = "Before finishing: the preview check of \(failure.target) failed (\(reasons)). Fix it, then check \(routeList) again with preview_browser and take a screenshot, or stop and say exactly why it cannot pass."
        } else {
            let start = hasLiveServer ? "" : "Start the preview with preview_server start, then "
            text = "Before finishing: you changed UI files (\(files)) and the running page has not been checked since. \(start)\(hasLiveServer ? "Use" : "use") preview_browser on \(routeList): interact with what changed and take a screenshot, at desktop and phone width when layout changed. Juno records the result."
        }
        if let error = serverErrors.last {
            text += " The server log shows: \(String(error.prefix(160)))"
        }
        if text.count > 590 { text = String(text.prefix(589)) + "…" }
        return text
    }
}

extension PreviewVerifyState: PreviewUIVerifyAdvising {
    public func uiDecision(for context: CompletionGateContext) async -> PreviewUIDecision {
        await decide(for: context)
    }
}
