import Foundation
import JunoCore

/// The web's words for automations, verbatim, in one place both the Mac's
/// pages and their tests read.
///
/// Every string here is copied from the web and named after where it lives
/// there (`work-triggers.tsx`, `work-schedule-editor.tsx`,
/// `work-schedule-row.tsx`, `schedules/arming-card.tsx`). The Mac changes
/// capitalisation only in menus, never the words.
public enum NativeWorkScheduleCopy {
    // MARK: - Triggers (`work-triggers.tsx` TRIGGER_META)

    /// One kind of trigger: its label in the Add menu and on its row, and the
    /// hint under the label.
    public struct TriggerKind: Equatable, Sendable, Identifiable {
        public let kind: String
        public let label: String
        public let hint: String
        public var id: String { kind }

        public init(kind: String, label: String, hint: String) {
            self.kind = kind
            self.label = label
            self.hint = hint
        }
    }

    /// "On a clock", in the web's order (`TIME_TRIGGER_KINDS`).
    public static let clockKinds: [TriggerKind] = [
        TriggerKind(kind: "once", label: "Once", hint: "One date and time, then never again."),
        TriggerKind(kind: "hourly", label: "Hourly", hint: "Every hour, at the minute you choose."),
        TriggerKind(kind: "daily", label: "Daily", hint: "Every day at one time."),
        TriggerKind(kind: "weekdays", label: "Weekdays", hint: "Monday to Friday at one time."),
        TriggerKind(kind: "weekly", label: "Weekly", hint: "One day of the week, at one time."),
        TriggerKind(
            kind: "monthly", label: "Monthly",
            hint: "One day of the month. The 31st means the last day of a short one."
        ),
        TriggerKind(kind: "yearly", label: "Yearly", hint: "One date each year."),
        TriggerKind(
            kind: "cron", label: "Cron",
            hint: "A five-field crontab line, for anything the others cannot say."
        ),
    ]

    /// "On something happening", in the web's order (`WORK_TRIGGER_KINDS`
    /// less the clock kinds).
    public static let eventKinds: [TriggerKind] = [
        TriggerKind(
            kind: "email_filter", label: "An email arrives",
            hint: "Matched on sender, subject, labels and attachments."
        ),
        TriggerKind(
            kind: "calendar_window", label: "A meeting is coming up",
            hint: "Fires a set number of minutes before it starts."
        ),
        TriggerKind(
            kind: "topic_monitor", label: "A topic is mentioned",
            hint: "Fires when enough sources mention your terms."
        ),
        TriggerKind(
            kind: "connector_event", label: "A connected app sends an event",
            hint: "Named connector, named events."
        ),
        TriggerKind(
            kind: "folder_change", label: "A folder changes",
            hint: "Watches a folder you granted on one of your Macs."
        ),
        TriggerKind(kind: "manual", label: "Only when you press Run", hint: "Nothing starts this on its own."),
        TriggerKind(
            kind: "api", label: "Something calls it",
            hint: "A request to this automation's fire URL, carrying the token you issue for it."
        ),
    ]

    public static let allKinds: [TriggerKind] = clockKinds + eventKinds

    public static func isClockKind(_ kind: String) -> Bool {
        clockKinds.contains { $0.kind == kind }
    }

    /// The label for a kind, or the kind itself for one a newer server added.
    public static func triggerLabel(_ kind: String) -> String {
        allKinds.first { $0.kind == kind }?.label ?? kind
    }

