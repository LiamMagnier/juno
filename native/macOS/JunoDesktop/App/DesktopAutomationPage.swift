import AppKit
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// What the automation pages need from outside the model: the Macs, the
/// models a run may use, the folders a Mac has shared, and the way into a
/// conversation. One value, so the Chat window and the Work window build the
/// same pages from the same parts.
struct DesktopAutomationContext {
    let model: NativeWorkAutomationModel
    var hostsModel: NativeWorkHostsModel?
    /// The Macs as the Work model last read them, when there is no hosts
    /// model.
    var fallbackHosts: [WorkHostSummary]?
    var modelOptions: [NativeChatModelOption] = []
    var conversationForSession: (String) -> String? = { _ in nil }
    var openConversation: (String) -> Void = { _ in }

    @MainActor
    var hosts: [WorkHostSummary]? {
        if let hostsModel, hostsModel.phase == .ready { return hostsModel.hosts }
        return fallbackHosts
    }

    @MainActor
    func grants(_ hostID: String) -> [NativeWorkHostGrant]? {
        hostsModel?.details[hostID]?.grants
    }

    @MainActor
    func loadGrants(_ hostID: String) {
        guard let hostsModel else { return }
        Task { await hostsModel.loadHost(id: hostID) }
    }

    /// The web's page for an automation, where a Code automation is edited.
    static func webURL(for scheduleID: String) -> URL? {
        URL(string: JunoBackend.productionURLString)?
            .appendingPathComponent("automations")
            .appendingPathComponent(scheduleID)
    }
}

/// The page a route pushes for an automation: the automation itself, or a
/// new one.
struct DesktopAutomationRoutePage: View {
    let route: DesktopPageRoute
    let context: DesktopAutomationContext

    var body: some View {
        switch route {
        case .automation(let id):
            DesktopAutomationPage(scheduleID: id, context: context)
                .id(id)
        default:
            DesktopNewAutomationPage(context: context)
        }
    }
}

// MARK: - New automation

/// **New automation** (`/automations/new`): a reading-measure page with the
/// editor, which on save becomes the automation's own page.
struct DesktopNewAutomationPage: View {
    let context: DesktopAutomationContext

    @Environment(\.desktopReplace) private var replace
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        JunoPage(measure: .reading) {
            JunoPageHeader(
                "New automation",
                caption: "Automations",
                lede: "Say what should happen, when it should start, and what Alevr may do about it while you are not there."
            )
        } content: {
            DesktopAutomationEditor(
                schedule: nil,
                hosts: context.hosts,
                modelOptions: context.modelOptions,
                grants: context.grants,
                loadGrants: context.loadGrants,
                save: create,
                cancel: { dismiss() }
            )
        }
        .navigationTitle("New automation")
        .task { await context.hostsModel?.refresh() }
        .accessibilityIdentifier("juno.desktop.automation.new")
    }

    private func create(_ draft: NativeWorkScheduleDraft) async -> String? {
        switch await context.model.createReporting(draft) {
        case .done(let schedule, _):
            replace(.automation(schedule.id))
            return nil
        case .refused(let sentence):
            return sentence
        case .failed(let offline):
            return DesktopAutomationPage.saveFailure(offline: offline)
        }
    }
}

// MARK: - One automation

/// **An automation** (`/automations/{id}`): what it does, and what it has
/// actually done. The editor, then — when it has the "Something calls it"
/// trigger — the fire card, then Recent runs.
struct DesktopAutomationPage: View {
    let scheduleID: String
    let context: DesktopAutomationContext

    @Environment(\.junoToast) private var toast
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var loadFailed = false
    @State private var refreshingRuns = false
    @State private var confirmation: JunoConfirmation?

    private var model: NativeWorkAutomationModel { context.model }
    private var schedule: NativeWorkSchedule? { model.schedule(id: scheduleID) }

    var body: some View {
        page
            .junoConfirmation($confirmation)
            .navigationTitle(schedule?.name ?? "Automation")
            .task(id: scheduleID) { await load() }
            .accessibilityIdentifier("juno.desktop.automation.page")
    }

