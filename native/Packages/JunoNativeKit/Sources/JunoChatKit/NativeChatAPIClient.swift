import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

public enum NativeReasoningEffort: String, CaseIterable, Codable, Identifiable,
    Sendable
{
    case minimal
    case low
    case medium
    case high
    case xhigh
    case max

    public var id: String { rawValue }
}

/// The 1–10 grades the server publishes for a model. Never synthesized on the
/// client: a model without real numbers (Auto, which is a router) has none.
public struct NativeModelGrades: Equatable, Sendable {
    public let speed: Int
    public let intelligence: Int

    public init(speed: Int, intelligence: Int) {
        self.speed = speed
        self.intelligence = intelligence
    }
}

/// How a model can edit an existing image, as the manifest publishes it.
///
/// Never inferred from the provider id. The web keeps this table server-side
/// (`IMAGE_EDIT_SUPPORT` in `src/lib/models.ts`) and a copy here would drift the
/// first time a provider ships masking — leaving the app offering a region
/// selection to a model that ignores it, which is the exact shape of a control
/// that lies about what it does.
public enum NativeImageEditSupport: String, Equatable, Sendable {
    /// Takes a pixel mask marking the region to change.
    case mask
    /// Reference-style edits only; the region is guidance, not a boundary.
    case prompt
    /// Cannot edit an existing image.
    case none
}

public struct NativeModelPricing: Equatable, Sendable {
    /// "economy" | "standard" | "premium" — the server's relative cost class.
    public let priceClass: String
    public let inputPerMillion: Double
    public let outputPerMillion: Double
    public let currency: String

    public init(
        priceClass: String,
        inputPerMillion: Double,
        outputPerMillion: Double,
        currency: String
    ) {
        self.priceClass = priceClass
        self.inputPerMillion = inputPerMillion
        self.outputPerMillion = outputPerMillion
        self.currency = currency
    }
}

/// Why a model in the manifest cannot be selected right now. The server decides
/// this — the client only renders the explanation.
public enum NativeModelUnavailability: Equatable, Sendable {
    case comingSoon
    /// The account's plan cannot call it; the payload names the plan that can.
    case requiresPlan(String)
    /// The provider/model health probe failed or has expired. The model stays
    /// visible so a client can explain a temporary outage instead of silently
    /// forgetting the user's saved choice.
    case healthCheckFailed
    /// Present in the manifest but not a streaming chat model (image/video gen).
    case notAChatModel
}

public struct NativeChatModelOption: Identifiable, Equatable, Sendable {
    public let id: String
    public let providerID: String
    public let providerName: String
    public let displayName: String
    public let summary: String?
    /// Product-authored bullets. Non-empty only for Auto today.
    public let highlights: [String]
    public let minimumPlan: String
    /// The plan the chat route actually enforces (paid models are Pro-floored).
    public let requiredPlan: String
    public let availability: String
    public let lifecycle: String
    /// What the model produces: "chat", "image" or "video". Drives the picker's
    /// top-level sections.
    public let modality: String
    /// Superseded within its family — collapsed behind "Older models" rather
    /// than interleaved with the current generation.
    public let isLegacy: Bool
    /// "YYYY-MM", or nil when the lab never published one.
    public let released: String?
    public let contextWindowTokens: Int?
    public let pricing: NativeModelPricing?
    public let grades: NativeModelGrades?
    public let supportedReasoningEfforts: [NativeReasoningEffort]
    public let canDisableReasoning: Bool
    public let supportsReasoning: Bool
    /// One thinking state rather than depths (GLM-4.6, Haiku 4.5): the server
    /// takes `high` as "on" and nothing as "off", and publishes no tiers.
    public let isOnOffReasoningOnly: Bool
    /// True only for Auto: the server picks the thinking depth per message, so
    /// the client must offer no slider and send no effort.
    public let choosesReasoningAutomatically: Bool
    /// GPT-5.6's pro execution — a second axis, NOT a deeper rung on the
    /// thinking ladder. It composes with the effort rather than replacing it,
    /// which is why it never appears in `supportedReasoningEfforts`.
    public let supportsProMode: Bool
    /// What the provider's premium serving tier multiplies this model's rates
    /// by, or nil when it has no faster tier.
    ///
    /// A rate and not a flag, because the two toggles are not the same kind of
    /// thing and the UI must not imply they are: fast mode bills the same
    /// answer at 2x or 2.5x, while pro mode bills the same rate for more
    /// tokens. A client holding only a Bool cannot tell the user which premium
    /// they just agreed to.
    public let fastModeRateMultiplier: Double?

    public let supportsStreaming: Bool
    public let supportsVision: Bool
    public let supportsWebSearch: Bool
    public let supportsTools: Bool
    public let supportsAttachments: Bool
    /// What this model can do with an image it is handed. `.none` for every chat
    /// model, and for an image model on a server too old to publish the field.
    public let imageEditSupport: NativeImageEditSupport
    public let deprecationNote: String?
    /// The last day the provider serves this model, "YYYY-MM-DD", or nil when
    /// no retirement has been announced. Kept as the string the server sent
    /// rather than a `Date`: it is a calendar day, and parsing it into an
    /// instant would shift it across a timezone and show the wrong one.
    public let retiresOn: String?

    /// A streaming chat model — the only kind this composer can send to. Image
    /// and video generation entries share the manifest but are not selectable
    /// here, and are not "unavailable" either; they are a different product.
    public var isChatCapable: Bool { supportsStreaming }

    /// Whether the provider offers a premium serving tier for this model.
    public var supportsFastMode: Bool { fastModeRateMultiplier != nil }

    public var isAvailable: Bool {
        availability == "available" && supportsStreaming
    }

    public var unavailability: NativeModelUnavailability? {
        if !supportsStreaming { return .notAChatModel }
        switch availability {
        case "available": return nil
        case "coming_soon": return .comingSoon
        case "health_check_failed": return .healthCheckFailed
        default: return .requiresPlan(requiredPlan)
        }
    }

    public init(
        id: String,
        providerID: String,
        providerName: String,
        displayName: String,
        summary: String? = nil,
        highlights: [String] = [],
        minimumPlan: String,
        requiredPlan: String = "",
        availability: String,
        lifecycle: String = "active",
        modality: String = "chat",
        isLegacy: Bool = false,
        released: String? = nil,
        contextWindowTokens: Int? = nil,
        pricing: NativeModelPricing? = nil,
        grades: NativeModelGrades? = nil,
        supportedReasoningEfforts: [NativeReasoningEffort],
        canDisableReasoning: Bool,
        supportsReasoning: Bool = false,
        isOnOffReasoningOnly: Bool = false,
        choosesReasoningAutomatically: Bool = false,
        supportsProMode: Bool = false,
        fastModeRateMultiplier: Double? = nil,
        supportsStreaming: Bool,
        supportsVision: Bool = false,
        supportsWebSearch: Bool = false,
        supportsTools: Bool = false,
        supportsAttachments: Bool = false,
        imageEditSupport: NativeImageEditSupport = .none,
        deprecationNote: String? = nil,
        retiresOn: String? = nil
    ) {
        self.id = id
        self.providerID = providerID
        self.providerName = providerName
        self.displayName = displayName
        self.summary = summary
        self.highlights = highlights
        self.minimumPlan = minimumPlan
        self.requiredPlan = requiredPlan.isEmpty ? minimumPlan : requiredPlan
        self.availability = availability
        self.lifecycle = lifecycle
        self.modality = modality
        self.isLegacy = isLegacy
        self.released = released
        self.contextWindowTokens = contextWindowTokens
        self.pricing = pricing
        self.grades = grades
        self.supportedReasoningEfforts = supportedReasoningEfforts
        self.canDisableReasoning = canDisableReasoning
        self.supportsReasoning = supportsReasoning
        self.isOnOffReasoningOnly = isOnOffReasoningOnly
        self.choosesReasoningAutomatically = choosesReasoningAutomatically
        self.supportsProMode = supportsProMode
        self.fastModeRateMultiplier = fastModeRateMultiplier
        self.supportsStreaming = supportsStreaming
        self.supportsVision = supportsVision
        self.supportsWebSearch = supportsWebSearch
        self.supportsTools = supportsTools
        self.supportsAttachments = supportsAttachments
        self.imageEditSupport = imageEditSupport
        self.deprecationNote = deprecationNote
        self.retiresOn = retiresOn
    }
}

