import Foundation

// Alevr Code v2 — Codable mirror of the shared contracts.
//
// Source of truth: src/lib/code-v2/contracts.ts (schema twin
// contracts/code/alevr-code-v2.schema.json, fixtures contracts/code/fixtures).
// `node scripts/check-code-v2-contracts.mjs` fails when an enum marked
// `// contract: <NAME>` here stops listing exactly the raw values of the TS
// array of that name, or when the alias table drifts. Keep marked enums to
// plain cases (no members) so the check can read them.
//
// Edits are additive only, like the TS contract. Unknown turn-item kinds and
// event types decode to `.unknown` instead of failing, so an older Mac keeps
// rendering a session a newer env server writes.

public enum CodeV2 {
    public static let protocolName = "alevr-code-v2"
    public static let protocolMajor = 1
    public static let protocolMinor = 0

    // MARK: Providers

    // contract: PROVIDER_KIND_VALUES
    public enum ProviderKind: String, Codable, Sendable, CaseIterable, Hashable {
        case alevr
        case byok
        case claudeAgent = "claude-agent"
        case codex
        case acp
    }

    // contract: PROVIDER_STATUS_VALUES
    public enum ProviderStatus: String, Codable, Sendable, CaseIterable, Hashable {
        case notInstalled = "not-installed"
        case signedOut = "signed-out"
        case ready
        case limited
        case error
        case unknown
    }

    // contract: EFFORT_LEVEL_VALUES
    public enum EffortLevel: String, Codable, Sendable, CaseIterable, Hashable {
        case none
        case minimal
        case low
        case medium
        case high
        case xhigh
        case max
    }

    // contract: RUNTIME_MODE_VALUES
    public enum RuntimeMode: String, Codable, Sendable, CaseIterable, Hashable {
        case readOnly = "read-only"
        case ask
        case autoEdit = "auto-edit"
        case auto
        case full
    }

    // contract: INTERACTION_MODE_VALUES
    public enum InteractionMode: String, Codable, Sendable, CaseIterable, Hashable {
        case `default`
        case plan
    }

    public struct UsageWindow: Codable, Sendable, Hashable {
        public var id: String
        public var label: String
        public var usedPct: Double?
        public var resetsAt: String?

        public init(id: String, label: String, usedPct: Double? = nil, resetsAt: String? = nil) {
            self.id = id
            self.label = label
            self.usedPct = usedPct
            self.resetsAt = resetsAt
        }
    }

    public struct ProviderAccount: Codable, Sendable, Hashable {
        public var email: String?
        public var plan: String?
        public var tokenSource: String?

        public init(email: String? = nil, plan: String? = nil, tokenSource: String? = nil) {
            self.email = email
            self.plan = plan
            self.tokenSource = tokenSource
        }
    }

    public struct ProviderCapabilities: Codable, Sendable, Hashable {
        public var steering: Bool
        public var queue: Bool
        public var interrupt: Bool
        public var resume: Bool
        public var fork: Bool
        public var rollback: Bool
        public var planMode: Bool
        public var approvals: [RuntimeMode]
        public var subagents: Bool
        public var computerUse: Bool
        public var contextTiers: Bool
        public var effortLevels: [EffortLevel]
        public var images: Bool
        public var mcpInjection: Bool
    }

    public struct ContextTier: Codable, Sendable, Hashable {
        public var tokens: Int
        public var label: String
        public var inputPerMTok: Double
        public var outputPerMTok: Double
        public var cachedInputPerMTok: Double?
        public var note: String?
        /// The catalogue has no verified rate for part of this window.
        public var unverified: Bool?

        public init(
            tokens: Int, label: String, inputPerMTok: Double, outputPerMTok: Double,
            cachedInputPerMTok: Double? = nil, note: String? = nil, unverified: Bool? = nil
        ) {
            self.tokens = tokens
            self.label = label
            self.inputPerMTok = inputPerMTok
            self.outputPerMTok = outputPerMTok
            self.cachedInputPerMTok = cachedInputPerMTok
            self.note = note
            self.unverified = unverified
        }
    }

    // contract: BYOK_PROVIDER_VALUES
    /// Labs whose API keys a user may store; instance id `byok:<rawValue>`.
    public enum ByokProvider: String, Codable, Sendable, CaseIterable, Hashable {
        case anthropic
        case openai
        case google
        case xai
        case deepseek
    }

    /// `byok:anthropic` — the provider instance a stored key appears as.
    public static func byokInstanceId(_ provider: ByokProvider) -> String { "byok:\(provider.rawValue)" }

    public struct ProviderModel: Codable, Sendable, Hashable {
        public var id: String
        public var label: String
        public var contextTiers: [ContextTier]?
        public var effortLevels: [EffortLevel]?
        public var defaultEffort: EffortLevel?
        public var supportsFast: Bool?
        public var isDefault: Bool?
    }

