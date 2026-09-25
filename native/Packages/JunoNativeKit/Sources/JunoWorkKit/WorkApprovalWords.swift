import Foundation
import JunoCore

/// What a task's approval card says, and which of them may be answered
/// together — the web's `approvals/action-verbs.ts`, `approval-card.tsx` and
/// `approval-queue.tsx`, word for word.
///
/// **The button never says "Approve".** It says the verb of the thing about to
/// happen — Send, Delete for good, Run it — so the decision is legible from the
/// control alone. The table is keyed on the executor's tool names and the
/// `work.<area>.<act>` action names, both of which arrive on real approvals.
///
/// Pure, and shared: the Mac's chat card draws it now, and the phone's and the
/// agent page's gate cards can read the same table when they are rebuilt.
public enum WorkApprovalWords {
    /// How the preview draws the thing being decided about.
    public enum BodyStyle: Equatable, Sendable {
        /// A message or a description, in the reading face.
        case prose
        /// A list of files or items, one per line.
        case paths
        /// A command — the one case that is code.
        case command
    }

    public struct Verb: Equatable, Sendable {
        /// The imperative on the button. Never "Approve".
        public let verb: String
        /// The detail keys holding what a person would read before deciding.
        public let bodyKeys: [String]?
        /// The detail keys naming who or what is on the receiving end.
        public let targetKeys: [String]?
        public let bodyStyle: BodyStyle

        init(_ verb: String, body: [String]?, target: [String]?, _ style: BodyStyle) {
            self.verb = verb
            self.bodyKeys = body
            self.targetKeys = target
            self.bodyStyle = style
        }
    }

    static let fallback = Verb("Go ahead", body: nil, target: nil, .prose)

    static let verbs: [String: Verb] = [
        // The always-confirm floor.
        "work.connector.send_message": Verb(
            "Send", body: ["body", "message", "text", "content"],
            target: ["to", "recipient", "recipients", "channel", "address"], .prose
        ),
        "work.connector.publish": Verb(
            "Post", body: ["body", "message", "text", "content"],
            target: ["to", "channel", "destination", "board"], .prose
        ),
        "work.connector.delete": Verb(
            "Delete", body: ["items", "records", "subject"], target: ["connector", "app", "collection"], .paths
        ),
        "work.connector.payment": Verb(
            "Pay", body: ["description", "summary"], target: ["payee", "to", "recipient"], .prose
        ),
        "work.file.permanent_delete": Verb(
            "Delete for good", body: ["paths", "files", "items"], target: nil, .paths
        ),
        "work.file.empty_trash": Verb("Empty the trash", body: ["items", "paths"], target: nil, .paths),
        "work.app.purchase": Verb(
            "Buy", body: ["description", "item", "summary"], target: ["vendor", "store", "app"], .prose
        ),
        "work.browser.purchase": Verb(
            "Buy", body: ["description", "item", "summary"], target: ["site", "vendor", "url"], .prose
        ),
        // Above the floor.
        "work.browser.submit": Verb(
            "Send the form", body: ["fields", "summary", "description"], target: ["url", "site", "page"], .prose
        ),
        "work.system.change_security_setting": Verb(
            "Change the setting", body: ["setting", "description", "summary"], target: ["scope", "device"], .prose
        ),
        "work.system.change_account_setting": Verb(
            "Change the setting", body: ["setting", "description", "summary"], target: ["account", "scope"], .prose
        ),
        // The executor's own tool names.
        "apply_changes": Verb("Make the changes", body: ["paths", "files", "changes"], target: nil, .paths),
        "permanently_delete": Verb("Delete for good", body: ["paths", "files", "items"], target: nil, .paths),
        "run_command": Verb(
            "Run it", body: ["command", "script", "argv"], target: ["cwd", "directory", "host"], .command
        ),
        "shell": Verb("Run it", body: ["command", "script", "argv"], target: ["cwd", "directory", "host"], .command),
        "browser_control": Verb(
            "Use the browser", body: ["url", "description", "summary"], target: ["site", "url"], .prose
        ),
        "app_control": Verb("Use the app", body: ["description", "summary"], target: ["app"], .prose),
        "screen_control": Verb("Take the screen", body: ["description", "summary"], target: ["app", "window"], .prose),
        "send_email": Verb("Send", body: ["body", "message", "text"], target: ["to", "recipient", "recipients"], .prose),
        "create_event": Verb(
            "Create the event", body: ["description", "summary", "title"], target: ["calendar", "attendees"], .prose
        ),
    ]