    @ViewBuilder
    private var page: some View {
        if let schedule {
            loaded(schedule)
        } else if model.missingIDs.contains(scheduleID) {
            frame("Automation not found") {
                DesktopWorkNote(.error, "This automation no longer exists. It may have been deleted from another device.")
            }
        } else if loadFailed {
            frame("Automation") {
                JunoEmptyState(
                    title: "Couldn’t load this automation",
                    message: "Nothing has been changed by the attempt, and it is still running to whatever clock it was set to.",
                    icon: .error,
                    actionLabel: "Try again",
                    action: { Task { await load() } },
                    size: .panel,
                    tone: .error
                )
            }
        } else {
            frame("Automation") {
                VStack(spacing: JunoSpace.cozy) {
                    ForEach(0..<4, id: \.self) { _ in
                        JunoSkeleton(height: 64, cornerRadius: JunoRadius.card)
                    }
                }
                .accessibilityLabel("Loading")
            }
        }
    }

    /// The frame every state shares, so the header is in one place in all
    /// four and nothing steps sideways when the automation resolves.
    private func frame<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        JunoPage(measure: .reading) {
            JunoPageHeader(title, caption: "Automations")
        } content: {
            content()
        }
    }

    private func loaded(_ schedule: NativeWorkSchedule) -> some View {
        JunoPage(measure: .reading) {
            JunoPageHeader(
                schedule.name,
                caption: "Automations",
                lede: schedule.enabled ? nil : "Paused. Nothing new will start until you resume it."
            ) {
                Button(action: runNow) {
                    HStack(spacing: JunoSpace.tight) {
                        if busy {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 14, height: 14)
                        } else {
                            JunoIconView(.play, size: 14)
                        }
                        Text("Run now")
                    }
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .disabled(busy)
                .help("Start one extra run now")
                .accessibilityIdentifier("juno.desktop.automation.run-now")
                Button(role: .destructive, action: confirmDelete) {
                    Label("Delete", icon: .trash)
                }
                .buttonStyle(.bordered)
                .tint(Color.junoDestructive)
                .disabled(busy)
                .accessibilityIdentifier("juno.desktop.automation.delete")
            }
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.region) {
                DesktopAutomationEditor(
                    schedule: schedule,
                    hosts: context.hosts,
                    modelOptions: context.modelOptions,
                    grants: context.grants,
                    loadGrants: context.loadGrants,
                    webURL: DesktopAutomationContext.webURL(for: schedule.id),
                    save: { draft in await save(schedule.id, draft) },
                    cancel: { dismiss() }
                )
                // Re-seeded whenever the saved row changes, so the form shows
                // what the server stored rather than what was typed at it.
                .id(schedule.updatedAt)

                if schedule.triggers.contains(where: { $0.kind == "api" }) {
                    DesktopAutomationFireCard(schedule: schedule, model: model)
                        .id(schedule.id)
                }

                recentRuns
            }
        }
    }

    // MARK: Recent runs

    private var recentRuns: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .lastTextBaseline) {
                DesktopWorkSectionHeading("Recent runs")
                Button {
                    Task {
                        refreshingRuns = true
                        await model.loadHistory(for: scheduleID)
                        refreshingRuns = false
                    }
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        if refreshingRuns {
                            ProgressView()
                                .controlSize(.mini)
                                .frame(width: 12, height: 12)
                        } else {
                            JunoIconView(.refresh, size: 12)
                        }
                        Text("Refresh")
                    }
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(height: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Read this automation’s history again")
                .accessibilityLabel("Refresh recent runs")
            }
            runsContent
        }
    }

    private var historyRows: [DesktopAutomationHistoryRow] {
        guard model.historyScheduleID == scheduleID, let history = model.history else { return [] }
        return DesktopAutomationHistoryRow.rows(history, conversationForSession: context.conversationForSession)
    }

    @ViewBuilder
    private var runsContent: some View {
        if model.historyScheduleID == scheduleID, model.historyFailed, model.history == nil {
            JunoEmptyState(
                title: "Couldn’t read the history",
                message: "This automation’s history couldn’t be read just now, which says nothing about whether it has run.",
                icon: .error,
                size: .panel,
                tone: .error
            )
        } else if model.historyScheduleID != scheduleID {
            DesktopWorkSkeletonRows(count: 2)
        } else if historyRows.isEmpty {
            JunoEmptyState(
                title: "No runs yet",
                message: "It has not run yet. Skipped fires (a Mac that was away, a budget that was spent) appear here too, so an empty list means nothing has fired at all.",
                icon: .history,
                size: .panel
            )
        } else {
            DesktopWorkRowList(items: historyRows) { row, _ in
                DesktopAutomationRunRow(row: row, open: context.openConversation)
            }
        }
    }

    // MARK: Actions

    private func load() async {
        loadFailed = false
        if model.schedule(id: scheduleID) == nil {
            let found = await model.loadSchedule(id: scheduleID)
            if !found, !model.missingIDs.contains(scheduleID) { loadFailed = true }
        }
        await model.loadHistory(for: scheduleID)
    }

    private func save(_ id: String, _ draft: NativeWorkScheduleDraft) async -> String? {
        switch await model.saveReporting(id: id, draft: draft) {
        case .done(_, let notes):
            // The server's sentences about what the change did to fires
            // already queued, when it wrote any; nothing of the Mac's own.
            if !notes.isEmpty { toast(.success(notes.joined(separator: " "))) }
            await model.loadHistory(for: id)
            return nil
        case .refused(let sentence):
            return sentence
        case .failed(let offline):
            return Self.saveFailure(offline: offline)
        }
    }

    static func saveFailure(offline: Bool) -> String {
        offline
            ? "Couldn’t reach Alevr to save this. Nothing was changed."
            : "Couldn’t save this schedule. Nothing was changed."
    }

    private func runNow() {
        busy = true
        Task {
            let result = await model.runNowReporting(id: scheduleID)
            busy = false
            switch result {
            case .done:
                toast(.success("Started. This run is extra, and the automation still fires when it was going to."))
                await model.loadHistory(for: scheduleID)
            case .refused(let sentence):
                toast(.error(sentence))
            case .failed:
                toast(.error("Couldn’t start this. Nothing was queued, so trying again is safe."))
            }
        }
    }

    private func confirmDelete() {
        guard let schedule else { return }
        confirmation = DesktopAutomationToasts.deleteConfirmation(for: schedule) {
            busy = true
            Task {
                let result = await model.deleteReporting(id: scheduleID)
                busy = false
                toast(DesktopAutomationToasts.deleted(result))
                if case .done = result { dismiss() }
            }
        }
    }
}