public struct NativeChatModelCatalog: Equatable, Sendable {
    public let manifestVersion: String
    public let contractDigest: String
    public let generatedAt: Date
    public let models: [NativeChatModelOption]
}

public struct NativeAppendedUserMessage: Equatable, Sendable {
    public let id: String
    public let clientID: String
    public let content: String
    public let createdAt: Date
}

public struct NativeChatSource: Equatable, Sendable {
    public let title: String
    public let url: URL
    public let snippet: String
}

public enum NativeChatFinishReason: String, Equatable, Sendable {
    case stop
    case length
    case networkError = "network_error"
    case contextWindowExceeded = "model_context_window_exceeded"
    case sensitive
    case toolCalls = "tool_calls"
    case userStopped = "user_stopped"
    case error
    case unknown
}

public struct NativeCompletedChatMessage: Equatable, Sendable {
    public let id: String
    public let content: String
    public let reasoning: String?
    public let model: String?
    public let createdAt: Date
    public let sources: [NativeChatSource]
    public let finishReason: NativeChatFinishReason
    /// The turn's receipt, exactly as the server billed it.
    ///
    /// The `done` frame has always carried these — `serializeMessage` puts them
    /// there — and native threw them away, which is why Compare could not show
    /// what an answer cost and the transcript's footer had to wait for the row to
    /// sync back before it could. Absent stays absent: a provider that reports no
    /// usage gets no number, rather than a zero that reads as "free".
    public let promptTokens: Int?
    public let completionTokens: Int?
    /// US dollars, estimated by the server from the exact streamed usage
    /// (cache buckets included). Never computed here.
    public let costUsd: Double?
    /// Prompt-cache tokens the provider reported for this turn: a read is a hit
    /// on an existing prefix (~0.1x input), a write is the creation of one.
    ///
    /// `nil` IS NOT ZERO. A reader that showed absent as 0 would report the turn
    /// as a total cache miss, which is the opposite of what happened. Absent
    /// stays common: the provider may report no cache buckets at all.
    ///
    /// These are durable server-side now — `Message.cacheReadTokens` /
    /// `cacheWriteTokens` hold them and the `message` sync entity carries them —
    /// but THIS type is still fed only by the live `done` frame. The synced
    /// transcript's `NativeChatMessage` does not decode them yet, so a reloaded
    /// conversation still has no split on this side of the wire. See the note on
    /// `sessionCostLedgers` in `NativeConversationStore`.
    public let cacheReadTokens: Int?
    public let cacheWriteTokens: Int?

    /// The share of this turn's input that was served from cache, or nil when
    /// the split is unknown. Guards the divide: a turn with no prompt tokens
    /// has no ratio rather than a 0 that reads as a miss.
    public var cacheHitRate: Double? {
        guard let cacheReadTokens, let promptTokens, promptTokens > 0 else { return nil }
        return min(1, Double(cacheReadTokens) / Double(promptTokens))
    }

    public init(
        id: String,
        content: String,
        reasoning: String?,
        model: String?,
        createdAt: Date,
        sources: [NativeChatSource],
        finishReason: NativeChatFinishReason,
        promptTokens: Int? = nil,
        completionTokens: Int? = nil,
        costUsd: Double? = nil,
        cacheReadTokens: Int? = nil,
        cacheWriteTokens: Int? = nil
    ) {
        self.id = id
        self.content = content
        self.reasoning = reasoning
        self.model = model
        self.createdAt = createdAt
        self.sources = sources
        self.finishReason = finishReason
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.costUsd = costUsd
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
    }
}

/// A step the server reports while working, mirroring the web's
/// `ClientActivityEvent`.
///
/// Deep research is where these matter: PLAN → SEARCH → READ runs for tens of
/// seconds before a single token of the report is streamed, and without these
/// the screen shows an empty bubble and a spinner for the whole prep phase. The
/// same events also carry the warning emitted when research degrades to plain
/// chat, which the reader has to see or the answer silently is not researched.
public struct NativeChatActivity: Equatable, Sendable, Identifiable {
    public enum Kind: String, Equatable, Sendable {
        case context, model, reasoning, search, visit, write, usage, done, warning, tool
        /// A kind this build does not know. Kept rather than dropped so a
        /// server that adds one does not make the step vanish from the screen.
        case unknown
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let detail: String?
    public let url: String?

    public init(id: String, kind: Kind, title: String, detail: String?, url: String?) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.url = url
    }
}

public enum NativeChatServerEvent: Equatable, Sendable {
    case metadata(
        conversationID: String,
        userMessageID: String?,
        title: String,
        generationID: String?
    )
    case title(conversationID: String, title: String)
    case textDelta(String)
    case reasoningDelta(String)
    case sources([NativeChatSource])
    case activity(NativeChatActivity)
    /// A connector action is blocked until the person answers. This is not a
    /// terminal frame: the server keeps the provider/tool loop alive while the
    /// card is answered through `/api/approvals/:id`.
    case approval(NativeChatApproval)
    case completed(NativeCompletedChatMessage)
    case failed(
        message: String,
        finishReason: NativeChatFinishReason,
        generationID: String?,
        userMessageID: String?
    )
    /// Media generation moved a stage. Only `/api/generate` sends these.
    case mediaProgress(NativeMediaProgress)
    case ping
}

/// How far a media generation has got.
///
/// The server has always sent this frame; both native clients decoded it as a
/// `ping` and threw it away, so a phone showed nothing at all for the twenty to
/// ninety seconds an image takes. `pct` is absent on every provider that does not
/// report one, and is left absent rather than interpolated — a bar that invents
/// its own progress is worse than no bar, which is why the UI shows the stage and
/// not a percentage.
public struct NativeMediaProgress: Equatable, Sendable {
    public enum Modality: String, Equatable, Sendable {
        case image
        case video
    }

    public let modality: Modality
    /// The server's own stage word: queued, generating, polling, downloading,
    /// uploading. Carried verbatim so a stage added server-side shows up here
    /// without a client release.
    public let stage: String
    public let pct: Double?

    public init(modality: Modality, stage: String, pct: Double?) {
        self.modality = modality
        self.stage = stage
        self.pct = pct
    }
}