    public struct ProviderInstance: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var kind: ProviderKind
        public var label: String
        public var binaryPath: String?
        public var configDir: String?
        public var env: [String: String]?
        public var launchArgs: [String]?
        public var acpCommand: [String]?
        public var account: ProviderAccount?
        public var status: ProviderStatus
        public var statusMessage: String?
        public var version: String?
        public var limits: [UsageWindow]?
        public var capabilities: ProviderCapabilities?
        public var models: [ProviderModel]?
        public var checkedAt: String?
    }

    // MARK: Model and role selection

    public struct ModelSelection: Codable, Sendable, Hashable {
        public var instanceId: String
        public var model: String
        public var effort: EffortLevel?
        public var contextTokens: Int?
        public var fast: Bool?

        public init(instanceId: String, model: String, effort: EffortLevel? = nil, contextTokens: Int? = nil, fast: Bool? = nil) {
            self.instanceId = instanceId
            self.model = model
            self.effort = effort
            self.contextTokens = contextTokens
            self.fast = fast
        }
    }

    // contract: ROLE_PRESET_VALUES
    public enum RolePreset: String, Codable, Sendable, CaseIterable, Hashable {
        case solo
        case leadWorkers = "lead-workers"
        case bestOfN = "best-of-n"
    }

    // contract: AGENT_ROLE_VALUES
    public enum AgentRole: String, Codable, Sendable, CaseIterable, Hashable {
        case orchestrator
        case worker
        case reviewer
        case explorer
        case compaction
    }

    public struct RunBudget: Codable, Sendable, Hashable {
        public var maxTokens: Int?
        public var maxUsd: Double?

        public init(maxTokens: Int? = nil, maxUsd: Double? = nil) {
            self.maxTokens = maxTokens
            self.maxUsd = maxUsd
        }
    }

    public struct RoleRouting: Codable, Sendable, Hashable {
        public var orchestrator: ModelSelection
        public var workers: [ModelSelection]?
        public var reviewer: ModelSelection?
        public var explorer: ModelSelection?
        public var compaction: ModelSelection?
        public var preset: RolePreset
        public var budget: RunBudget?

        public init(
            orchestrator: ModelSelection,
            workers: [ModelSelection]? = nil,
            reviewer: ModelSelection? = nil,
            explorer: ModelSelection? = nil,
            compaction: ModelSelection? = nil,
            preset: RolePreset = .solo,
            budget: RunBudget? = nil
        ) {
            self.orchestrator = orchestrator
            self.workers = workers
            self.reviewer = reviewer
            self.explorer = explorer
            self.compaction = compaction
            self.preset = preset
            self.budget = budget
        }
    }

    /// Short aliases a model or subagent may name. `CodeModelProviderResolver`
    /// and `ComputerUseRoutes.parse` resolve through this table.
    public static let modelAliases: [String: String] =
        // contract: CODE_MODEL_ALIASES
        [
            "opus": "anthropic:claude-opus-5-5",
            "max": "anthropic:claude-opus-5-5",
            "sonnet": "anthropic:claude-sonnet-5-5",
            "pro": "anthropic:claude-sonnet-5-5",
            "haiku": "anthropic:claude-haiku-4-5",
            "flash": "google:gemini-3.8-flash",
            "fast": "google:gemini-3.8-flash",
        ]

    /// Canonical `provider:model` for an alias; any other id comes back trimmed.
    public static func resolveModelAlias(_ modelID: String) -> String {
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        return modelAliases[trimmed.lowercased()] ?? trimmed
    }

    // MARK: Turn items

    // contract: TURN_ITEM_KIND_VALUES
    public enum TurnItemKind: String, Codable, Sendable, CaseIterable, Hashable {
        case userMessage = "user_message"
        case assistantMessage = "assistant_message"
        case reasoning
        case plan
        case todoList = "todo_list"
        case userInputRequest = "user_input_request"
        case fileChange = "file_change"
        case commandExecution = "command_execution"
        case search
        case webSearch = "web_search"
        case approvalRequest = "approval_request"
        case checkpoint
        case interrupt
        case systemNotice = "system_notice"
        case error
        case compaction
        case handoff
        case subagent
        case computerAction = "computer_action"
    }

    // contract: ITEM_STATUS_VALUES
    public enum ItemStatus: String, Codable, Sendable, CaseIterable, Hashable {
        case pending
        case running
        case completed
        case failed
        case declined
        case interrupted
    }

    // contract: APPROVAL_DECISION_VALUES
    public enum ApprovalDecision: String, Codable, Sendable, CaseIterable, Hashable {
        case accept
        case acceptForSession
        case decline
        case cancel
    }

    // contract: STEP_STATUS_VALUES
    public enum StepStatus: String, Codable, Sendable, CaseIterable, Hashable {
        case pending
        case inProgress = "in_progress"
        case completed
    }

    // contract: COMPUTER_ACTION_VALUES
    public enum ComputerActionKind: String, Codable, Sendable, CaseIterable, Hashable {
        case screenshot
        case click
        case doubleClick = "double_click"
        case rightClick = "right_click"
        case move
        case drag
        case scroll
        case type
        case key
        case wait
        case openApp = "open_app"
        case zoom
        case axFind = "ax_find"
        case axPress = "ax_press"
        case menu
    }

    // contract: SUBAGENT_STATUS_VALUES
    public enum SubagentStatus: String, Codable, Sendable, CaseIterable, Hashable {
        case running
        case waiting
        case completed
        case failed
        case interrupted
    }

    public struct Attachment: Codable, Sendable, Hashable {
        public var name: String
        public var mediaType: String
        public var ref: String
    }

    public struct UserInput: Codable, Sendable, Hashable {
        public var text: String
        public var attachments: [Attachment]?

        public init(text: String, attachments: [Attachment]? = nil) {
            self.text = text
            self.attachments = attachments
        }
    }

    public struct TokenCount: Codable, Sendable, Hashable {
        public var input: Int
        public var output: Int
        public var cachedInput: Int?
    }

    public struct PlanStep: Codable, Sendable, Hashable {
        public var text: String
        public var status: StepStatus
    }

    public struct TodoEntry: Codable, Sendable, Hashable {
        public var id: String?
        public var text: String
        public var status: StepStatus
    }

    public struct UserInputQuestion: Codable, Sendable, Hashable {
        public var id: String
        public var prompt: String
        public var options: [String]?
        public var multiSelect: Bool?
    }

    public struct FileChangeEntry: Codable, Sendable, Hashable {
        public enum Change: String, Codable, Sendable, Hashable { case add, modify, delete, rename }
        public var path: String
        public var change: Change
        public var previousPath: String?
        public var diff: String?
        public var additions: Int?
        public var deletions: Int?
    }

    public struct WebSearchResult: Codable, Sendable, Hashable {
        public var title: String
        public var url: String
    }

    public struct UserMessage: Codable, Sendable, Hashable {
        public enum Delivery: String, Codable, Sendable, Hashable { case send, steer, queue }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var text: String
        public var attachments: [Attachment]?
        public var delivery: Delivery?
    }

    public struct AssistantMessage: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var text: String
        public var streaming: Bool
        public var agentId: String?
    }

    public struct Reasoning: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var text: String
        public var streaming: Bool
        public var summary: Bool?
    }

    public struct Plan: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var text: String
        public var steps: [PlanStep]?
        public var awaitingApproval: Bool?
    }

    public struct TodoList: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var todos: [TodoEntry]
    }

    public struct UserInputRequest: Codable, Sendable, Hashable {
        public enum Status: String, Codable, Sendable, Hashable { case pending, answered, cancelled }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var requestId: String
        public var questions: [UserInputQuestion]
        public var answers: [String: [String]]?
        public var status: Status
    }

    public struct FileChange: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var callId: String
        public var changes: [FileChangeEntry]
        public var status: ItemStatus
    }

    public struct CommandExecution: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var callId: String
        public var command: String
        public var cwd: String?
        public var output: String?
        public var exitCode: Int?
        public var durationMs: Int?
        public var background: Bool?
        public var status: ItemStatus
    }

    public struct Search: Codable, Sendable, Hashable {
        public enum Scope: String, Codable, Sendable, Hashable { case files, content, symbols }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var callId: String
        public var query: String
        public var scope: Scope?
        public var matches: Int?
        public var status: ItemStatus
    }

    public struct WebSearch: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var callId: String
        public var query: String
        public var results: [WebSearchResult]?
        public var status: ItemStatus
    }

    public struct ApprovalRequest: Codable, Sendable, Hashable {
        public enum Action: String, Codable, Sendable, Hashable {
            case command
            case fileChange = "file_change"
            case permissions, tool, computer
        }
        public enum Status: String, Codable, Sendable, Hashable { case pending, resolved, expired }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var callId: String
        public var requestId: String
        public var action: Action
        public var summary: String
        public var justification: String?
        public var detail: String?
        public var options: [ApprovalDecision]?
        public var decision: ApprovalDecision?
        public var status: Status
    }

    public struct Checkpoint: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var checkpointId: String
        public var turnOrdinal: Int
        public var ref: String?
        public var filesChanged: Int?
        public var additions: Int?
        public var deletions: Int?
    }

    public struct Interrupt: Codable, Sendable, Hashable {
        public enum Reason: String, Codable, Sendable, Hashable { case user, limit, budget, error }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var reason: Reason
        public var message: String?
        public var resumeAt: String?
    }

    public struct SystemNotice: Codable, Sendable, Hashable {
        public enum Level: String, Codable, Sendable, Hashable { case info, warning }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var level: Level
        public var text: String
        public var code: String?
    }

    public struct ErrorNotice: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var message: String
        public var code: String?
        public var retryable: Bool?
    }

    public struct Compaction: Codable, Sendable, Hashable {
        public enum Strategy: String, Codable, Sendable, Hashable { case prune, offload, summarize }
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var beforeTokens: Int
        public var afterTokens: Int
        public var strategy: Strategy?
        public var summary: String?
    }

    public struct Handoff: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var from: ModelSelection?
        public var to: ModelSelection
        public var reason: String?
    }

    public struct Subagent: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var agentId: String
        public var role: AgentRole
        public var model: ModelSelection
        public var status: SubagentStatus
        public var task: String?
        public var closingText: String?
        public var tokens: TokenCount?
    }

    public struct ComputerAction: Codable, Sendable, Hashable {
        public var id: String
        public var turnId: String?
        public var createdAt: String
        public var callId: String
        public var action: ComputerActionKind
        public var target: String?
        public var screenshotRef: String?
        public var status: ItemStatus
        public var app: String?
        public var summary: String?
        /// Where it landed, as a fraction (0…1 each way) of the screenshot.
        public var point: UnitPoint?
        public var frameSize: FrameSize?
        public var error: String?
        public var durationMs: Double?

        public struct UnitPoint: Codable, Sendable, Hashable {
            public var x: Double
            public var y: Double
            public init(x: Double, y: Double) {
                self.x = x
                self.y = y
            }
        }

        public struct FrameSize: Codable, Sendable, Hashable {
            public var width: Int
            public var height: Int
            public init(width: Int, height: Int) {
                self.width = width
                self.height = height
            }
        }

        public init(
            id: String,
            turnId: String? = nil,
            createdAt: String,
            callId: String,
            action: ComputerActionKind,
            target: String? = nil,
            screenshotRef: String? = nil,
            status: ItemStatus,
            app: String? = nil,
            summary: String? = nil,
            point: UnitPoint? = nil,
            frameSize: FrameSize? = nil,
            error: String? = nil,
            durationMs: Double? = nil
        ) {
            self.id = id
            self.turnId = turnId
            self.createdAt = createdAt
            self.callId = callId
            self.action = action
            self.target = target
            self.screenshotRef = screenshotRef
            self.status = status
            self.app = app
            self.summary = summary
            self.point = point
            self.frameSize = frameSize
            self.error = error
            self.durationMs = durationMs
        }
    }

    // MARK: Computer use (SPEC §3.12)

    /// The provider-agnostic computer tool's name (`ALEVR_COMPUTER_TOOL_NAME`).
    public static let computerToolName = "computer_use"
    /// `DESKTOP_LOCK_STALE_MS`.
    public static let desktopLockStaleMilliseconds = 15_000

    // contract: COMPUTER_COORDINATE_SPACE_VALUES
    public enum ComputerCoordinateSpace: String, Codable, Sendable, CaseIterable, Hashable {
        case pixels
        case normalized1000 = "normalized_1000"
    }

    /// One `computer_use` call's arguments, snake_case as on the wire.
    public struct ComputerToolArgs: Codable, Sendable, Hashable {
        public enum Direction: String, Codable, Sendable, Hashable { case up, down, left, right }
        public var action: ComputerActionKind
        public var app: String?
        public var x: Double?
        public var y: Double?
        public var toX: Double?
        public var toY: Double?
        public var element: String?
        public var query: String?
        public var text: String?
        public var direction: Direction?
        public var amount: Int?
        public var seconds: Double?
        public var region: [Double]?
        public var path: [String]?
        public var coordinateSpace: ComputerCoordinateSpace?

        enum CodingKeys: String, CodingKey {
            case action, app, x, y, element, query, text, direction, amount, seconds, region, path
            case toX = "to_x"
            case toY = "to_y"
            case coordinateSpace = "coordinate_space"
        }

        public init(
            action: ComputerActionKind,
            app: String? = nil,
            x: Double? = nil,
            y: Double? = nil,
            toX: Double? = nil,
            toY: Double? = nil,
            element: String? = nil,
            query: String? = nil,
            text: String? = nil,
            direction: Direction? = nil,
            amount: Int? = nil,
            seconds: Double? = nil,
            region: [Double]? = nil,
            path: [String]? = nil,
            coordinateSpace: ComputerCoordinateSpace? = nil
        ) {
            self.action = action
            self.app = app
            self.x = x
            self.y = y
            self.toX = toX
            self.toY = toY
            self.element = element
            self.query = query
            self.text = text
            self.direction = direction
            self.amount = amount
            self.seconds = seconds
            self.region = region
            self.path = path
            self.coordinateSpace = coordinateSpace
        }
    }

    /// The cross-process desktop lock file's record.
    public struct DesktopLockRecord: Codable, Sendable, Hashable {
        public enum Kind: String, Codable, Sendable, Hashable {
            case codeSession = "code_session"
            case workTask = "work_task"
            case envServer = "env_server"
        }
        public var holderId: String
        public var kind: Kind
        public var title: String
        public var pid: Int32
        public var app: String?
        public var acquiredAt: String
        public var heartbeatAt: String

        public init(holderId: String, kind: Kind, title: String, pid: Int32, app: String? = nil, acquiredAt: String, heartbeatAt: String) {
            self.holderId = holderId
            self.kind = kind
            self.title = title
            self.pid = pid
            self.app = app
            self.acquiredAt = acquiredAt
            self.heartbeatAt = heartbeatAt
        }
    }

    public struct ComputerBridgeRequest: Codable, Sendable, Hashable {
        public enum RequestType: String, Codable, Sendable, Hashable {
            case call = "computer.call"
            case status = "computer.status"
            case release = "computer.release"
        }
        public var id: String
        public var type: RequestType
        public var token: String
        public var sessionId: String
        public var title: String?
        public var runtimeMode: RuntimeMode?
        public var callId: String?
        public var args: ComputerToolArgs?

        public init(
            id: String, type: RequestType, token: String, sessionId: String, title: String? = nil,
            runtimeMode: RuntimeMode? = nil, callId: String? = nil, args: ComputerToolArgs? = nil
        ) {
            self.id = id
            self.type = type
            self.token = token
            self.sessionId = sessionId
            self.title = title
            self.runtimeMode = runtimeMode
            self.callId = callId
            self.args = args
        }
    }

    public struct ComputerBridgeImage: Codable, Sendable, Hashable {
        public var mediaType: String
        /// Base64.
        public var data: String
        public init(mediaType: String, data: String) {
            self.mediaType = mediaType
            self.data = data
        }
    }

    public struct ComputerBridgeResponse: Codable, Sendable, Hashable {
        public var id: String
        public var ok: Bool
        public var text: String
        public var image: ComputerBridgeImage?
        /// Always a `.computerAction`; typed as the union so it encodes its `kind`.
        public var item: TurnItem?
        public var missingPermissions: [String]?
        public var holder: DesktopLockRecord?
        public var endsTurn: Bool?

        public init(
            id: String, ok: Bool, text: String, image: ComputerBridgeImage? = nil, item: TurnItem? = nil,
            missingPermissions: [String]? = nil, holder: DesktopLockRecord? = nil, endsTurn: Bool? = nil
        ) {
            self.id = id
            self.ok = ok
            self.text = text
            self.image = image
            self.item = item
            self.missingPermissions = missingPermissions
            self.holder = holder
            self.endsTurn = endsTurn
        }
    }

    /// One normalized thread item (SPEC §3.2), discriminated by `kind`.
    public enum TurnItem: Codable, Sendable, Hashable {
        case userMessage(UserMessage)
        case assistantMessage(AssistantMessage)
        case reasoning(Reasoning)
        case plan(Plan)
        case todoList(TodoList)
        case userInputRequest(UserInputRequest)
        case fileChange(FileChange)
        case commandExecution(CommandExecution)
        case search(Search)
        case webSearch(WebSearch)
        case approvalRequest(ApprovalRequest)
        case checkpoint(Checkpoint)
        case interrupt(Interrupt)
        case systemNotice(SystemNotice)
        case error(ErrorNotice)
        case compaction(Compaction)
        case handoff(Handoff)
        case subagent(Subagent)
        case computerAction(ComputerAction)
        /// A kind this build does not know; carries its raw kind and id.
        case unknown(kind: String, id: String)

        private enum DiscriminatorKeys: String, CodingKey { case kind, id }

        public init(from decoder: any Decoder) throws {
            let keys = try decoder.container(keyedBy: DiscriminatorKeys.self)
            let raw = try keys.decode(String.self, forKey: .kind)
            guard let kind = TurnItemKind(rawValue: raw) else {
                self = .unknown(kind: raw, id: try keys.decodeIfPresent(String.self, forKey: .id) ?? "")
                return
            }
            switch kind {
            case .userMessage: self = .userMessage(try UserMessage(from: decoder))
            case .assistantMessage: self = .assistantMessage(try AssistantMessage(from: decoder))
            case .reasoning: self = .reasoning(try Reasoning(from: decoder))
            case .plan: self = .plan(try Plan(from: decoder))
            case .todoList: self = .todoList(try TodoList(from: decoder))
            case .userInputRequest: self = .userInputRequest(try UserInputRequest(from: decoder))
            case .fileChange: self = .fileChange(try FileChange(from: decoder))
            case .commandExecution: self = .commandExecution(try CommandExecution(from: decoder))
            case .search: self = .search(try Search(from: decoder))
            case .webSearch: self = .webSearch(try WebSearch(from: decoder))
            case .approvalRequest: self = .approvalRequest(try ApprovalRequest(from: decoder))
            case .checkpoint: self = .checkpoint(try Checkpoint(from: decoder))
            case .interrupt: self = .interrupt(try Interrupt(from: decoder))
            case .systemNotice: self = .systemNotice(try SystemNotice(from: decoder))
            case .error: self = .error(try ErrorNotice(from: decoder))
            case .compaction: self = .compaction(try Compaction(from: decoder))
            case .handoff: self = .handoff(try Handoff(from: decoder))
            case .subagent: self = .subagent(try Subagent(from: decoder))
            case .computerAction: self = .computerAction(try ComputerAction(from: decoder))
            }
        }

        public func encode(to encoder: any Encoder) throws {
            if case let .unknown(kind, id) = self {
                var keys = encoder.container(keyedBy: DiscriminatorKeys.self)
                try keys.encode(kind, forKey: .kind)
                try keys.encode(id, forKey: .id)
                return
            }
            try payload.encode(to: encoder)
            var keys = encoder.container(keyedBy: DiscriminatorKeys.self)
            try keys.encode(rawKind, forKey: .kind)
        }

        /// The wire `kind`.
        public var rawKind: String {
            switch self {
            case .userMessage: TurnItemKind.userMessage.rawValue
            case .assistantMessage: TurnItemKind.assistantMessage.rawValue
            case .reasoning: TurnItemKind.reasoning.rawValue
            case .plan: TurnItemKind.plan.rawValue
            case .todoList: TurnItemKind.todoList.rawValue
            case .userInputRequest: TurnItemKind.userInputRequest.rawValue
            case .fileChange: TurnItemKind.fileChange.rawValue
            case .commandExecution: TurnItemKind.commandExecution.rawValue
            case .search: TurnItemKind.search.rawValue
            case .webSearch: TurnItemKind.webSearch.rawValue
            case .approvalRequest: TurnItemKind.approvalRequest.rawValue
            case .checkpoint: TurnItemKind.checkpoint.rawValue
            case .interrupt: TurnItemKind.interrupt.rawValue
            case .systemNotice: TurnItemKind.systemNotice.rawValue
            case .error: TurnItemKind.error.rawValue
            case .compaction: TurnItemKind.compaction.rawValue
            case .handoff: TurnItemKind.handoff.rawValue
            case .subagent: TurnItemKind.subagent.rawValue
            case .computerAction: TurnItemKind.computerAction.rawValue
            case let .unknown(kind, _): kind
            }
        }

        public var id: String {
            switch self {
            case let .userMessage(v): v.id
            case let .assistantMessage(v): v.id
            case let .reasoning(v): v.id
            case let .plan(v): v.id
            case let .todoList(v): v.id
            case let .userInputRequest(v): v.id
            case let .fileChange(v): v.id
            case let .commandExecution(v): v.id
            case let .search(v): v.id
            case let .webSearch(v): v.id
            case let .approvalRequest(v): v.id
            case let .checkpoint(v): v.id
            case let .interrupt(v): v.id
            case let .systemNotice(v): v.id
            case let .error(v): v.id
            case let .compaction(v): v.id
            case let .handoff(v): v.id
            case let .subagent(v): v.id
            case let .computerAction(v): v.id
            case let .unknown(_, id): id
            }
        }

        private var payload: any Encodable {
            switch self {
            case let .userMessage(v): v
            case let .assistantMessage(v): v
            case let .reasoning(v): v
            case let .plan(v): v
            case let .todoList(v): v
            case let .userInputRequest(v): v
            case let .fileChange(v): v
            case let .commandExecution(v): v
            case let .search(v): v
            case let .webSearch(v): v
            case let .approvalRequest(v): v
            case let .checkpoint(v): v
            case let .interrupt(v): v
            case let .systemNotice(v): v
            case let .error(v): v
            case let .compaction(v): v
            case let .handoff(v): v
            case let .subagent(v): v
            case let .computerAction(v): v
            case let .unknown(kind, id): ["kind": kind, "id": id]
            }
        }
    }

    // MARK: Env-server wire protocol (SPEC §3.1)

    // contract: SESSION_STATE_VALUES
    public enum SessionState: String, Codable, Sendable, CaseIterable, Hashable {
        case idle
        case running
        case waiting
        case limited
        case error
    }

    // contract: CLIENT_COMMAND_TYPE_VALUES
    public enum ClientCommandType: String, Codable, Sendable, CaseIterable, Hashable {
        case sessionOpen = "session.open"
        case turnStart = "turn.start"
        case turnSteer = "turn.steer"
        case turnQueue = "turn.queue"
        case turnInterrupt = "turn.interrupt"
        case approvalRespond = "approval.respond"
        case checkpointRollback = "checkpoint.rollback"
        case providerProbe = "provider.probe"
        case providerList = "provider.list"
        case terminalOpen = "terminal.open"
        case terminalWrite = "terminal.write"
        case terminalResize = "terminal.resize"
        case terminalClose = "terminal.close"
        case checkpointDiff = "checkpoint.diff"
        case providerSetup = "provider.setup"
        case sessionList = "session.list"
        case sessionClose = "session.close"
        case envConfigure = "env.configure"
    }

    /// The git worktree a session runs in (`SessionSnapshot.worktree`).
    public struct WorktreeInfo: Codable, Sendable, Hashable {
        public var path: String
        public var branch: String
        public var repoRoot: String
    }

    // contract: PROVIDER_SETUP_ACTION_VALUES
    public enum ProviderSetupAction: String, Codable, Sendable, CaseIterable, Hashable {
        case install
        case login
    }

    /// A step the user runs in an in-app terminal (`provider.setup` result). The
    /// server never runs it; the client opens a terminal with `command` typed in.
    public struct ProviderSetupStep: Codable, Sendable, Hashable {
        public var action: ProviderSetupAction
        public var command: String
        public var label: String
        public var note: String?
        public var url: String?
    }

    /// One row of `session.list`.
    public struct SessionSummary: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var cwd: String
        public var title: String?
        public var state: SessionState
        public var selection: ModelSelection
        public var updatedAt: String
        public var lastSequence: Int
        public var parentSessionId: String?
    }

    // contract: SERVER_EVENT_TYPE_VALUES
    public enum ServerEventType: String, Codable, Sendable, CaseIterable, Hashable {
        case sessionSnapshot = "session.snapshot"
        case sessionState = "session.state"
        case turnStarted = "turn.started"
        case turnCompleted = "turn.completed"
        case itemAdded = "item.added"
        case itemUpdated = "item.updated"
        case itemDelta = "item.delta"
        case queueUpdated = "queue.updated"
        case usageUpdated = "usage.updated"
        case providerUpdated = "provider.updated"
        case terminalOutput = "terminal.output"
        case terminalExited = "terminal.exited"
    }

    // contract: TURN_OUTCOME_VALUES
    public enum TurnOutcome: String, Codable, Sendable, CaseIterable, Hashable {
        case completed
        case interrupted
        case failed
        case limited
    }

    // contract: WIRE_ERROR_CODE_VALUES
    public enum WireErrorCode: String, Codable, Sendable, CaseIterable, Hashable {
        case badRequest = "bad_request"
        case notFound = "not_found"
        case unsupported
        case notReady = "not_ready"
        case limited
        case conflict
        case `internal`
    }

    public struct SessionUsage: Codable, Sendable, Hashable {
        public var inputTokens: Int
        public var outputTokens: Int
        public var cachedInputTokens: Int?
        public var contextTokens: Int?
        public var contextWindow: Int?
        public var costUsd: Double?
    }

    public struct QueuedInput: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var input: UserInput
        public var queuedAt: String
    }

    public struct SessionSnapshot: Codable, Sendable, Hashable {
        public var id: String
        public var cwd: String
        public var title: String?
        public var selection: ModelSelection
        public var routing: RoleRouting?
        public var runtimeMode: RuntimeMode
        public var interactionMode: InteractionMode
        public var state: SessionState
        public var activeTurnId: String?
        public var resumeAt: String?
        public var items: [TurnItem]
        public var queue: [QueuedInput]
        public var usage: SessionUsage?
        public var worktree: WorktreeInfo?
    }

    /// A client → server command. `params` stays a JSON tree so one type can
    /// carry every command; the typed builders below spell the common ones.
    public struct ClientCommand: Codable, Sendable, Hashable {
        public var id: String
        public var type: ClientCommandType
        public var params: JSONValue

        public init(id: String, type: ClientCommandType, params: JSONValue) {
            self.id = id
            self.type = type
            self.params = params
        }

        public static func encodeParams(_ value: some Encodable) throws -> JSONValue {
            try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        }
    }

    public struct WireError: Codable, Sendable, Hashable {
        public var code: WireErrorCode
        public var message: String
    }

    public struct ServerResponse: Codable, Sendable, Hashable {
        public var type: String = "response"
        public var id: String
        public var ok: Bool
        public var result: JSONValue?
        public var error: WireError?
    }

    /// A server → client event, discriminated by `type`.
    public enum ServerEvent: Codable, Sendable, Hashable {
        case sessionSnapshot(snapshotSequence: Int, session: SessionSnapshot)
        case sessionState(state: SessionState, resumeAt: String?, message: String?)
        case turnStarted(turnId: String, selection: ModelSelection)
        case turnCompleted(turnId: String, outcome: TurnOutcome, usage: SessionUsage?)
        case itemAdded(TurnItem)
        case itemUpdated(TurnItem)
        case itemDelta(itemId: String, field: String, append: String)
        case queueUpdated([QueuedInput])
        case usageUpdated(SessionUsage)
        case providerUpdated(ProviderInstance)
        case terminalOutput(terminalId: String, data: String)
        case terminalExited(terminalId: String, exitCode: Int?)
        case unknown(type: String)

        private enum Keys: String, CodingKey {
            case type, snapshotSequence, session, state, resumeAt, message, turnId, selection, outcome, usage
            case item, itemId, field, append, queue, instance, terminalId, data, exitCode
        }

        public var type: String {
            switch self {
            case .sessionSnapshot: ServerEventType.sessionSnapshot.rawValue
            case .sessionState: ServerEventType.sessionState.rawValue
            case .turnStarted: ServerEventType.turnStarted.rawValue
            case .turnCompleted: ServerEventType.turnCompleted.rawValue
            case .itemAdded: ServerEventType.itemAdded.rawValue
            case .itemUpdated: ServerEventType.itemUpdated.rawValue
            case .itemDelta: ServerEventType.itemDelta.rawValue
            case .queueUpdated: ServerEventType.queueUpdated.rawValue
            case .usageUpdated: ServerEventType.usageUpdated.rawValue
            case .providerUpdated: ServerEventType.providerUpdated.rawValue
            case .terminalOutput: ServerEventType.terminalOutput.rawValue
            case .terminalExited: ServerEventType.terminalExited.rawValue
            case let .unknown(type): type
            }
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            let raw = try c.decode(String.self, forKey: .type)
            guard let type = ServerEventType(rawValue: raw) else {
                self = .unknown(type: raw)
                return
            }
            switch type {
            case .sessionSnapshot:
                self = .sessionSnapshot(
                    snapshotSequence: try c.decode(Int.self, forKey: .snapshotSequence),
                    session: try c.decode(SessionSnapshot.self, forKey: .session)
                )
            case .sessionState:
                self = .sessionState(
                    state: try c.decode(SessionState.self, forKey: .state),
                    resumeAt: try c.decodeIfPresent(String.self, forKey: .resumeAt),
                    message: try c.decodeIfPresent(String.self, forKey: .message)
                )
            case .turnStarted:
                self = .turnStarted(
                    turnId: try c.decode(String.self, forKey: .turnId),
                    selection: try c.decode(ModelSelection.self, forKey: .selection)
                )
            case .turnCompleted:
                self = .turnCompleted(
                    turnId: try c.decode(String.self, forKey: .turnId),
                    outcome: try c.decode(TurnOutcome.self, forKey: .outcome),
                    usage: try c.decodeIfPresent(SessionUsage.self, forKey: .usage)
                )
            case .itemAdded: self = .itemAdded(try c.decode(TurnItem.self, forKey: .item))
            case .itemUpdated: self = .itemUpdated(try c.decode(TurnItem.self, forKey: .item))
            case .itemDelta:
                self = .itemDelta(
                    itemId: try c.decode(String.self, forKey: .itemId),
                    field: try c.decode(String.self, forKey: .field),
                    append: try c.decode(String.self, forKey: .append)
                )
            case .queueUpdated: self = .queueUpdated(try c.decode([QueuedInput].self, forKey: .queue))
            case .usageUpdated: self = .usageUpdated(try c.decode(SessionUsage.self, forKey: .usage))
            case .providerUpdated: self = .providerUpdated(try c.decode(ProviderInstance.self, forKey: .instance))
            case .terminalOutput:
                self = .terminalOutput(
                    terminalId: try c.decode(String.self, forKey: .terminalId),
                    data: try c.decode(String.self, forKey: .data)
                )
            case .terminalExited:
                self = .terminalExited(
                    terminalId: try c.decode(String.self, forKey: .terminalId),
                    exitCode: try c.decodeIfPresent(Int.self, forKey: .exitCode)
                )
            }
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(type, forKey: .type)
            switch self {
            case let .sessionSnapshot(sequence, session):
                try c.encode(sequence, forKey: .snapshotSequence)
                try c.encode(session, forKey: .session)
            case let .sessionState(state, resumeAt, message):
                try c.encode(state, forKey: .state)
                try c.encodeIfPresent(resumeAt, forKey: .resumeAt)
                try c.encodeIfPresent(message, forKey: .message)
            case let .turnStarted(turnId, selection):
                try c.encode(turnId, forKey: .turnId)
                try c.encode(selection, forKey: .selection)
            case let .turnCompleted(turnId, outcome, usage):
                try c.encode(turnId, forKey: .turnId)
                try c.encode(outcome, forKey: .outcome)
                try c.encodeIfPresent(usage, forKey: .usage)
            case let .itemAdded(item), let .itemUpdated(item):
                try c.encode(item, forKey: .item)
            case let .itemDelta(itemId, field, append):
                try c.encode(itemId, forKey: .itemId)
                try c.encode(field, forKey: .field)
                try c.encode(append, forKey: .append)
            case let .queueUpdated(queue): try c.encode(queue, forKey: .queue)
            case let .usageUpdated(usage): try c.encode(usage, forKey: .usage)
            case let .providerUpdated(instance): try c.encode(instance, forKey: .instance)
            case let .terminalOutput(terminalId, data):
                try c.encode(terminalId, forKey: .terminalId)
                try c.encode(data, forKey: .data)
            case let .terminalExited(terminalId, exitCode):
                try c.encode(terminalId, forKey: .terminalId)
                try c.encodeIfPresent(exitCode, forKey: .exitCode)
            case .unknown:
                break
            }
        }
    }

    public struct ServerEventEnvelope: Codable, Sendable, Hashable {
        public enum Stream: String, Codable, Sendable, Hashable { case session, global }
        public var type: String = "event"
        public var stream: Stream
        public var sessionId: String?
        public var sequence: Int
        public var at: String
        public var event: ServerEvent
    }

    /// Either half of a server → client message, discriminated by `type`.
    public enum ServerMessage: Decodable, Sendable, Hashable {
        case response(ServerResponse)
        case event(ServerEventEnvelope)
        case unknown(type: String)

        private enum Keys: String, CodingKey { case type }

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .type)
            switch raw {
            case "response": self = .response(try ServerResponse(from: decoder))
            case "event": self = .event(try ServerEventEnvelope(from: decoder))
            default: self = .unknown(type: raw)
            }
        }
    }

    public enum EventDisposition: String, Sendable, Hashable { case apply, duplicate, gap }

    /// Snapshot + cursor rule, identical to `classifyEvent` in contracts.ts:
    /// a snapshot always applies; otherwise apply iff sequence == cursor + 1.
    public static func classify(cursor: Int?, sequence: Int, event: ServerEvent) -> EventDisposition {
        if case .sessionSnapshot = event { return .apply }
        guard let cursor else { return .gap }
        if sequence <= cursor { return .duplicate }
        return sequence == cursor + 1 ? .apply : .gap
    }
}
