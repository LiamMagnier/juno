import Foundation
import JunoCore
import JunoDesignSystem

// The wire shapes of Agents, as this build reads them.
//
// `src/lib/agents/types.ts` is the source: `ClientAgent`, `ClientAgentGoal`,
// `ClientAgentIdea`, `ClientAgentNote`, `ClientAgentRoutine`,
// `ClientAgentActivity` and `ClientAgentDetail`, field for field. Dates arrive
// as ISO strings and are parsed once, in `NativeAgentsClient`, so nothing
// above this file ever holds a timestamp as text.
//
// Vocabularies the server owns are enums with the web's raw values. A value
// this build does not know falls back to the server's own default rather than
// failing the whole payload — an agent from a newer build must still be
// readable, which is the same rule `normalizeAgentAvatar` applies to faces.

// MARK: - Vocabulary

/// How it talks. Never what it may do — that is the autonomy. `AGENT_STYLES`.
public enum NativeAgentStyle: String, CaseIterable, Identifiable, Sendable {
    case warm, direct, playful, formal

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .warm: "Warm"
        case .direct: "Direct"
        case .playful: "Playful"
        case .formal: "Formal"
        }
    }

    /// `AGENT_STYLE_SUMMARY`: the line under each style where a person picks it.
    public var summary: String {
        switch self {
        case .warm: "Friendly and encouraging, still to the point."
        case .direct: "Short answers, the decision first, no pleasantries."
        case .playful: "Light and quick, with a little personality."
        case .formal: "Measured and precise, the way you would write to a client."
        }
    }
}

/// A paused agent keeps everything and starts nothing. `AGENT_STATUSES`.
public enum NativeAgentStatus: String, CaseIterable, Sendable {
    case active, paused
}

/// `AGENT_GOAL_STATUSES`.
public enum NativeAgentGoalStatus: String, CaseIterable, Identifiable, Sendable {
    case active, paused, achieved, dropped

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .active: "Active"
        case .paused: "Paused"
        case .achieved: "Achieved"
        case .dropped: "Dropped"
        }
    }
}

/// How often it checks in on a goal. `AGENT_GOAL_CADENCES`.
///
/// The `none` wire value is spelled `never` here so that it can never be read
/// as `Optional.none` at a call site holding an optional cadence.
public enum NativeAgentGoalCadence: String, CaseIterable, Identifiable, Sendable {
    case never = "none"
    case daily
    case weekly

    public var id: String { rawValue }

    /// `AGENT_GOAL_CADENCE_LABEL`.
    public var label: String {
        switch self {
        case .never: "No check-ins"
        case .daily: "Checks in daily"
        case .weekly: "Checks in weekly"
        }
    }
}

/// The clocks a routine can be set to from an agent's page. The rest are one
/// step away in Automations. `AGENT_ROUTINE_CADENCES`.
public enum NativeAgentRoutineCadence: String, CaseIterable, Identifiable, Sendable {
    case hourly, daily, weekdays, weekly, monthly

    public var id: String { rawValue }

    /// `AGENT_ROUTINE_CADENCE_LABEL`.
    public var label: String {
        switch self {
        case .hourly: "Every hour"
        case .daily: "Every day"
        case .weekdays: "Every weekday"
        case .weekly: "Every week"
        case .monthly: "Every month"
        }
    }
}

/// The tone of one line in the agent's log. `ClientAgentActivity.tone`.
public enum NativeAgentActivityTone: String, Sendable {
    case neutral, attention, success, danger
}

public extension JunoWorkPermissionPolicy {
    /// `WORK_APPROVAL_MODE_LABEL`: each label is the promise itself. The Work
    /// wire values stay what every layer stores; only the words are the web's.
    var agentAutonomyLabel: String {
        switch self {
        case .conservative: "Ask before every change"
        case .balanced: "Ask before risky steps"
        case .permissive: "Just do it"
        }
    }

    /// `WORK_APPROVAL_MODE_SUMMARY`, said of the agent rather than of Juno.
    var agentAutonomySummary: String {
        switch self {
        case .conservative:
            "It asks before it changes a file or runs anything. Reading and research go ahead."
        case .balanced:
            "It makes changes it can undo, and asks before running anything or touching anything private."
        case .permissive:
            "It gets on with the work without asking — except for the things it cannot take back."
        }
    }