// MARK: - History

/// One line of an automation's history, whichever kind of run produced it:
/// the two lists interleaved by time, newest first, as the web does.
struct DesktopAutomationHistoryRow: Identifiable, Equatable {
    let id: String
    let status: String
    let label: String
    let origin: String
    let createdAt: Date?
    /// The conversation it opens, when this Mac knows it.
    let conversationID: String?

    static func rows(
        _ history: NativeWorkScheduleHistory,
        conversationForSession: (String) -> String?
    ) -> [DesktopAutomationHistoryRow] {
        let work = history.runs.map { run in
            DesktopAutomationHistoryRow(
                id: run.id,
                status: run.status,
                label: run.terminalDetail ?? "Attempt \(run.attempt)",
                origin: run.origin,
                createdAt: run.createdAt,
                conversationID: conversationForSession(run.sessionID)
            )
        }
        let code = history.codeRuns.map { run in
            DesktopAutomationHistoryRow(
                id: run.id,
                status: NativeWorkScheduleCopy.workStatus(forCodeTask: run.status),
                label: run.pullRequestURL ?? run.branch ?? run.title,
                origin: "code",
                createdAt: run.createdAt,
                conversationID: run.conversationID
            )
        }
        return (work + code).sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }
}

/// A run: its status in words, what it was, and where it came from and when.
/// It opens its conversation when there is one to open.
struct DesktopAutomationRunRow: View {
    let row: DesktopAutomationHistoryRow
    let open: (String) -> Void

    @State private var isHovering = false