    /// A new trigger's configuration (`defaultTriggerConfig`).
    public static func defaultConfig(
        for kind: String,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [String: JunoJSONValue] {
        switch kind {
        case "once":
            let parts = calendar.dateComponents([.year, .month, .day], from: now)
            return [
                "year": .number(Double(parts.year ?? 2026)),
                "month": .number(Double(parts.month ?? 1)),
                "day": .number(Double(parts.day ?? 1)),
                "hour": .number(9),
                "minute": .number(0),
            ]
        case "hourly": return ["minute": .number(0)]
        case "daily", "weekdays": return ["hour": .number(9), "minute": .number(0)]
        case "weekly": return ["weekday": .number(1), "hour": .number(9), "minute": .number(0)]
        case "monthly": return ["monthday": .number(1), "hour": .number(9), "minute": .number(0)]
        case "yearly":
            return ["month": .number(1), "monthday": .number(1), "hour": .number(9), "minute": .number(0)]
        case "cron": return ["expression": .string("0 9 * * 1-5")]
        case "email_filter":
            return [
                "from": .array([]), "excludeFrom": .array([]), "subjectContains": .array([]),
                "excludeSubjectContains": .array([]), "labels": .array([]),
                "requireAttachment": .bool(false),
            ]
        case "calendar_window":
            return [
                "leadMinutes": .number(10), "calendarIds": .array([]), "titleContains": .array([]),
                "minDurationMinutes": .number(0), "requireAttendees": .bool(false),
            ]
        case "topic_monitor":
            return ["terms": .array([]), "requireAll": .bool(false), "minSources": .number(1)]
        case "connector_event":
            return ["connector": .string(""), "events": .array([]), "attributes": .object([:])]
        case "folder_change":
            return ["grantId": .string(""), "suffixes": .array([]), "minChangedFiles": .number(1)]
        case "api": return ["acceptsText": .bool(false)]
        default: return [:]
        }
    }

    public static let weekdayNames = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ]
    public static let monthNames = [
        "January", "February", "March", "April", "May", "June", "July", "August",
        "September", "October", "November", "December",
    ]

    /// One trigger as a sentence (`describeTrigger`).
    public static func describe(kind: String, config: [String: JunoJSONValue]) -> String {
        func int(_ key: String, _ fallback: Int) -> Int {
            guard let value = config[key]?.numberValue, value.isFinite else { return fallback }
            return Int(value)
        }
        func text(_ key: String) -> String { config[key]?.stringValue ?? "" }
        func list(_ key: String) -> String {
            guard case .array(let values)? = config[key] else { return "" }
            return values.compactMap(\.stringValue).joined(separator: ", ")
        }
        func clock() -> String { String(format: "%02d:%02d", int("hour", 0), int("minute", 0)) }
        func month(_ number: Int) -> String {
            monthNames.indices.contains(number - 1) ? monthNames[number - 1] : ""
        }

        switch kind {
        case "once":
            return "Once, on \(int("day", 1)) \(month(int("month", 1))) \(int("year", 0)) at \(clock())"
        case "hourly":
            return "Every hour at \(String(format: "%02d", int("minute", 0))) past"
        case "daily": return "Every day at \(clock())"
        case "weekdays": return "Every weekday at \(clock())"
        case "weekly":
            let day = int("weekday", 0)
            let name = weekdayNames.indices.contains(day) ? weekdayNames[day] : "week"
            return "Every \(name) at \(clock())"
        case "monthly": return "On day \(int("monthday", 1)) of each month at \(clock())"
        case "yearly": return "Every \(int("monthday", 1)) \(month(int("month", 1))) at \(clock())"
        case "cron":
            let expression = text("expression")
            return "Cron: \(expression.isEmpty ? "not set" : expression)"
        case "email_filter":
            let from = list("from")
            return from.isEmpty ? "When any email arrives" : "When an email arrives from \(from)"
        case "calendar_window": return "\(int("leadMinutes", 10)) minutes before a meeting starts"
        case "topic_monitor":
            let terms = list("terms")
            return terms.isEmpty ? "When a topic is mentioned" : "When sources mention \(terms)"
        case "connector_event":
            let connector = text("connector")
            return connector.isEmpty
                ? "When a connected app sends an event" : "When \(connector) sends an event"
        case "folder_change": return "When a granted folder changes"
        case "manual": return "Only when you press Run now"
        case "api":
            return config["acceptsText"]?.boolValue == true
                ? "When something calls the fire URL, with text for the run to read"
                : "When something calls the fire URL"
        default: return kind
        }
    }

    public static func describe(_ trigger: NativeWorkScheduleTrigger) -> String {
        describe(kind: trigger.kind, config: trigger.config)
    }