    /// The verb for an action, falling back to "Go ahead".
    public static func verb(for action: String) -> Verb {
        verbs[action] ?? fallback
    }

    /// The thing to read before deciding, or nil when this action has none —
    /// never an empty string that would look like a message with no words.
    public static func previewBody(_ detail: [String: JunoJSONValue], verb: Verb) -> String? {
        guard let keys = verb.bodyKeys else { return nil }
        if let direct = firstString(detail, keys) { return direct }
        for key in keys {
            if case .array(let items)? = detail[key] {
                let lines = items.compactMap(\.stringValue)
                if !lines.isEmpty { return lines.joined(separator: "\n") }
            }
        }
        return nil
    }

    /// Who or what is on the receiving end, for "To …".
    public static func previewTarget(_ detail: [String: JunoJSONValue], verb: Verb) -> String? {
        guard let keys = verb.targetKeys else { return nil }
        if let direct = firstString(detail, keys) { return direct }
        for key in keys {
            if case .array(let items)? = detail[key] {
                let names = items.compactMap(\.stringValue)
                if !names.isEmpty { return names.joined(separator: ", ") }
            }
        }
        return nil
    }

    /// The parameters the digest covers that can be shown as text — strings,
    /// numbers and switches — in a stable order.
    public static func parameters(_ detail: [String: JunoJSONValue]) -> [(key: String, value: String)] {
        detail.compactMap { key, value -> (key: String, value: String)? in
            switch value {
            case .string(let text): return (key, text)
            case .number(let number):
                return (key, number.rounded() == number && abs(number) < 1e15 ? String(Int(number)) : String(number))
            case .bool(let flag): return (key, flag ? "true" : "false")
            default: return nil
            }
        }
        .sorted { $0.key < $1.key }
    }

    /// "Show 3 parameters" / "Hide 1 parameter".
    public static func parametersToggle(count: Int, open: Bool) -> String {
        "\(open ? "Hide" : "Show") \(count) \(count == 1 ? "parameter" : "parameters")"
    }