    /// The floor, stated under every mode rather than as a caveat on the last
    /// one: finding out from a prompt you were promised would not come is how
    /// a person concludes the setting does nothing.
    static let agentAutonomyFloor =
        "Whatever you choose, it always asks before it sends a message, publishes, pays or buys anything, deletes something for good, or changes an account or security setting."
}

// MARK: - Wire shapes

/// The newest task an agent owns. `ClientAgentTask`.
public struct NativeAgentTask: Identifiable, Equatable, Sendable {
    public var id: String { sessionID }
    public let sessionID: String
    public let title: String
    public let status: String
    public let needsAttention: Bool
    public let lastActivityAt: Date?
    public let conversationID: String?

    public init(
        sessionID: String,
        title: String,
        status: String,
        needsAttention: Bool,
        lastActivityAt: Date?,
        conversationID: String?
    ) {
        self.sessionID = sessionID
        self.title = title
        self.status = status
        self.needsAttention = needsAttention
        self.lastActivityAt = lastActivityAt
        self.conversationID = conversationID
    }
}

/// The next routine that fires. `ClientAgentRoutineGlance`.
public struct NativeAgentRoutineGlance: Equatable, Sendable {
    public let scheduleID: String
    public let name: String
    public let nextRunAt: Date?

    public init(scheduleID: String, name: String, nextRunAt: Date?) {
        self.scheduleID = scheduleID
        self.name = name
        self.nextRunAt = nextRunAt
    }
}

/// One agent, with the state the server derived for it. `ClientAgent`.
public struct NativeAgent: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let role: String
    public let avatar: JunoAgentAvatar
    public let style: NativeAgentStyle
    public let instructions: String
    public let model: String?
    public let reasoningEffort: String?
    public let approvalMode: JunoWorkPermissionPolicy
    public let connectorIDs: [String]
    public let projectID: String?
    public let conversationID: String?
    public let status: NativeAgentStatus
    public let proactive: Bool
    public let template: String?
    public let lastReflectedAt: Date?
    public let sortOrder: Int
    public let createdAt: Date
    public let updatedAt: Date
    /// Derived on read, never stored.
    public let state: JunoAgentState
    public let stateSentence: String
    public let task: NativeAgentTask?
    /// How many of its tasks are waiting on the person.
    public let needsYou: Int
    public let nextRoutine: NativeAgentRoutineGlance?
    /// Ideas it raised that nobody has started or dismissed.
    public let newIdeas: Int
    /// When the person pinned it; nil while it is not pinned. Pinned agents
    /// come first on Agents home.
    public let pinnedAt: Date?

    public init(
        id: String,
        name: String,
        role: String,
        avatar: JunoAgentAvatar,
        style: NativeAgentStyle,
        instructions: String,
        model: String?,
        reasoningEffort: String?,
        approvalMode: JunoWorkPermissionPolicy,
        connectorIDs: [String],
        projectID: String?,
        conversationID: String?,
        status: NativeAgentStatus,
        proactive: Bool,
        template: String?,
        lastReflectedAt: Date?,
        sortOrder: Int,
        createdAt: Date,
        updatedAt: Date,
        state: JunoAgentState,
        stateSentence: String,
        task: NativeAgentTask?,
        needsYou: Int,
        nextRoutine: NativeAgentRoutineGlance?,
        newIdeas: Int,
        pinnedAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.avatar = avatar
        self.style = style
        self.instructions = instructions
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.approvalMode = approvalMode
        self.connectorIDs = connectorIDs
        self.projectID = projectID
        self.conversationID = conversationID
        self.status = status
        self.proactive = proactive
        self.template = template
        self.lastReflectedAt = lastReflectedAt
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.state = state
        self.stateSentence = stateSentence
        self.task = task
        self.needsYou = needsYou
        self.nextRoutine = nextRoutine
        self.newIdeas = newIdeas
        self.pinnedAt = pinnedAt
    }

    public var isPaused: Bool { status == .paused }
    public var isPinned: Bool { pinnedAt != nil }
}

/// `ClientAgentGoal`.
public struct NativeAgentGoal: Identifiable, Equatable, Sendable {
    public let id: String
    public let agentID: String
    public let title: String
    public let detail: String
    public let status: NativeAgentGoalStatus
    public let cadence: NativeAgentGoalCadence
    public let lastCheckInAt: Date?
    public let lastCheckInNote: String?
    public let dueAt: Date?
    public let createdAt: Date?
    public let updatedAt: Date?