    public static func describe(_ trigger: NativeWorkScheduleTriggerDraft) -> String {
        describe(kind: trigger.kind, config: trigger.config)
    }

    /// Options a trigger's source cannot answer (`TRIGGER_OPTION_LIMITS`).
    public static func optionLimit(kind: String, field: String) -> String? {
        switch (kind, field) {
        case ("email_filter", "labels"):
            "Juno's mail reader sees the sender, the subject and the date of a message, and not its labels. A trigger that requires a label would never match anything."
        case ("email_filter", "requireAttachment"):
            "Juno's mail reader cannot tell whether a message has an attachment without downloading it. A trigger that requires one would never match anything."
        case ("calendar_window", "requireAttendees"):
            "Juno's calendar reader sees the title, the times and the calendar of an event, and not who was invited. A trigger that skips meetings with no other attendees would skip every meeting."
        default: nil
        }
    }

    // MARK: - Policies (`work-schedule-editor.tsx`)

    /// One radio row: the wire value, the web's label and the sentence under it.
    public struct PolicyOption: Equatable, Sendable, Identifiable {
        public let value: String
        public let label: String
        public let hint: String
        public var id: String { value }

        public init(value: String, label: String, hint: String) {
            self.value = value
            self.label = label
            self.hint = hint
        }
    }

    /// "Something it cannot undo".
    public static let unattendedOptions: [PolicyOption] = [
        PolicyOption(
            value: "pause_for_approval", label: "Stop and wait for me",
            hint: "The run parks and asks. Nothing irreversible happens until you answer."
        ),
        PolicyOption(
            value: "skip_irreversible", label: "Do the rest, and say what it skipped",
            hint: "Everything reversible gets done; the rest is reported rather than attempted."
        ),
        PolicyOption(
            value: "disallow_irreversible", label: "Treat it as a failure",
            hint: "The attempt ends the moment it needs something it cannot do unattended."
        ),
    ]

    /// "The Mac is not there".
    public static let hostOfflineOptions: [PolicyOption] = [
        PolicyOption(value: "wait", label: "Wait for the Mac", hint: "The fire is held until the Mac checks in again."),
        PolicyOption(
            value: "skip", label: "Skip this one",
            hint: "The fire is recorded as skipped and the schedule carries on."
        ),
        PolicyOption(
            value: "cloud_subset", label: "Do the cloud part",
            hint: "Runs what does not need the Mac, and reports the part that does."
        ),
    ]

    /// "Fires that were missed".
    public static let missedRunOptions: [PolicyOption] = [
        PolicyOption(value: "skip", label: "Let them go", hint: "Fires missed while Juno was down are not caught up."),
        PolicyOption(value: "run_once", label: "Catch up once", hint: "One run covers everything that was missed."),
        PolicyOption(
            value: "run_all", label: "Run every one",
            hint: "One run per missed fire. A weekend down is a Monday queue."
        ),
    ]

    /// "Tell me".
    public static let notifyOptions: [PolicyOption] = [
        PolicyOption(
            value: "none", label: "Never",
            hint: "No email, with one exception: a run that is stuck waiting for you still writes, or it waits for ever."
        ),
        PolicyOption(
            value: "on_attention", label: "Only when it needs me",
            hint: "One email when a run has a question, wants an approval, or lost the Mac it needed. Nothing when it just finishes."
        ),
        PolicyOption(
            value: "on_finish", label: "When it finishes",
            hint: "One email per run that ends, however it ended — plus the stuck-run exception above."
        ),
        PolicyOption(
            value: "all", label: "Everything",
            hint: "Both of the above. On an hourly schedule that is an email an hour."
        ),
    ]

    /// A stored value the options know, or the web's fallback (`oneOf`).
    public static func known(_ value: String, in options: [PolicyOption], fallback: String) -> String {
        options.contains { $0.value == value } ? value : fallback
    }

    // MARK: - The list row (`work-schedule-row.tsx`)

    /// What the schedule will send, in three words, or nil for a Code
    /// automation or an unknown policy.
    public static func notifySentence(_ policy: String) -> String? {
        switch policy {
        case "none": "No email unless a run gets stuck"
        case "on_attention": "Emails when it needs you"
        case "on_finish": "Emails on every run"
        case "all": "Emails on everything"
        default: nil
        }
    }