    private static func firstString(_ detail: [String: JunoJSONValue], _ keys: [String]) -> String? {
        for key in keys {
            if let value = detail[key]?.stringValue,
                !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                return value
            }
        }
        return nil
    }

    // MARK: Standing and batch answers

    /// Whether "{Verb}, and stop asking" may be offered at all — the web's
    /// `mayStopAsking`, which is the Mac's ``JunoWorkApprovalRules``.
    public static func mayStopAsking(action: String, risk: String) -> Bool {
        JunoWorkApprovalRules.allowsStandingGrant(action: action, risk: risk)
    }

    /// Whether an approval may ride a batch press — `mayBatchApprove`. Never
    /// anything the floor catches: only safe and edit risks, and never an
    /// always-confirm action.
    public static func mayBatch(action: String, risk: String) -> Bool {
        guard JunoWorkAlwaysConfirmAction(rawValue: action) == nil else { return false }
        return risk == JunoWorkRiskLevel.safe.rawValue || risk == JunoWorkRiskLevel.edit.rawValue
    }

    /// The batch bar's sentence: all the same kind, or some of them.
    public static func batchSentence(batchable: Int, live: Int) -> String {
        batchable == live
            ? "\(batchable) decisions are waiting, and they are all the same kind."
            : "\(batchable) of these \(live) can be answered together. The rest ask on their own."
    }

    /// The batch button: one verb when every card shares an action, a count
    /// when they do not. The web's words, with its dash.
    public static func batchLabel(actions: [String]) -> String {
        let distinct = Set(actions)
        guard distinct.count == 1, let action = distinct.first else { return "Allow all \(actions.count)" }
        return "\(verb(for: action).verb) — all \(actions.count)"
    }

    // MARK: Risk

    /// `RISK_LABEL`: the pill.
    public static func riskLabel(_ risk: String) -> String {
        switch JunoWorkRiskLevel(rawValue: risk) ?? .irreversible {
        case .safe: "Safe"
        case .edit: "Edits a file"
        case .command: "Runs a command"
        case .sensitive: "Sensitive"
        case .irreversible: "Cannot be undone"
        }
    }

    /// Whether the risk pill is drawn in the bad tone.
    public static func riskIsSevere(_ risk: String) -> Bool {
        let level = JunoWorkRiskLevel(rawValue: risk) ?? .irreversible
        return level == .sensitive || level == .irreversible
    }

    /// `RISK_CONSEQUENCE`: what answering costs, per risk.
    public static func riskConsequence(_ risk: String) -> String {
        switch JunoWorkRiskLevel(rawValue: risk) ?? .irreversible {
        case .safe: "Nothing here changes anything outside this task."
        case .edit: "This writes to a file. Juno can show you what changed afterwards."
        case .command: "This runs a command on the machine this task is on."
        case .sensitive: "This touches something private. Juno asks every time, whatever you have allowed before."
        case .irreversible: "This cannot be undone — not by Juno, and not from this page afterwards."
        }
    }

    /// `actionLabel`: what an approval would authorise, as a noun phrase —
    /// never the raw tool token.
    public static func actionLabel(_ action: String?) -> String {
        guard let action, !action.isEmpty else { return "An action" }
        switch action {
        case "apply_changes": return "Change files"
        case "permanently_delete": return "Delete permanently"
        case "browser": return "Use a web page"
        case "browser_control": return "Use your browser"
        case "app_control": return "Use an app"
        case "screen_control": return "Control your screen"
        default: return humanize(action)
        }
    }

    /// The web's `humanize`: `email.search` → "Email search".
    public static func humanize(_ token: String) -> String {
        let words = token
            .split(whereSeparator: { "._/- \t\n".contains($0) })
            .joined(separator: " ")
        guard let first = words.first else { return token }
        return first.uppercased() + words.dropFirst()
    }

    // MARK: Settled

    /// `describeDecision`: what became of an answered card. `ago` renders a
    /// time as "5m ago".
    public static func settledLine(
        _ approval: WorkApprovalRequest, expired: Bool, ago: (Date) -> String
    ) -> String {
        let when = approval.decidedAt ?? approval.createdAt
        switch JunoWorkApprovalDecision(rawValue: approval.decision) ?? .pending {
        case .allowed:
            return when.map { "Allowed \(ago($0))" } ?? "Allowed"
        case .allowedAlways:
            return when.map { "Allowed for the rest of this task \(ago($0))" } ?? "Allowed for the rest of this task"
        case .denied:
            return when.map { "Refused \(ago($0))" } ?? "Refused"
        case .expired:
            return "Expired unanswered — Juno stopped rather than acting on a stale approval"
        case .superseded:
            return "Replaced by a later request"
        case .pending:
            return expired ? "Expired unanswered — Juno stopped rather than acting on a stale approval" : "Waiting"
        }
    }

    // MARK: Copy (the web's, verbatim)

    public static let decisionHeader = "Your decision"
    public static let amendPrompt = "What should it do instead?"
    public static let amendPlaceholder = "Send it to the finance alias instead, and drop the last paragraph."
    public static let amendNote = "Juno will not do this one. It will be told what you want instead, and will carry on from there."
    public static let expiryFootnote = "Unanswered, this expires and Juno stops rather than acting on it."
    public static let noDigest = "This request did not arrive with the signature Juno needs to accept an answer from the web. Decide it in the Juno app on the Mac that raised it."

    /// The second line under "{Verb}, and Stop Asking".
    public static func standingScope(action: String) -> String {
        "Covers “\(actionLabel(action))” for the rest of this task only. It lapses when the task ends."
    }
}