/// One media generation: a prompt, the model that will render it, and the
/// conversation it belongs to (absent for the first message of a new one).
public struct NativeMediaGenerationRequest: Equatable, Sendable {
    /// A rectangle on the source image, in normalised 0…1 coordinates from the
    /// top-left. The server's schema bounds every component to 0…1, so this is
    /// clamped here rather than being allowed to cost a round trip.
    public struct Region: Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
            // Rounded to four places, as the web does. The extra precision is
            // sub-pixel on any real image and only makes the request larger.
            func round4(_ value: Double) -> Double { (clamp(value) * 10_000).rounded() / 10_000 }
            self.x = round4(x)
            self.y = round4(y)
            self.width = round4(width)
            self.height = round4(height)
        }
    }

    /// Editing an image the account already has, rather than generating a new one.
    public struct Edit: Equatable, Sendable {
        /// The attachment being edited. The server reads its bytes from storage;
        /// the client never uploads the source again.
        public let attachmentID: String
        /// Absent means "the whole image".
        public let region: Region?
        /// A `data:image/png;base64,…` mask: transparent inside the region,
        /// opaque black outside — the OpenAI `images.edit` convention.
        ///
        /// Only sent to a model whose ``NativeImageEditSupport`` is `.mask`. A
        /// `.prompt` model takes the region as guidance and would ignore it, and
        /// sending an 8 MB PNG to be ignored is not free.
        public let maskDataURL: String?

        public init(attachmentID: String, region: Region? = nil, maskDataURL: String? = nil) {
            self.attachmentID = attachmentID
            self.region = region
            self.maskDataURL = maskDataURL
        }
    }

    public let conversationID: String?
    public let prompt: String
    public let modelID: String
    /// Fixed by the model the caller chose, and carried because the server's
    /// progress frames do not name it.
    public let modality: NativeMediaProgress.Modality
    /// Present only when this is an edit of an existing image.
    public let edit: Edit?

    public init(
        conversationID: String?,
        prompt: String,
        modelID: String,
        modality: NativeMediaProgress.Modality,
        edit: Edit? = nil
    ) {
        self.conversationID = conversationID
        self.prompt = prompt
        self.modelID = modelID
        self.modality = modality
        self.edit = edit
    }
}

public struct NativeChatGenerationRequest: Equatable, Sendable {
    public let conversationID: String
    public let modelID: String
    public let reasoningEffort: NativeReasoningEffort?
    public let generationID: String
    /// Runs the server's PLAN → SEARCH → READ → SYNTHESIS pipeline instead of a
    /// plain turn. This is the same switch the web sets; the research itself is
    /// server-side, so parity is sending the flag and rendering what comes
    /// back, not reimplementing the pipeline.
    public let deepResearch: Bool
    /// Lets the model reach the live web for this turn. The server still gates
    /// it on the plan and on the model's own capability (`useWebSearch` in
    /// `/api/chat`), so this is a request rather than an instruction.
    public let webSearch: Bool
    /// Whether the model may answer with a `<juno:artifact>`. Optional because
    /// the server's default is *on* — sending `false` is a real instruction and
    /// sending nothing must keep the previous behaviour.
    public let canvasEnabled: Bool?
    /// The connected apps this turn may act through, by connector id. Empty
    /// means "none", which is also the server's default.
    public let connectors: [String]
    /// The provider's premium serving tier for this turn (2x–2.5x the normal
    /// rate). Like `webSearch` this is a request, not an instruction: the route
    /// re-checks the model actually has a faster tier and ignores it otherwise.
    public let fastMode: Bool
    /// GPT-5.6 pro execution for this turn — the same rate, spent on more
    /// tokens. Independent of `reasoningEffort`: a turn can be pro at Low.
    public let proMode: Bool

    public init(
        conversationID: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?,
        generationID: String,
        deepResearch: Bool = false,
        webSearch: Bool = false,
        canvasEnabled: Bool? = nil,
        connectors: [String] = [],
        fastMode: Bool = false,
        proMode: Bool = false
    ) {
        self.conversationID = conversationID
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.generationID = generationID
        self.deepResearch = deepResearch
        self.webSearch = webSearch
        self.canvasEnabled = canvasEnabled
        self.connectors = connectors
        self.fastMode = fastMode
        self.proMode = proMode
    }
}

/// One finalized turn of an incognito conversation, sent with every request.
///
/// Incognito chats have no server-side history to read back, so the whole
/// transcript travels with each turn. That is the server's contract, not a
/// shortcut: `/api/chat`'s private branch takes `privateHistory` precisely
/// because it writes nothing it could later look up.
public struct NativeChatPrivateTurn: Equatable, Sendable, Encodable {
    public enum Role: String, Equatable, Sendable, Encodable {
        case user = "USER"
        case assistant = "ASSISTANT"
    }

    public let role: Role
    public let content: String

    public init(role: Role, content: String) {
        self.role = role
        self.content = content
    }
}

/// An incognito generation: no conversation, nothing stored.
///
/// A separate type from ``NativeChatGenerationRequest`` on purpose. The two are
/// mutually exclusive at the wire level — the server's private branch takes no
/// `conversationId` and **rejects `regenerate` with a 400** — and the normal path
/// always sends both. Modelling incognito as a flag on the normal request would
/// have meant one struct whose valid field combinations depend on a boolean, and
/// the first mistake would have been a runtime 400 rather than a compile error.
public struct NativeChatPrivateGenerationRequest: Equatable, Sendable {
    public let modelID: String
    public let reasoningEffort: NativeReasoningEffort?
    public let generationID: String
    /// The whole conversation so far, oldest first, INCLUDING the turn being sent.
    public let history: [NativeChatPrivateTurn]
    /// Incognito honours both modes, because the server does: `/api/chat`'s
    /// private branch reads `fastMode`/`proMode` from the same input as the
    /// saved branch. Leaving them off here would have made the two paths quietly
    /// different — the same toggle, in the same composer, billing differently
    /// depending on whether the chat happened to be private.
    public let fastMode: Bool
    public let proMode: Bool

    public init(
        modelID: String,
        reasoningEffort: NativeReasoningEffort?,
        generationID: String,
        history: [NativeChatPrivateTurn],
        fastMode: Bool = false,
        proMode: Bool = false
    ) {
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.generationID = generationID
        self.history = history
        self.fastMode = fastMode
        self.proMode = proMode
    }
}

public enum NativeChatAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier(String)
    case invalidMessage
    case malformedResponse
    case invalidContentType
    case eventLineTooLarge
    case eventPayloadTooLarge
    case streamEndedWithoutTerminalEvent
    case approvalDigestMismatch
    case server(
        statusCode: Int,
        code: String?,
        message: String,
        retryable: Bool
    )

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier(let value):
            // Names the failure and the value, because the previous wording —
            // "Juno could not safely address this conversation" — reads as a
            // moderation refusal of what the user wrote. It is not: this is a
            // client-side format check on an internal id that never left the
            // Mac, and blaming the user's message for it sends them looking in
            // exactly the wrong place.
            """
            Juno rejected an internal identifier before sending (\(value)). \
            This is a bug in Juno, not a problem with your message.
            """
        case .invalidMessage:
            "Enter a message before sending."
        case .malformedResponse, .invalidContentType,
             .eventLineTooLarge, .eventPayloadTooLarge:
            "Juno returned an invalid chat response."
        case .streamEndedWithoutTerminalEvent:
            "The live response was interrupted. Juno is reconnecting to saved data."
        case .approvalDigestMismatch:
            "Juno refused this approval because the action changed. Nothing was sent."
        case .server(_, _, let message, _):
            message
        }
    }

    public var isRetryable: Bool {
        switch self {
        case .server(_, _, _, let retryable): retryable
        case .streamEndedWithoutTerminalEvent: true
        default: false
        }
    }
}