    public init(
        id: String,
        agentID: String,
        title: String,
        detail: String,
        status: NativeAgentGoalStatus,
        cadence: NativeAgentGoalCadence,
        lastCheckInAt: Date?,
        lastCheckInNote: String?,
        dueAt: Date?,
        createdAt: Date?,
        updatedAt: Date?
    ) {
        self.id = id
        self.agentID = agentID
        self.title = title
        self.detail = detail
        self.status = status
        self.cadence = cadence
        self.lastCheckInAt = lastCheckInAt
        self.lastCheckInNote = lastCheckInNote
        self.dueAt = dueAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// A proactive suggestion with Start on it. `ClientAgentIdea`.
public struct NativeAgentIdea: Identifiable, Equatable, Sendable {
    public let id: String
    public let agentID: String
    public let title: String
    public let detail: String
    public let prompt: String
    /// `new | started | dismissed`. The page only ever lists `new` ones.
    public let status: String
    public let goalID: String?
    public let createdAt: Date?
    public let decidedAt: Date?

    public init(
        id: String,
        agentID: String,
        title: String,
        detail: String,
        prompt: String,
        status: String,
        goalID: String?,
        createdAt: Date?,
        decidedAt: Date?
    ) {
        self.id = id
        self.agentID = agentID
        self.title = title
        self.detail = detail
        self.prompt = prompt
        self.status = status
        self.goalID = goalID
        self.createdAt = createdAt
        self.decidedAt = decidedAt
    }
}

/// One thing the agent knows. `ClientAgentNote`.
public struct NativeAgentNote: Identifiable, Equatable, Sendable {
    public let id: String
    public let agentID: String
    public let content: String
    /// `user | agent | reflection`: who wrote it, which is worth auditing.
    public let source: String
    public let createdAt: Date?
    public let updatedAt: Date?

    public init(
        id: String,
        agentID: String,
        content: String,
        source: String,
        createdAt: Date?,
        updatedAt: Date?
    ) {
        self.id = id
        self.agentID = agentID
        self.content = content
        self.source = source
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var sourceLabel: String {
        switch source {
        case "user": "You told it"
        case "reflection": "It worked this out"
        default: "It learned this"
        }
    }
}

/// An automation whose task belongs to the agent. `ClientAgentRoutine`.
public struct NativeAgentRoutine: Identifiable, Equatable, Sendable {
    public let id: String
    public let sessionID: String
    public let name: String
    public let instructions: String
    public let enabled: Bool
    public let timezone: String
    /// The first time trigger, in words: "Every weekday at 09:00".
    public let schedule: String
    public let nextRunAt: Date?
    public let lastRunAt: Date?

    public init(
        id: String,
        sessionID: String,
        name: String,
        instructions: String,
        enabled: Bool,
        timezone: String,
        schedule: String,
        nextRunAt: Date?,
        lastRunAt: Date?
    ) {
        self.id = id
        self.sessionID = sessionID
        self.name = name
        self.instructions = instructions
        self.enabled = enabled
        self.timezone = timezone
        self.schedule = schedule
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
    }
}

/// One line in the agent's log: its own events and its tasks, merged and
/// sorted newest first. `ClientAgentActivity`.
public struct NativeAgentActivity: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let title: String
    public let detail: String?
    public let at: Date?
    public let sessionID: String?
    public let tone: NativeAgentActivityTone

    public init(
        id: String,
        kind: String,
        title: String,
        detail: String?,
        at: Date?,
        sessionID: String?,
        tone: NativeAgentActivityTone
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.at = at
        self.sessionID = sessionID
        self.tone = tone
    }
}

public extension NativeAgentActivity {
    /// The lines about one run besides its task's own: an approval one of its
    /// tasks was given, and work handed to a teammate or taken from one. The
    /// web's `RUN_KINDS`.
    static let runKinds: Set<String> = ["approval", "handed_off", "handoff_received"]

    /// Whether this line is about one run, and so can open it. `kind` is an
    /// open vocabulary on the server, so an unknown kind is simply a line.
    var isAboutARun: Bool {
        guard sessionID != nil else { return false }
        return kind.hasPrefix("task_") || Self.runKinds.contains(kind)
    }

    /// What a line says when it arrived without a title: the kind in general
    /// words, sentence case, never the wire token.
    static func fallbackTitle(for kind: String) -> String {
        switch kind {
        case "hired": return "Joined"
        case "updated": return "Its profile changed"
        case "paused": return "Paused"
        case "resumed": return "Resumed"
        case "goal_set": return "Took on a goal"
        case "goal_updated": return "A goal changed"
        case "goal_checked_in": return "Checked in on a goal"
        case "idea_raised": return "Had an idea"
        case "idea_started": return "Started an idea"
        case "idea_dismissed": return "Set an idea aside"
        case "routine_created": return "Got a new routine"
        case "note_added": return "You told it something"
        case "note_learned": return "Learned something"
        case "task_started": return "Started a task"
        case "reflected": return "Thought it over"
        case "handed_off": return "Handed a task to a teammate"
        case "handoff_received": return "Took on a task from a teammate"
        case "approval": return "An approval was answered"
        default:
            if kind.hasPrefix("task_") { return "Worked on a task" }
            return JunoWorkVocabulary.sentenceCased(kind)
        }
    }
}

/// The cloud desktop attached to an agent (`/api/agents/{id}/computer`).
public struct NativeAgentCloudComputer: Equatable, Sendable {
    public var enabled: Bool
    public var status: String
    public var streamOn: Bool
    public var lastActiveAt: Date?
    public var activeSeconds: Int
    public var hasPoster: Bool
    public var usingNowSummary: String?
    public var error: String?

    public init(
        enabled: Bool,
        status: String,
        streamOn: Bool = false,
        lastActiveAt: Date? = nil,
        activeSeconds: Int = 0,
        hasPoster: Bool = false,
        usingNowSummary: String? = nil,
        error: String? = nil
    ) {
        self.enabled = enabled
        self.status = status
        self.streamOn = streamOn
        self.lastActiveAt = lastActiveAt
        self.activeSeconds = activeSeconds
        self.hasPoster = hasPoster
        self.usingNowSummary = usingNowSummary
        self.error = error
    }
}

/// Everything the agent's page draws. `ClientAgentDetail`.
///
/// Mutable, unlike the rows inside it, because the store edits a page in place
/// after a mutation succeeds — a goal just added should not wait for a round
/// trip to appear.
public struct NativeAgentDetail: Equatable, Sendable {
    public var agent: NativeAgent
    public var goals: [NativeAgentGoal]
    public var ideas: [NativeAgentIdea]
    public var notes: [NativeAgentNote]
    public var routines: [NativeAgentRoutine]
    public var tasks: [NativeAgentTask]
    public var computer: NativeAgentCloudComputer?
    public var computerConfigured: Bool

    public init(
        agent: NativeAgent,
        goals: [NativeAgentGoal],
        ideas: [NativeAgentIdea],
        notes: [NativeAgentNote],
        routines: [NativeAgentRoutine],
        tasks: [NativeAgentTask],
        computer: NativeAgentCloudComputer? = nil,
        computerConfigured: Bool = false
    ) {
        self.agent = agent
        self.goals = goals
        self.ideas = ideas
        self.notes = notes
        self.routines = routines
        self.tasks = tasks
        self.computer = computer
        self.computerConfigured = computerConfigured
    }
}

// MARK: - Outcomes

/// What a request that can start work answered.
///
/// Starting an idea or a task can come back `409 confirm_expensive` with an
/// estimate: the person has to say yes to the cost first, and the page sends
/// the same request again with `confirmExpensive`. That is an answer, not a
/// failure, so it is a case here rather than a thrown error.
public enum NativeAgentStartOutcome: Equatable, Sendable {
    /// The server did it. For a started task, the ids of the task and of the
    /// thread it runs in; both nil for a dismissed idea.
    case accepted(sessionID: String?, conversationID: String?)
    /// Ask the person, then resend with `confirmExpensive: true`.
    case needsConfirmation(estimatedCostMicroUSD: Int, message: String)
}

/// What `POST /api/agents/{id}/reflect` did.
public enum NativeAgentReflectOutcome: Equatable, Sendable {
    case reflected(ideas: Int, checkIns: Int, notes: Int)
    /// `not_due | paused | claimed | no_answer | not_found`.
    case skipped(reason: String)
}

/// Start or dismiss, for `PATCH /api/agents/{id}/ideas/{ideaId}`.
public enum NativeAgentIdeaAction: String, Sendable {
    case start, dismiss
}

// MARK: - Drafts

/// A new hire. `createAgentSchema`.
public struct NativeAgentDraft: Equatable, Sendable {
    public var name: String
    public var role: String
    /// Nil leaves the face to the server, which seeds it from the new
    /// agent's id: the same face every client derives for that id.
    public var avatar: JunoAgentAvatar?
    public var style: NativeAgentStyle
    public var instructions: String
    public var approvalMode: JunoWorkPermissionPolicy
    public var connectorIDs: [String]
    public var template: String?
    public var firstGoal: String

    public init(
        name: String,
        role: String = "",
        avatar: JunoAgentAvatar? = nil,
        style: NativeAgentStyle = .warm,
        instructions: String = "",
        approvalMode: JunoWorkPermissionPolicy = .balanced,
        connectorIDs: [String] = [],
        template: String? = nil,
        firstGoal: String = ""
    ) {
        self.name = name
        self.role = role
        self.avatar = avatar
        self.style = style
        self.instructions = instructions
        self.approvalMode = approvalMode
        self.connectorIDs = connectorIDs
        self.template = template
        self.firstGoal = firstGoal
    }

    /// The agent Agents home creates for a job typed as a sentence: a name
    /// the agent replaces as soon as it reads the job, and nothing else. The
    /// server defaults the rest and seeds the face; the agent sets its own
    /// role, goal and tools from the first message.
    public static let blank = NativeAgentDraft(name: "New agent")

    /// A starting point's defaults, every one of them editable before Hire.
    public init(template: NativeAgentTemplate) {
        self.init(
            name: template.names.first ?? "",
            role: template.role,
            avatar: template.avatar,
            style: template.style,
            instructions: template.instructions,
            approvalMode: template.approvalMode,
            connectorIDs: [],
            template: template.id,
            firstGoal: template.firstGoal
        )
    }

    /// The limits the server enforces (`MAX_AGENT_NAME_CHARS` and friends),
    /// checked here so Hire is disabled rather than answered with a 400.
    public var isValid: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, trimmedName.count <= NativeAgentLimits.name else { return false }
        guard role.trimmingCharacters(in: .whitespacesAndNewlines).count <= NativeAgentLimits.role else { return false }
        guard instructions.trimmingCharacters(in: .whitespacesAndNewlines).count <= NativeAgentLimits.instructions else {
            return false
        }
        return firstGoal.trimmingCharacters(in: .whitespacesAndNewlines).count <= NativeAgentLimits.goalTitle
    }
}

/// An edit. Every field is optional and only the ones set are sent, because
/// `patchAgentSchema` treats a present field as an instruction.
public struct NativeAgentPatch: Equatable, Sendable {
    public var name: String?
    public var role: String?
    public var avatar: JunoAgentAvatar?
    public var style: NativeAgentStyle?
    public var instructions: String?
    public var approvalMode: JunoWorkPermissionPolicy?
    public var connectorIDs: [String]?
    public var status: NativeAgentStatus?
    public var proactive: Bool?
    public var pinned: Bool?