    /// When it fires next, as a sentence (`nextFireSentence`), in the reader's
    /// own locale and zone.
    public static func nextFireSentence(
        _ schedule: NativeWorkSchedule,
        locale: Locale = .current,
        timeZone: TimeZone = .current
    ) -> String {
        guard let next = schedule.nextRunAt else {
            return schedule.enabled
                ? "Runs when its trigger fires"
                : "Paused"
        }
        let formatted = formattedFire(next, locale: locale, timeZone: timeZone)
        return schedule.enabled ? "Next: \(formatted)" : "Paused. Would have run \(formatted)"
    }

    /// `weekday: short, day, month: short, hour, minute` — "Mon 29 Sept, 09:00".
    public static func formattedFire(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let style = Date.FormatStyle(locale: locale, timeZone: timeZone)
            .weekday(.abbreviated)
            .day()
            .month(.abbreviated)
            .hour(.twoDigits(amPM: .abbreviated))
            .minute(.twoDigits)
        return date.formatted(style)
    }

    /// The web's `workTimeAgo`: "just now", "5m ago", "3h ago", "yesterday",
    /// "4d ago", "2mo ago", "1y ago".
    public static func timeAgo(_ date: Date, now: Date = Date()) -> String {
        let diff = now.timeIntervalSince(date)
        if diff < 60 { return "just now" }
        let minutes = Int(diff / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days == 1 { return "yesterday" }
        if days < 30 { return "\(days)d ago" }
        let months = days / 30
        return months < 12 ? "\(months)mo ago" : "\(months / 12)y ago"
    }

    // MARK: - Run status (`work-vocabulary.tsx` STATUS_META)

    public enum StatusTone: Sendable, Equatable {
        case neutral, live, attention, good, bad
    }

    public static func statusLabel(_ status: String) -> String {
        switch status {
        case "draft": "Draft"
        case "queued": "Queued"
        case "preparing": "Preparing"
        case "running": "Running"
        case "waiting_input": "Needs an answer"
        case "waiting_approval": "Needs approval"
        case "paused": "Paused"
        case "completed": "Done"
        case "failed": "Failed"
        case "cancelled": "Cancelled"
        case "interrupted": "Interrupted"
        default: NativeWorkScheduleVocabulary.sentenceCase(status)
        }
    }

    public static func statusTone(_ status: String) -> StatusTone {
        switch status {
        case "running", "preparing": .live
        case "waiting_input", "waiting_approval": .attention
        case "completed": .good
        case "failed", "interrupted": .bad
        default: .neutral
        }
    }

    /// A Code task's status as a Work status (`workStatusForCodeTask`).
    public static func workStatus(forCodeTask status: String) -> String {
        switch status {
        case "queued": "queued"
        case "running": "running"
        case "awaiting_approval": "waiting_approval"
        case "done": "completed"
        case "cancelled": "cancelled"
        default: "failed"
        }
    }

    // MARK: - The arming card (`schedules/arming-card.tsx`)

    public static func armingTarget(target: JunoWorkTarget, hostName: String?) -> String {
        switch target {
        case .cloud: return "Juno's cloud. It cannot reach anything on your Macs."
        case .local:
            return hostName.map { "\($0), and only that Mac." }
                ?? "One of your Macs — which one is not set yet."
        case .automatic:
            return hostName.map { "Wherever it fits, preferring \($0)." }
                ?? "Wherever it fits: a Mac when it needs one, the cloud otherwise."
        }
    }

    public static func armingUnattended(_ policy: String) -> String {
        switch policy {
        case "skip_irreversible":
            "If it meets something it cannot undo, it does everything else and tells you what it skipped."
        case "disallow_irreversible":
            "If it meets something it cannot undo, the whole run is treated as a failure."
        default:
            "If it meets something it cannot undo, it stops and waits for you."
        }
    }

    public static func armingOffline(_ policy: String, target: JunoWorkTarget) -> String {
        guard target != .cloud else { return "" }
        switch policy {
        case "wait": return "If the Mac is asleep it waits for it."
        case "cloud_subset": return "If the Mac is asleep it does the part that does not need one."
        default: return "If the Mac is asleep the run is skipped."
        }
    }

    // MARK: - Budget fields (`lib/work/budget.ts` ceilingFieldValue)

    /// An empty field is no ceiling (0); a number of zero or more is itself;
    /// anything else is nil, which the form refuses to save.
    public static func ceiling(_ field: String) -> Double? {
        let trimmed = field.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0 }
        guard let value = Double(trimmed), value.isFinite, value >= 0 else { return nil }
        return value
    }