public protocol NativeChatRequestSending: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming {}

extension NativeAuthRuntime: NativeChatRequestSending {}

/// Uses the existing bearer-capable Web chat routes. User turns are first
/// appended through the existing idempotent transcript endpoint; `/api/chat`
/// then regenerates from that authoritative final user row. A dropped SSE is
/// never re-POSTed automatically, so reconnect cannot duplicate or double-bill
/// a generation that continues on the server.
public struct NativeChatAPIClient: Sendable, NativePrivateChatSending {
    private let sender: any NativeAuthenticatedRequestSending
    private let streamer: any NativeAuthenticatedByteStreaming

    public init(
        sender: any NativeAuthenticatedRequestSending,
        streamer: any NativeAuthenticatedByteStreaming
    ) {
        self.sender = sender
        self.streamer = streamer
    }

    public init(transport: any NativeChatRequestSending) {
        sender = transport
        streamer = transport
    }

    public func modelCatalog(for accountID: AccountID) async throws
        -> NativeChatModelCatalog
    {
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/v1/models"),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: ModelCatalogWire
        do { wire = try JSONDecoder().decode(ModelCatalogWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        guard validText(wire.manifestVersion, maximum: 128),
            wire.contractDigest.count == 64,
            wire.contractDigest.utf8.allSatisfy(Self.isLowercaseHex),
            let generatedAt = parseDate(wire.generatedAt),
            wire.models.count <= 1_000
        else { throw NativeChatAPIError.malformedResponse }

        var identifiers = Set<String>()
        let models = try wire.models.map { model -> NativeChatModelOption in
            guard validText(model.id, maximum: 200), identifiers.insert(model.id).inserted,
                validText(model.provider.id, maximum: 100),
                validText(model.provider.displayName, maximum: 200),
                validText(model.displayName, maximum: 300),
                validText(model.minimumPlan, maximum: 40),
                validText(model.availability, maximum: 40)
            else { throw NativeChatAPIError.malformedResponse }
            let efforts = try model.supportedReasoningEfforts.map { value in
                guard let effort = NativeReasoningEffort(rawValue: value) else {
                    throw NativeChatAPIError.malformedResponse
                }
                return effort
            }
            guard Set(efforts).count == efforts.count else {
                throw NativeChatAPIError.malformedResponse
            }
            // Grades are presentation-critical (the detail panel draws bars from
            // them), so a nonsense range is a malformed manifest rather than
            // something to clamp into looking real.
            if let metrics = model.metrics {
                guard (1...10).contains(metrics.speed),
                    (1...10).contains(metrics.intelligence)
                else { throw NativeChatAPIError.malformedResponse }
            }
            if let context = model.contextWindowTokens, context <= 0 {
                throw NativeChatAPIError.malformedResponse
            }
            let automatic = model.reasoning.automatic ?? false
            // A model that routes its own thinking must not also publish tiers —
            // the two together have no coherent meaning for the slider.
            guard !automatic || efforts.isEmpty else {
                throw NativeChatAPIError.malformedResponse
            }
            return NativeChatModelOption(
                id: model.id,
                providerID: model.provider.id,
                providerName: model.provider.displayName,
                displayName: model.displayName,
                summary: nonEmpty(model.description, maximum: 600),
                highlights: (model.highlights ?? []).compactMap {
                    nonEmpty($0, maximum: 300)
                },
                minimumPlan: model.minimumPlan,
                requiredPlan: nonEmpty(model.requiredPlan, maximum: 40) ?? model.minimumPlan,
                availability: model.availability,
                lifecycle: nonEmpty(model.lifecycle, maximum: 40) ?? "active",
                modality: nonEmpty(model.modality, maximum: 40) ?? "chat",
                // A manifest without the flag is an older server; fall back to
                // the lifecycle it has always sent.
                isLegacy: model.legacy ?? (model.lifecycle.map { $0 != "active" } ?? false),
                released: nonEmpty(model.released, maximum: 20),
                contextWindowTokens: model.contextWindowTokens,
                pricing: model.pricing.map {
                    NativeModelPricing(
                        priceClass: $0.class,
                        inputPerMillion: $0.inputPerMillion,
                        outputPerMillion: $0.outputPerMillion,
                        currency: $0.currency
                    )
                },
                grades: model.metrics.map {
                    NativeModelGrades(speed: $0.speed, intelligence: $0.intelligence)
                },
                supportedReasoningEfforts: efforts,
                canDisableReasoning: model.reasoning.canDisable,
                supportsReasoning: model.reasoning.supported ?? !efforts.isEmpty,
                isOnOffReasoningOnly: model.reasoning.onOffOnly ?? false,
                choosesReasoningAutomatically: automatic,
                // Auto is excluded on both: the router picks the model per
                // message, so a premium or a mode agreed to here would land
                // on a model the user never chose. The server already sends
                // false/null for it; this is the client refusing to depend
                // on that being true forever.
                supportsProMode: automatic ? false : (model.reasoning.supportsProMode ?? false),
                fastModeRateMultiplier: automatic ? nil : model.fastMode?.rateMultiplier,
                supportsStreaming: model.capabilities.streaming,
                supportsVision: model.capabilities.vision ?? false,
                supportsWebSearch: model.capabilities.webSearch ?? false,
                supportsTools: model.capabilities.tools ?? false,
                supportsAttachments: model.capabilities.attachments ?? false,
                // An unknown word from a newer server is `.none`, not a guess:
                // offering an edit mode this build does not understand would
                // send a request whose shape the client cannot get right.
                imageEditSupport: model.capabilities.imageEdit
                    .flatMap(NativeImageEditSupport.init(rawValue:)) ?? .none,
                deprecationNote: nonEmpty(model.deprecationNote, maximum: 400),
                retiresOn: nonEmpty(model.retiresOn, maximum: 10)
            )
        }
        return NativeChatModelCatalog(
            manifestVersion: wire.manifestVersion,
            contractDigest: wire.contractDigest,
            generatedAt: generatedAt,
            // Server order, verbatim. The manifest is already sorted the way the
            // web selector sorts (lab, then intelligence), and Auto leads it;
            // re-sorting here would put Auto under "J" and make the app's list
            // disagree with the website's for the same account.
            models: models
        )
    }

    public func appendUserMessage(
        conversationID: String,
        clientID: String,
        content: String,
        attachmentIDs: [String] = [],
        for accountID: AccountID
    ) async throws -> NativeAppendedUserMessage {
        try requireIdentifier(conversationID)
        try requireIdentifier(clientID)
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NativeChatAPIError.invalidMessage }
        let requestBody = AppendRequestWire(turns: [AppendTurnWire(
            clientId: clientID,
            role: "USER",
            content: trimmed,
            attachmentIds: attachmentIDs.isEmpty ? nil : attachmentIDs
        )])
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/conversations/\(conversationID)/messages",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(requestBody)
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: AppendResponseWire
        do { wire = try JSONDecoder().decode(AppendResponseWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        guard wire.conversationId == conversationID, wire.messages.count == 1,
            let message = wire.messages.first,
            message.clientId == clientID, message.role == "USER",
            validText(message.id, maximum: 256),
            let createdAt = parseDate(message.createdAt)
        else { throw NativeChatAPIError.malformedResponse }
        return NativeAppendedUserMessage(
            id: message.id,
            clientID: clientID,
            content: message.content,
            createdAt: createdAt
        )
    }

    /// Loads the approval receipt list used for recovery when a native client
    /// opens after the live chat stream was missed. `includeRecent` also brings
    /// back decided/expired receipts so the card can truthfully show what
    /// happened on another device rather than presenting a stale Allow button.
    public func chatApprovals(
        conversationID: String? = nil,
        includeRecent: Bool = false,
        for accountID: AccountID
    ) async throws -> [NativeChatApproval] {
        if let conversationID { try requireIdentifier(conversationID) }
        var queryItems: [URLQueryItem] = []
        if let conversationID {
            queryItems.append(URLQueryItem(name: "conversationId", value: conversationID))
        }
        if includeRecent {
            queryItems.append(URLQueryItem(name: "includeRecent", value: "1"))
        }
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/approvals", queryItems: queryItems),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: ApprovalListWire
        do { wire = try JSONDecoder().decode(ApprovalListWire.self, from: response.body) }
        catch { throw NativeChatAPIError.malformedResponse }
        guard wire.approvals.count <= 50 else { throw NativeChatAPIError.malformedResponse }
        return try wire.approvals.map(decodeApproval)
    }

    /// Records one user decision. The receipt digest is always echoed from the
    /// object that was rendered; the server re-checks it against the action and
    /// policy before allowing any connector call to proceed.
    public func decideChatApproval(
        _ approval: NativeChatApproval,
        decision: NativeChatApprovalDecision,
        for accountID: AccountID
    ) async throws -> NativeChatApproval {
        try requireIdentifier(approval.id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/approvals/\(approval.id)",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(ApprovalDecisionWire(
                    decision: decision.rawValue,
                    receiptDigest: approval.receiptDigest
                ))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        let wire: ApprovalDecisionResponseWire
        do {
            wire = try JSONDecoder().decode(
                ApprovalDecisionResponseWire.self,
                from: response.body
            )
        } catch {
            throw NativeChatAPIError.malformedResponse
        }
        let decided = try decodeApproval(wire.approval)
        guard decided.id == approval.id,
            decided.receiptDigest == approval.receiptDigest
        else { throw NativeChatAPIError.approvalDigestMismatch }
        return decided
    }

    /// Streams an incognito turn. Nothing about it is persisted anywhere — not on
    /// the server, and not by the caller, which must hold the transcript in memory
    /// and pass it back on the next turn.
    public func privateGenerationEvents(
        _ request: NativeChatPrivateGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        try requireIdentifier(request.modelID)
        try requireIdentifier(request.generationID)
        guard !request.history.isEmpty else { throw NativeChatAPIError.malformedResponse }
        let body = PrivateGenerationRequestWire(
            model: request.modelID,
            reasoningEffort: request.reasoningEffort?.rawValue,
            generationId: request.generationID,
            client: "app",
            privateMode: true,
            privateHistory: request.history,
            fastMode: request.fastMode ? true : nil,
            proMode: request.proMode ? true : nil
        )
        return try await streamEvents(body: try JSONEncoder().encode(body), for: accountID)
    }

    public func generationEvents(
        _ request: NativeChatGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        try requireIdentifier(request.conversationID)
        try requireIdentifier(request.modelID)
        try requireIdentifier(request.generationID)
        let body = GenerationRequestWire(
            conversationId: request.conversationID,
            model: request.modelID,
            regenerate: true,
            reasoningEffort: request.reasoningEffort?.rawValue,
            generationId: request.generationID,
            client: "app",
            deepResearch: request.deepResearch ? true : nil,
            webSearch: request.webSearch ? true : nil,
            canvasEnabled: request.canvasEnabled,
            connectors: request.connectors.isEmpty ? nil : request.connectors,
            fastMode: request.fastMode ? true : nil,
            proMode: request.proMode ? true : nil
        )
        return try await streamEvents(body: try JSONEncoder().encode(body), for: accountID)
    }

    /// A media generation: `/api/generate`, not `/api/chat`.
    ///
    /// This endpoint existed on the server from the start and no native client
    /// ever called it, which is why the model picker's Image and Video sections
    /// were selectable but inert — picking an image model sent a chat turn for a
    /// model that does not do chat.
    ///
    /// The stream is the same shape as a chat turn's (`meta` → … → `done`), and
    /// the `done` frame carries a fully serialised message with the generated file
    /// already attached, so nothing downstream needs a second code path for the
    /// result. Only `progress` is new.
    public func mediaGenerationEvents(
        _ request: NativeMediaGenerationRequest,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        try requireIdentifier(request.modelID)
        if let conversationID = request.conversationID { try requireIdentifier(conversationID) }
        let prompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        // The server's own bounds (`prompt: min(1).max(4000)`), enforced here so a
        // doomed request never costs a round trip or a metered generation.
        guard !prompt.isEmpty, prompt.count <= 4000 else {
            throw NativeChatAPIError.malformedResponse
        }
        if let edit = request.edit {
            try requireIdentifier(edit.attachmentID)
            // The server's own ceiling on a decoded mask is 8 MiB; base64 costs
            // four bytes per three, and the prefix is the rest of the slack.
            if let mask = edit.maskDataURL {
                guard mask.hasPrefix(Self.maskPrefix),
                    mask.utf8.count <= 8 * 1_024 * 1_024 * 4 / 3 + Self.maskPrefix.utf8.count + 4
                else { throw NativeChatAPIError.malformedResponse }
            }
        }
        let body = MediaGenerationRequestWire(
            conversationId: request.conversationID,
            prompt: prompt,
            model: request.modelID,
            edit: request.edit.map { edit in
                MediaEditWire(
                    attachmentId: edit.attachmentID,
                    region: edit.region.map {
                        MediaRegionWire(x: $0.x, y: $0.y, w: $0.width, h: $0.height)
                    },
                    maskDataUrl: edit.maskDataURL
                )
            }
        )
        return try await streamEvents(
            path: "/api/generate",
            mediaModality: request.modality,
            body: try JSONEncoder().encode(body),
            for: accountID
        )
    }

    /// The shared half: every mode reads the same `text/event-stream` back, so
    /// only the path and the body differ. Keeping the response handling in one
    /// place is what stops incognito — or media generation — quietly missing an
    /// event kind the normal path learns to handle later.
    private func streamEvents(
        path: String = "/api/chat",
        mediaModality: NativeMediaProgress.Modality = .image,
        body: Data,
        for accountID: AccountID
    ) async throws -> AsyncThrowingStream<NativeChatServerEvent, any Error> {
        let response = try await streamer.stream(
            try NativeBearerRequest(
                path: path,
                method: .post,
                headers: try HTTPHeaders([
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                ]),
                body: body
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw try await serverError(response)
        }
        guard response.headers["content-type"]?.lowercased()
            .hasPrefix("text/event-stream") == true
        else { throw NativeChatAPIError.invalidContentType }

        return AsyncThrowingStream { continuation in
            let relay = Task {
                do {
                    var parser = ChatSSEParser()
                    var terminal = false
                    for try await byte in response.bytes {
                        for payload in try parser.consume(byte) {
                            let event = try decodeEvent(payload, mediaModality: mediaModality)
                            continuation.yield(event)
                            if event.isTerminal { terminal = true }
                        }
                    }
                    for payload in try parser.finish() {
                        let event = try decodeEvent(payload, mediaModality: mediaModality)
                        continuation.yield(event)
                        if event.isTerminal { terminal = true }
                    }
                    guard terminal else {
                        throw NativeChatAPIError.streamEndedWithoutTerminalEvent
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in relay.cancel() }
        }
    }

    public func cancelGeneration(
        id: String,
        for accountID: AccountID
    ) async throws -> Bool {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/chat/cancel",
                method: .post,
                headers: try HTTPHeaders(["Content-Type": "application/json"]),
                body: try JSONEncoder().encode(CancelRequestWire(generationId: id))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw serverError(response)
        }
        guard let wire = try? JSONDecoder().decode(CancelResponseWire.self, from: response.body),
            wire.ok
        else { throw NativeChatAPIError.malformedResponse }
        return wire.cancelled
    }

    /// - Parameter mediaModality: what the caller asked to be generated. The
    ///   `progress` frame does not name it — the server is answering a request
    ///   whose model already fixed it — so it is carried in rather than guessed.
    ///   Irrelevant on `/api/chat`, which never sends a progress frame.
    private func decodeEvent(
        _ payload: Data,
        mediaModality: NativeMediaProgress.Modality = .image
    ) throws -> NativeChatServerEvent {
        let envelope: EventEnvelopeWire
        do { envelope = try JSONDecoder().decode(EventEnvelopeWire.self, from: payload) }
        catch { throw NativeChatAPIError.malformedResponse }
        switch envelope.type {
        case "meta":
            guard let conversationID = envelope.conversationId,
                let title = envelope.title,
                validText(conversationID, maximum: 256),
                validText(title, maximum: 1_000)
            else { throw NativeChatAPIError.malformedResponse }
            return .metadata(
                conversationID: conversationID,
                userMessageID: envelope.userMessageId,
                title: title,
                generationID: envelope.generationId
            )
        case "title":
            guard let conversationID = envelope.conversationId,
                let title = envelope.title,
                validText(conversationID, maximum: 256),
                validText(title, maximum: 1_000)
            else { throw NativeChatAPIError.malformedResponse }
            return .title(conversationID: conversationID, title: title)
        case "delta":
            guard let text = envelope.text,
                text.utf8.count <= 64 * 1_024
            else { throw NativeChatAPIError.malformedResponse }
            return .textDelta(text)
        case "reasoning":
            guard let text = envelope.text,
                text.utf8.count <= 64 * 1_024
            else { throw NativeChatAPIError.malformedResponse }
            return .reasoningDelta(text)
        case "sources":
            guard let sources = envelope.sources, sources.count <= 100 else {
                throw NativeChatAPIError.malformedResponse
            }
            return .sources(try sources.map(decodeSource))
        case "done":
            guard let message = envelope.message,
                validText(message.id, maximum: 256),
                message.role == "ASSISTANT",
                message.content.utf8.count <= 4 * 1_024 * 1_024,
                let createdAt = parseDate(message.createdAt)
            else { throw NativeChatAPIError.malformedResponse }
            let reason = NativeChatFinishReason(
                rawValue: envelope.finishReason ?? message.finishReason ?? "unknown"
            ) ?? .unknown
            return .completed(NativeCompletedChatMessage(
                id: message.id,
                content: message.content,
                reasoning: message.reasoning,
                model: message.model,
                createdAt: createdAt,
                sources: try (message.sources ?? envelope.sources ?? []).map(decodeSource),
                finishReason: reason,
                promptTokens: message.promptTokens,
                completionTokens: message.completionTokens,
                costUsd: message.costUsd,
                cacheReadTokens: message.cacheReadTokens,
                cacheWriteTokens: message.cacheWriteTokens
            ))
        case "error":
            guard let message = envelope.messageText ?? envelope.error,
                validText(message, maximum: 32 * 1_024)
            else { throw NativeChatAPIError.malformedResponse }
            return .failed(
                message: message,
                finishReason: NativeChatFinishReason(
                    rawValue: envelope.finishReason ?? "error"
                ) ?? .error,
                generationID: envelope.generationId,
                userMessageID: envelope.userMessageId
            )
        case "activity":
            guard let event = envelope.event else { return .ping }
            return .activity(NativeChatActivity(
                id: event.id,
                kind: NativeChatActivity.Kind(rawValue: event.kind) ?? .unknown,
                title: event.title,
                detail: event.detail,
                url: event.url
            ))
        case "approval":
            guard let approval = envelope.approval else {
                throw NativeChatAPIError.malformedResponse
            }
            return .approval(try decodeApproval(approval))
        case "progress":
            // The wire frame names a stage and sometimes a percentage; it does
            // NOT name the modality, because the caller already chose the model.
            // `mediaModality` is that choice, held for the life of the stream.
            return .mediaProgress(
                NativeMediaProgress(
                    modality: mediaModality,
                    stage: nonEmpty(envelope.stage, maximum: 40) ?? "generating",
                    pct: envelope.pct
                )
            )
        case "ping":
            return .ping
        default:
            throw NativeChatAPIError.malformedResponse
        }
    }

    private func decodeSource(_ wire: SourceWire) throws -> NativeChatSource {
        guard validText(wire.title, maximum: 2_000),
            wire.snippet.utf8.count <= 32 * 1_024,
            let url = URL(string: wire.url),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http",
            url.host != nil
        else { throw NativeChatAPIError.malformedResponse }
        return NativeChatSource(title: wire.title, url: url, snippet: wire.snippet)
    }

    private func decodeApproval(_ wire: ApprovalWire) throws -> NativeChatApproval {
        guard validText(wire.id, maximum: 256),
            validText(wire.surface, maximum: 80),
            validText(wire.sessionId, maximum: 256),
            validText(wire.connectorId, maximum: 200),
            validText(wire.connectorLabel, maximum: 300),
            validText(wire.toolName, maximum: 300),
            validText(wire.action, maximum: 300),
            validText(wire.preview, maximum: 8 * 1_024),
            validText(wire.receiptDigest, maximum: 200),
            let expiresAt = parseDate(wire.expiresAt),
            let createdAt = parseDate(wire.createdAt),
            wire.detail.count <= 100
        else { throw NativeChatAPIError.malformedResponse }

        if let conversationID = wire.conversationId,
            !validText(conversationID, maximum: 256)
        { throw NativeChatAPIError.malformedResponse }
        if let decidedAt = wire.decidedAt, parseDate(decidedAt) == nil {
            throw NativeChatAPIError.malformedResponse
        }
        if let completedAt = wire.completedAt, parseDate(completedAt) == nil {
            throw NativeChatAPIError.malformedResponse
        }

        // The server's serialiser already clamps these unions. A new value is
        // treated as unknown/blocked so a native build never turns an unfamiliar
        // status into an actionable button.
        let riskClass = NativeChatApprovalRiskClass(rawValue: wire.riskClass)
            ?? .unknown
        let status = NativeChatApprovalStatus(rawValue: wire.status) ?? .blocked
        return NativeChatApproval(
            id: wire.id,
            surface: wire.surface,
            sessionID: wire.sessionId,
            conversationID: wire.conversationId,
            connectorID: wire.connectorId,
            connectorLabel: wire.connectorLabel,
            toolName: wire.toolName,
            action: wire.action,
            riskClass: riskClass,
            preview: wire.preview,
            detail: wire.detail,
            receiptDigest: wire.receiptDigest,
            status: status,
            decision: wire.decision,
            canAllowScope: wire.canAllowScope,
            derivedFromUntrusted: wire.derivedFromUntrusted,
            expiresAt: expiresAt,
            decidedAt: wire.decidedAt.flatMap(parseDate),
            completedAt: wire.completedAt.flatMap(parseDate),
            createdAt: createdAt
        )
    }

    private func serverError(_ response: HTTPResponse) -> NativeChatAPIError {
        let body = try? JSONDecoder().decode(ServerErrorWire.self, from: response.body)
        let message = body?.message ?? body?.error ?? HTTPURLResponse.localizedString(
            forStatusCode: response.statusCode
        )
        return .server(
            statusCode: response.statusCode,
            code: body?.code,
            message: message,
            retryable: body?.retryable ?? (
                response.statusCode == 408
                    || response.statusCode == 409
                    || response.statusCode == 429
                    || response.statusCode >= 500
            )
        )
    }

    private func serverError(_ response: HTTPByteStreamResponse) async throws
        -> NativeChatAPIError
    {
        var data = Data()
        for try await byte in response.bytes {
            guard data.count < 64 * 1_024 else {
                throw NativeChatAPIError.eventPayloadTooLarge
            }
            data.append(byte)
        }
        return serverError(HTTPResponse(
            statusCode: response.statusCode,
            headers: response.headers,
            body: data
        ))
    }

    private func requireIdentifier(_ value: String) throws {
        guard validText(value, maximum: 256), value.utf8.allSatisfy({ byte in
            switch byte {
            case 48...57, 65...90, 97...122, 45, 46, 58, 95: true
            default: false
            }
        }) else { throw NativeChatAPIError.invalidIdentifier(value) }
    }

    private func validText(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximum
            && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    /// Optional descriptive copy: absent, blank, or over-long all collapse to
    /// nil. These fields decorate the UI rather than drive it, so an oversized
    /// one is dropped instead of failing the whole manifest.
    private func nonEmpty(_ value: String?, maximum: Int) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validText(trimmed, maximum: maximum) else { return nil }
        return trimmed
    }

    private func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = precise.date(from: value) { return value }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }

    static let maskPrefix = "data:image/png;base64,"

    private static func isLowercaseHex(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (97...102).contains(byte)
    }
}

private extension NativeChatServerEvent {
    var isTerminal: Bool {
        switch self {
        case .completed, .failed: true
        default: false
        }
    }
}

private struct ModelCatalogWire: Decodable {
    struct Model: Decodable {
        struct Provider: Decodable { let id: String; let displayName: String }
        struct Reasoning: Decodable {
            let supported: Bool?
            let canDisable: Bool
            let onOffOnly: Bool?
            let automatic: Bool?
            /// GPT-5.6's `reasoning.mode:"pro"`. Optional like its neighbours,
            /// and that is load-bearing rather than stylistic: the whole body is
            /// decoded in ONE do/catch, so a non-optional field would turn a
            /// server that predates it into an empty catalog, not a missing
            /// toggle.
            let supportsProMode: Bool?
        }
        /// The provider's premium serving tier, present only when the model has
        /// one. Absence means "no faster tier" — which is also what an older
        /// server that never sends the key says, and the two mean the same
        /// thing to the UI: no toggle.
        struct FastMode: Decodable {
            /// What the tier multiplies the published rates by (2, or 2.5 on
            /// GPT-5.5). Carried so the toggle can name the premium instead of
            /// gesturing at one.
            let rateMultiplier: Double?
        }
        struct Capabilities: Decodable {
            let streaming: Bool
            let vision: Bool?
            let webSearch: Bool?
            let tools: Bool?
            let attachments: Bool?
            let imageEdit: String?
        }
        struct Pricing: Decodable {
            let `class`: String
            let inputPerMillion: Double
            let outputPerMillion: Double
            let currency: String
        }
        struct Metrics: Decodable { let speed: Int; let intelligence: Int }
        let id: String
        let provider: Provider
        let displayName: String
        let description: String?
        let highlights: [String]?
        let availability: String
        let lifecycle: String?
        let modality: String?
        let legacy: Bool?
        let released: String?
        let minimumPlan: String
        let requiredPlan: String?
        let contextWindowTokens: Int?
        let pricing: Pricing?
        let metrics: Metrics?
        let supportedReasoningEfforts: [String]
        let reasoning: Reasoning
        let capabilities: Capabilities
        /// Sibling of `pricing` rather than a field inside it: `pricing` is null
        /// for the Auto router, so nesting would make "no pricing" have to mean
        /// "no fast mode" — true today only by coincidence.
        let fastMode: FastMode?
        let deprecationNote: String?
        let retiresOn: String?
    }
    let manifestVersion: String
    let contractDigest: String
    let generatedAt: String
    let models: [Model]
}

private struct AppendRequestWire: Encodable { let turns: [AppendTurnWire] }
private struct AppendTurnWire: Encodable {
    let clientId: String
    let role: String
    let content: String
    /// Omitted entirely when empty — the route's schema is `.strict()`, and an
    /// empty array would still be a claim of zero attachments rather than no
    /// claim at all.
    let attachmentIds: [String]?
}
private struct AppendResponseWire: Decodable {
    struct Message: Decodable {
        let clientId: String
        let id: String
        let role: String
        let content: String
        let createdAt: String
    }
    let conversationId: String
    let messages: [Message]
}
/// `/api/generate`'s body. `conversationId` is OMITTED rather than null-encoded
/// when absent — the server's schema marks it optional, and an explicit null is
/// not the same thing as an absent key to a Zod optional.
private struct MediaGenerationRequestWire: Encodable {
    let conversationId: String?
    let prompt: String
    let model: String
    /// Omitted for a plain generation, so its body is byte-identical to what it
    /// was before editing existed.
    let edit: MediaEditWire?
}

private struct MediaEditWire: Encodable {
    let attachmentId: String
    let region: MediaRegionWire?
    let maskDataUrl: String?
}

/// The server names these `w` and `h`; Swift names them `width` and `height`.
/// The wire type is where that translation lives, rather than a Swift property
/// called `w`.
private struct MediaRegionWire: Encodable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

private struct GenerationRequestWire: Encodable {
    let conversationId: String
    let model: String
    let regenerate: Bool
    let reasoningEffort: String?
    let generationId: String
    let client: String
    /// Omitted when false so a plain turn's body is byte-identical to what it
    /// was before deep research existed. The same rule covers `webSearch`,
    /// `connectors`, `fastMode` and `proMode`: the route's schema is `.strict()`
    /// and every one of these is optional there, so "off" is best said by saying
    /// nothing.
    ///
    /// Note this is the OPPOSITE of `canvasEnabled` below, whose server default
    /// is on — copying that field's shape for the two mode flags would send
    /// `false` on every ordinary turn and change every body in the app.
    let deepResearch: Bool?
    let webSearch: Bool?
    /// The exception: canvas defaults to *on* server-side, so `false` has to be
    /// sent explicitly and only `nil` means "leave it alone".
    let canvasEnabled: Bool?
    let connectors: [String]?
    let fastMode: Bool?
    let proMode: Bool?
}
/// The private branch's body. `conversationId` and `regenerate` are ABSENT rather
/// than nil-encoded: the server rejects `regenerate` outright in this mode, and an
/// explicit `null` is still a present key.
private struct PrivateGenerationRequestWire: Encodable {
    let model: String
    let reasoningEffort: String?
    let generationId: String
    let client: String
    let privateMode: Bool
    let privateHistory: [NativeChatPrivateTurn]
    /// Same omit-when-off rule as the saved branch, and present for the same
    /// reason: the server reads both flags on this path too, so leaving them out
    /// would make the identical toggle behave differently in incognito.
    let fastMode: Bool?
    let proMode: Bool?
}
private struct CancelRequestWire: Encodable { let generationId: String }
private struct CancelResponseWire: Decodable { let ok: Bool; let cancelled: Bool }

private struct SourceWire: Decodable {
    let title: String
    let url: String
    let snippet: String
}

private struct ApprovalWire: Decodable {
    let id: String
    let surface: String
    let sessionId: String
    let conversationId: String?
    let connectorId: String
    let connectorLabel: String
    let toolName: String
    let action: String
    let riskClass: String
    let preview: String
    let detail: [String: JunoJSONValue]
    let receiptDigest: String
    let status: String
    let decision: String?
    let canAllowScope: Bool
    let derivedFromUntrusted: Bool
    let expiresAt: String
    let decidedAt: String?
    let completedAt: String?
    let createdAt: String
}

private struct ApprovalListWire: Decodable {
    let approvals: [ApprovalWire]
}

private struct ApprovalDecisionWire: Encodable {
    let decision: String
    let receiptDigest: String
}

private struct ApprovalDecisionResponseWire: Decodable {
    let approval: ApprovalWire
}

private struct EventEnvelopeWire: Decodable {
    struct ActivityWire: Decodable {
        let id: String
        let kind: String
        let title: String
        let detail: String?
        let url: String?
    }
    struct Message: Decodable {
        let id: String
        let role: String
        let content: String
        let reasoning: String?
        let model: String?
        let createdAt: String
        let sources: [SourceWire]?
        let finishReason: String?
        let promptTokens: Int?
        let completionTokens: Int?
        let costUsd: Double?
        /// Only the live `done` frame carries these; a persisted row has no
        /// column for them, so they stay optional rather than defaulting to 0.
        let cacheReadTokens: Int?
        let cacheWriteTokens: Int?
    }
    let type: String
    let conversationId: String?
    let userMessageId: String?
    let title: String?
    let generationId: String?
    let text: String?
    let sources: [SourceWire]?
    let message: Message?
    let messageText: String?
    let event: ActivityWire?
    let approval: ApprovalWire?
    let error: String?
    let finishReason: String?
    /// `progress` frames only.
    let stage: String?
    let pct: Double?

    private enum CodingKeys: String, CodingKey {
        case type, conversationId, userMessageId, title, generationId, text,
             sources, message, event, approval, error, finishReason, stage, pct
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
        userMessageId = try container.decodeIfPresent(String.self, forKey: .userMessageId)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        generationId = try container.decodeIfPresent(String.self, forKey: .generationId)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        stage = try container.decodeIfPresent(String.self, forKey: .stage)
        // The server sends a fraction on some providers and a percentage on
        // others; both are tolerated and neither is invented when absent.
        pct = try container.decodeIfPresent(Double.self, forKey: .pct)
        sources = try container.decodeIfPresent([SourceWire].self, forKey: .sources)
        message = try? container.decodeIfPresent(Message.self, forKey: .message)
        messageText = try? container.decodeIfPresent(String.self, forKey: .message)
        // Tolerant on purpose: an activity payload this build cannot read must
        // not fail the whole stream, since the report itself is unaffected.
        event = try? container.decodeIfPresent(ActivityWire.self, forKey: .event)
        approval = try? container.decodeIfPresent(ApprovalWire.self, forKey: .approval)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        finishReason = try container.decodeIfPresent(String.self, forKey: .finishReason)
    }
}

private struct ServerErrorWire: Decodable {
    private struct Detail: Decodable {
        let code: String?
        let message: String?
        let retryable: Bool?
    }

    let error: String?
    let message: String?
    let code: String?
    let retryable: Bool?

    private enum CodingKeys: String, CodingKey {
        case error, message, code, retryable
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let detail = try? container.decodeIfPresent(Detail.self, forKey: .error)
        error = try? container.decodeIfPresent(String.self, forKey: .error)
        message = (try? container.decodeIfPresent(String.self, forKey: .message))
            ?? detail?.message
        code = (try? container.decodeIfPresent(String.self, forKey: .code))
            ?? detail?.code
        retryable = (try? container.decodeIfPresent(Bool.self, forKey: .retryable))
            ?? detail?.retryable
    }
}

private struct ChatSSEParser {
    // A done frame repeats the authoritative final message after the deltas.
    // Leave bounded JSON overhead above the 4 MiB message-content ceiling.
    private static let maximumLineBytes = 5 * 1_024 * 1_024
    private static let maximumEventBytes = 5 * 1_024 * 1_024
    private var line = Data()
    private var dataLines: [Data] = []
    private var eventBytes = 0

    mutating func consume(_ byte: UInt8) throws -> [Data] {
        guard byte == 0x0A else {
            guard line.count < Self.maximumLineBytes else {
                throw NativeChatAPIError.eventLineTooLarge
            }
            line.append(byte)
            return []
        }
        return try finishLine()
    }

    mutating func finish() throws -> [Data] {
        var events: [Data] = []
        if !line.isEmpty { events.append(contentsOf: try finishLine()) }
        if !dataLines.isEmpty { events.append(try dispatch()) }
        return events
    }

    private mutating func finishLine() throws -> [Data] {
        if line.last == 0x0D { line.removeLast() }
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            return dataLines.isEmpty ? [] : [try dispatch()]
        }
        if line.first == 0x3A { return [] }
        let separator = line.firstIndex(of: 0x3A)
        let field = separator.map { line[..<$0] } ?? line[...]
        guard field.elementsEqual(Data("data".utf8)) else { return [] }
        var value = separator.map { Data(line[line.index(after: $0)...]) } ?? Data()
        if value.first == 0x20 { value.removeFirst() }
        eventBytes += value.count
        guard eventBytes <= Self.maximumEventBytes else {
            throw NativeChatAPIError.eventPayloadTooLarge
        }
        dataLines.append(value)
        return []
    }

    private mutating func dispatch() throws -> Data {
        guard !dataLines.isEmpty else { throw NativeChatAPIError.malformedResponse }
        var payload = Data()
        for (index, value) in dataLines.enumerated() {
            if index > 0 { payload.append(0x0A) }
            payload.append(value)
        }
        dataLines.removeAll(keepingCapacity: true)
        eventBytes = 0
        guard !payload.isEmpty else { throw NativeChatAPIError.malformedResponse }
        return payload
    }
}