    public init(
        name: String? = nil,
        role: String? = nil,
        avatar: JunoAgentAvatar? = nil,
        style: NativeAgentStyle? = nil,
        instructions: String? = nil,
        approvalMode: JunoWorkPermissionPolicy? = nil,
        connectorIDs: [String]? = nil,
        status: NativeAgentStatus? = nil,
        proactive: Bool? = nil,
        pinned: Bool? = nil
    ) {
        self.name = name
        self.role = role
        self.avatar = avatar
        self.style = style
        self.instructions = instructions
        self.approvalMode = approvalMode
        self.connectorIDs = connectorIDs
        self.status = status
        self.proactive = proactive
        self.pinned = pinned
    }

    /// The server refuses an empty patch ("Nothing to change").
    public var isEmpty: Bool {
        name == nil && role == nil && avatar == nil && style == nil && instructions == nil
            && approvalMode == nil && connectorIDs == nil && status == nil && proactive == nil
            && pinned == nil
    }
}

/// `createGoalSchema`.
public struct NativeAgentGoalDraft: Equatable, Sendable {
    public var title: String
    public var detail: String
    public var cadence: NativeAgentGoalCadence

    public init(title: String = "", detail: String = "", cadence: NativeAgentGoalCadence = .weekly) {
        self.title = title
        self.detail = detail
        self.cadence = cadence
    }