    /// A stored ceiling as its field's text: empty for none.
    public static func ceilingField(_ value: Double) -> String {
        guard value > 0 else { return "" }
        return value.rounded() == value ? String(Int(value)) : String(value)
    }
}

// MARK: - Permissions (`lib/work/domain.ts`, `work-host-settings.tsx`)

public extension JunoWorkPermissionPolicy {
    /// `WORK_APPROVAL_MODE_LABEL`.
    var approvalModeLabel: String { agentAutonomyLabel }

    /// `WORK_APPROVAL_MODE_SUMMARY`, said of Juno.
    var approvalModeSummary: String {
        switch self {
        case .conservative:
            "Juno asks before it changes a file or runs anything. Reading and research go ahead."
        case .balanced:
            "Juno makes changes it can undo, and asks before running anything or touching anything private."
        case .permissive:
            "Juno gets on with the work without asking — except for the four things it cannot take back."
        }
    }

    /// `DEFAULT_WORK_PERMISSION_POLICY`.
    static let defaultPolicy: JunoWorkPermissionPolicy = .balanced
}

public enum NativeWorkPermissionsCopy {
    /// One action that always asks: the approval card's verb and what it acts on.
    public struct Floor: Equatable, Sendable, Identifiable {
        public let action: String
        public let verb: String
        public let object: String
        public var id: String { action }
    }

    /// `ALWAYS_CONFIRM_ACTIONS`, in the web's order, each with `actionVerb`'s
    /// verb and `describeFloorAction`'s words.
    public static let alwaysAsks: [Floor] = [
        Floor(action: "work.file.permanent_delete", verb: "Delete for good", object: "a file, permanently"),
        Floor(action: "work.file.empty_trash", verb: "Empty the trash", object: "your trash"),
        Floor(action: "work.app.purchase", verb: "Buy", object: "something in an app"),
        Floor(action: "work.browser.purchase", verb: "Buy", object: "something on a website"),
        Floor(action: "work.connector.send_message", verb: "Send", object: "a message, from your account"),
        Floor(action: "work.connector.publish", verb: "Post", object: "something publicly"),
        Floor(action: "work.connector.delete", verb: "Delete", object: "records in a connected app"),
        Floor(action: "work.connector.payment", verb: "Pay", object: "money, to somebody"),
        Floor(
            action: "work.system.change_security_setting", verb: "Change the setting",
            object: "a security setting"
        ),
        Floor(
            action: "work.system.change_account_setting", verb: "Change the setting",
            object: "an account setting"
        ),
    ]

    /// `HOST_STATE_LABEL`.
    public static func stateLabel(_ host: WorkHostSummary) -> String {
        if host.revokedAt != nil { return "Revoked" }
        switch host.state {
        case "online": return "Working"
        case "idle": return "Ready"
        case "stale": return "Not responding"
        default: return "Offline"
        }
    }

    /// `hostUnavailableReason`: the one sentence that explains a host's
    /// state, most final first, or nil when it is fine.
    public static func unavailableReason(_ host: WorkHostSummary) -> String? {
        if host.revokedAt != nil { return "Access to this Mac was revoked." }
        if !host.enabled { return "Juno Work is switched off on this Mac." }
        if host.state == "offline" { return "This Mac has not checked in for several minutes." }
        if host.state == "stale" { return "This Mac stopped checking in a minute ago." }
        return nil
    }