    private var meta: String {
        [row.origin, row.createdAt.map { NativeWorkScheduleCopy.timeAgo($0) }]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    var body: some View {
        Button {
            if let conversationID = row.conversationID { open(conversationID) }
        } label: {
            HStack(spacing: JunoSpace.close) {
                DesktopRunStatusPill(status: row.status)
                Text(row.label)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(meta)
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .fixedSize()
                if row.conversationID != nil {
                    JunoIconView(.chevronRight, size: 13)
                        .foregroundStyle(Color.junoMutedForeground)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.close)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(row.conversationID == nil)
        .modifier(DesktopWorkRowSurface(isHovering: isHovering && row.conversationID != nil))
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityHint(row.conversationID == nil ? "" : "Opens its conversation")
    }
}

// MARK: - The fire card

/// "Firing this from elsewhere" (`ScheduleFireCard`): only when the
/// automation has the "Something calls it" trigger. The URL is always
/// readable; the token is shown once, when it is issued, and never again.
struct DesktopAutomationFireCard: View {
    let schedule: NativeWorkSchedule
    let model: NativeWorkAutomationModel

    @Environment(\.junoToast) private var toast
    @State private var busy = false
    @State private var issued: NativeWorkFireToken?
    @State private var hasToken: Bool
    @State private var issuedAt: Date?

    init(schedule: NativeWorkSchedule, model: NativeWorkAutomationModel) {
        self.schedule = schedule
        self.model = model
        _hasToken = State(initialValue: schedule.hasFireToken)
        _issuedAt = State(initialValue: schedule.fireTokenIssuedAt)
    }

    private var tokenSentence: String {
        guard hasToken else { return "No token yet, so nothing outside Alevr can start this." }
        if let issuedAt {
            return "A token was issued on \(issuedAt.formatted(date: .numeric, time: .omitted)). Issuing another stops it working."
        }
        return "This automation has a token. Issuing another stops it working."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
            Text("Firing this from elsewhere")
                .junoType(JunoType.ui.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text("A POST to this URL, carrying the token as a bearer header, starts one run. It does not move the schedule: whatever this automation was going to do next, it still does.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            codeBlock("POST /api/work/schedules/\(schedule.id)/fire\nAuthorization: Bearer <token>\n{ \"text\": \"optional\" }")
            if let issued {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    DesktopWorkNote(.warning, "Copy this now. It is stored only as a hash, so this is the one time it can be shown — issuing another replaces it.")
                    codeBlock(issued.token)
                }
                .transition(.opacity)
            }
            Text(tokenSentence)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
            Text("Text sent with a fire reaches the run as data from an untrusted source, after the instructions and marked as something to read rather than obey — and only when this automation’s API trigger is set to accept it.")
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: JunoSpace.snug) {
                Button(action: issue) {
                    HStack(spacing: JunoSpace.tight) {
                        if busy {
                            ProgressView().controlSize(.small)
                        }
                        Text(hasToken ? "Issue a new token" : "Issue a token")
                    }
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .disabled(busy)
                if hasToken {
                    Button("Revoke", action: revoke)
                        .buttonStyle(.borderless)
                        .disabled(busy)
                }
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.comfy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .junoCard(cornerRadius: JunoRadius.card)
    }

    /// A tonal band, square inside the card's padding (outer 16 minus a 16
    /// gutter leaves nothing to round), in mono because it is code.
    private func codeBlock(_ text: String) -> some View {
        Text(text)
            .junoType(.micro)
            .foregroundStyle(Color.junoForeground)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.junoSecondary)
    }

    private func issue() {
        busy = true
        Task {
            let result = await model.issueFireToken(id: schedule.id)
            busy = false
            switch result {
            case .done(let token, _):
                withAnimation(JunoMotion.base) { issued = token }
                hasToken = true
                issuedAt = token.issuedAt
            case .refused(let sentence):
                toast(.error(sentence))
            case .failed:
                toast(.error("Couldn’t issue a token. Whatever token this automation had still works."))
            }
        }
    }

    private func revoke() {
        busy = true
        Task {
            let result = await model.revokeFireToken(id: schedule.id)
            busy = false
            switch result {
            case .done:
                issued = nil
                hasToken = false
                issuedAt = nil
                toast(.success("Revoked. Anything still calling with that token now gets a 401."))
            case .refused, .failed:
                toast(.error("Couldn’t revoke the token. It is still working."))
            }
        }
    }
}