    public var isValid: Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= NativeAgentLimits.goalTitle
    }
}

/// `createRoutineSchema`. The time is the reader's own, in their own zone.
public struct NativeAgentRoutineDraft: Equatable, Sendable {
    public var name: String
    public var instructions: String
    public var cadence: NativeAgentRoutineCadence
    public var hour: Int
    public var minute: Int
    /// 0 (Sunday) to 6, for `weekly`.
    public var weekday: Int
    /// 1 to 31, for `monthly`.
    public var monthday: Int
    public var timezone: String

    public init(
        name: String = "",
        instructions: String = "",
        cadence: NativeAgentRoutineCadence = .weekdays,
        hour: Int = 9,
        minute: Int = 0,
        weekday: Int = 1,
        monthday: Int = 1,
        timezone: String = TimeZone.current.identifier
    ) {
        self.name = name
        self.instructions = instructions
        self.cadence = cadence
        self.hour = hour
        self.minute = minute
        self.weekday = weekday
        self.monthday = monthday
        self.timezone = timezone
    }

    // One guard per rule rather than one `&&` chain: a long chain of integer
    // and range literals is the shape Swift's type checker gives up on
    // ("unable to type-check this expression in reasonable time"), and each
    // guard is also the line that names the bound it enforces.
    public var isValid: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, trimmedName.count <= 120 else { return false }
        let trimmedInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInstructions.isEmpty, trimmedInstructions.count <= 4_000 else { return false }
        guard (0...23).contains(hour), (0...59).contains(minute) else { return false }
        guard (0...6).contains(weekday), (1...31).contains(monthday) else { return false }
        return !timezone.isEmpty
    }
}