    /// `hostWorkloadSentence`, or nil when nothing is running or queued.
    public static func workloadSentence(_ host: WorkHostSummary) -> String? {
        var parts: [String] = []
        if host.activeRunCount > 0 {
            parts.append(host.activeRunCount == 1 ? "1 task running" : "\(host.activeRunCount) tasks running")
        }
        if host.queuedRunCount > 0 { parts.append("\(host.queuedRunCount) queued") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// `ACCESS_LABEL`.
    public static func accessLabel(_ mode: String) -> String {
        switch mode {
        case "read": "Read only"
        case "read_write_no_delete": "Read and change, nothing removed"
        case "read_write": "Read, change and remove"
        default: NativeWorkScheduleVocabulary.sentenceCase(mode)
        }
    }

    /// One capability switch on a host page (`CAPABILITY_TOGGLES`).
    public struct Toggle: Equatable, Sendable, Identifiable {
        public let key: NativeWorkHostToggle
        public let label: String
        public let detail: String
        public var id: NativeWorkHostToggle { key }
    }

    public static let master = Toggle(
        key: .enabled,
        label: "Juno Work on this Mac",
        detail: "The master switch. With it off, this Mac claims nothing at all — the five below stop applying, and a task that needs a real machine looks for another one."
    )

    public static let capabilities: [Toggle] = [
        Toggle(
            key: .allowsFileWork, label: "Files in the folders you have shared",
            detail: "Read and change files inside the folders listed below, and nowhere else on the disk. Each folder carries its own limit on writing and deleting."
        ),
        Toggle(
            key: .allowsBrowser, label: "Your signed-in browser",
            detail: "Use the browser profile on this Mac, with the sessions already signed in to it. Anything you are logged in to, a task can reach."
        ),
        Toggle(
            key: .allowsComputerUse, label: "Screen control",
            detail: "See the screen, click and type. This is also what lets Juno drive an app through its accessibility tree — the two ride one switch, because driving an app is screen control by another name."
        ),
        Toggle(
            key: .allowsShell, label: "Shell commands",
            detail: "Run commands in a terminal on this Mac. Intended for developer work, and the broadest thing on this list: a command can reach anything your account can."
        ),
        Toggle(
            key: .allowsBackground, label: "Keep working while you are away",
            detail: "Carry on with a task when you have walked away from this Mac and every other device is offline. Without it, unattended work waits for you."
        ),
    ]

    /// `describeCapability`: a capability key as a person says it.
    public static func describeCapability(_ capability: String) -> String {
        switch capability {
        case "local_files": "access to a folder on your Mac"
        case "local_apps": "control of an app on your Mac"
        case "local_browser": "your signed-in browser"
        case "local_computer_use": "screen control on your Mac"
        case "local_shell": "a shell on your Mac"
        case "web_research": "web research"
        case "connectors": "your connected apps"
        case "cloud_files": "files stored with Juno"
        case "deliverables": "document and spreadsheet creation"
        case "background_continuation": "running while your devices are offline"
        default: capability
        }
    }

    /// `hostCapabilities`: of what the Mac offered, what its switches let
    /// through. Nothing while its master switch is off.
    public static func grantedCapabilities(_ host: WorkHostSummary, offered: [String]) -> Set<String> {
        guard host.enabled else { return [] }
        let permitted: [String: Bool] = [
            "local_files": host.allows(.allowsFileWork),
            "local_browser": host.allows(.allowsBrowser),
            "local_computer_use": host.allows(.allowsComputerUse),
            "local_apps": host.allows(.allowsComputerUse),
            "local_shell": host.allows(.allowsShell),
            "background_continuation": host.allows(.allowsBackground),
        ]
        return Set(offered.filter { permitted[$0] != false })
    }

    /// `refusalSentence`: the switches the Mac has not offered, which stay off.
    public static func refusal(_ refused: [NativeWorkHostToggle]) -> String {
        let names = refused.map(\.noun)
        let list: String
        if names.count <= 1 {
            list = names.first ?? ""
        } else {
            list = names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
        }
        return "This Mac has not offered \(list), so it stays off. Switch it on in Juno on the Mac itself first."
    }
}