/// The server's limits, from `src/lib/agents/domain.ts`.
public enum NativeAgentLimits {
    public static let name = 40
    public static let role = 80
    public static let instructions = 6_000
    public static let goalTitle = 140
    public static let note = 1_000
    /// `startAgentTaskSchema.title`.
    public static let taskTitle = 80
}

// MARK: - Starting points

/// A starting point for hiring (AGENTS.md §5.1), mirrored from
/// `src/lib/agents/templates.ts`.
///
/// Muse's lesson was that a blank canvas is the wrong first screen for an
/// agent: a person deciding what something may do on their behalf wants to
/// start from a job. Each is a job with a sensible brief, autonomy and first
/// goal, and none of them anything more than defaults. There is no route that
/// serves these, so the list is carried here; the `id`s are what the server
/// records as `template`.
public struct NativeAgentTemplate: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// The one-line promise on the tile.
    public let promise: String
    public let names: [String]
    public let role: String
    public let style: NativeAgentStyle
    public let approvalMode: JunoWorkPermissionPolicy
    public let avatar: JunoAgentAvatar
    public let instructions: String
    public let firstGoal: String
    /// Provider ids the job usually wants. Offered only when the account has
    /// linked them: a suggestion is never a grant.
    public let suggestedConnectors: [String]

    public static let all: [NativeAgentTemplate] = [
        NativeAgentTemplate(
            id: "chief-of-staff",
            label: "Chief of staff",
            promise: "Keeps your inbox, calendar and follow-ups moving.",
            names: ["Atlas", "Wren", "Juniper"],
            role: "Inbox, calendar and follow-ups",
            style: .direct,
            approvalMode: .balanced,
            avatar: JunoAgentAvatar(shape: .pebble, tone: .juniper, eyes: .soft, mark: .ring),
            instructions: [
                "You look after my inbox, my calendar and the follow-ups that fall between them.",
                "Triage what came in, tell me what needs me today, draft replies in my voice, and find times for meetings.",
                "Never send an email or accept an invitation without my approval. When something is ambiguous, ask one short question rather than guessing.",
            ].joined(separator: "\n\n"),
            firstGoal: "Get my inbox to a state where nothing important waits more than a day",
            suggestedConnectors: ["apple-mail", "apple-calendar", "composio:gmail", "composio:googlecalendar"]
        ),
        NativeAgentTemplate(
            id: "researcher",
            label: "Researcher",
            promise: "Reads widely, checks its sources, and reports back with citations.",
            names: ["Scout", "Iris", "Sage"],
            role: "Research and briefings",
            style: .direct,
            approvalMode: .balanced,
            avatar: JunoAgentAvatar(shape: .orb, tone: .teal, eyes: .round, mark: .antenna),
            instructions: [
                "You research questions for me thoroughly and report back with what you found and where you found it.",
                "Prefer primary sources, say when evidence is thin or sources disagree, and lead every report with the answer in two sentences.",
                "Deliver longer findings as a document I can keep.",
            ].joined(separator: "\n\n"),
            firstGoal: "Keep me current on the topics I care about",
            suggestedConnectors: ["notion"]
        ),
        NativeAgentTemplate(
            id: "deal-finder",
            label: "Deal finder",
            promise: "Compares prices and watches for drops. Asks before it buys anything.",
            names: ["Penny", "Finch", "Hawk"],
            role: "Shopping and price watching",
            style: .warm,
            approvalMode: .balanced,
            avatar: JunoAgentAvatar(shape: .petal, tone: .amber, eyes: .wide, mark: .spark),
            instructions: [
                "You find the best price for things I want to buy and watch for drops on things I am waiting on.",
                "Compare the exact model, size and colour I asked for across reputable shops, include shipping and returns, and flag anything that looks like a grey-market listing.",
                "You never complete a purchase: you bring me the best option with a link, and I decide.",
            ].joined(separator: "\n\n"),
            firstGoal: "Track the things on my wishlist and tell me when one is worth buying",
            suggestedConnectors: []
        ),
        NativeAgentTemplate(
            id: "trip-planner",
            label: "Trip planner",
            promise: "Plans trips end to end: routes, stays and bookings for you to approve.",
            names: ["Rove", "Nomad", "Kite"],
            role: "Travel planning",
            style: .warm,
            approvalMode: .balanced,
            avatar: JunoAgentAvatar(shape: .capsule, tone: .sage, eyes: .tall, mark: .leaf),
            instructions: [
                "You plan trips for me: getting there, where to stay, what to do, and what it will cost.",
                "Build itineraries as documents with times, addresses and booking links, keep a budget, and suggest alternatives when something is sold out.",
                "Anything that books or pays waits for my approval.",
            ].joined(separator: "\n\n"),
            firstGoal: "Plan my next trip",
            suggestedConnectors: ["apple-calendar", "composio:googlecalendar"]
        ),
        NativeAgentTemplate(
            id: "writer",
            label: "Writer",
            promise: "Drafts posts, emails and documents in your voice. Never publishes without you.",
            names: ["Quill", "Echo", "Mira"],
            role: "Writing and drafting",
            style: .playful,
            approvalMode: .balanced,
            avatar: JunoAgentAvatar(shape: .bloom, tone: .violet, eyes: .soft, mark: JunoAgentMark.none),
            instructions: [
                "You draft writing for me: posts, emails, announcements and documents.",
                "Match my voice from what I have written before, keep it concise, and give me two options when the tone is a judgment call.",
                "You never publish or send anything. Drafts only; I press the button.",
            ].joined(separator: "\n\n"),
            firstGoal: "Help me publish something worth reading every week",
            suggestedConnectors: ["notion"]
        ),
        NativeAgentTemplate(
            id: "monitor",
            label: "Monitor",
            promise: "Watches pages, feeds and topics, and tells you what changed.",
            names: ["Sentry", "Beacon", "Lookout"],
            role: "Watching for changes",
            style: .direct,
            approvalMode: .conservative,
            avatar: JunoAgentAvatar(shape: .spark, tone: .coral, eyes: .wide, mark: .visor),
            instructions: [
                "You watch the pages, feeds and topics I give you and tell me when something meaningful changes.",
                "Report only real changes, not noise: what changed, why it matters to me, and the link.",
                "If nothing changed, say so in one line.",
            ].joined(separator: "\n\n"),
            firstGoal: "Tell me the moment something I track changes",
            suggestedConnectors: ["github"]
        ),
        NativeAgentTemplate(
            id: "custom",
            label: "Start from scratch",
            promise: "A blank brief. You decide what it takes on.",
            names: ["Nova", "Pip", "Orion"],
            role: "",
            style: .warm,
            approvalMode: .balanced,
            avatar: JunoAgentAvatar(shape: .orb, tone: .coral, eyes: .soft, mark: JunoAgentMark.none),
            instructions: "",
            firstGoal: "",
            suggestedConnectors: []
        ),
    ]

    public static func named(_ id: String?) -> NativeAgentTemplate? {
        guard let id else { return nil }
        return all.first { $0.id == id }
    }
}

/// An app the account has linked, offered to an agent by name.
///
/// Carried as plain data so this module does not depend on the chat kit that
/// owns the connector store; each app maps its own connector list into these.
public struct NativeAgentAppChoice: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}
