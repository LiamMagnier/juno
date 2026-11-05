import Foundation
import JunoCore

/// A picture the chat model made mid-answer (`generate_image`, audit gap G04),
/// as one activity row carries it: the web's `ClientImageGeneration`.
///
/// The row is re-sent under the same id as the call moves — generating, then
/// done with its files or failed with the cause — so the transcript replaces
/// it in place (``NativeTurnStream`` already does for every row). The finished
/// files also land on the answer as attachments, which is what every build,
/// this one included, draws; the card only adds what the files cannot say:
/// the wait, the model that made them, and why nothing came back.
public struct NativeImageGeneration: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable {
        case generating, done, failed
    }

    /// Why a picture was not made. The fifteen codes the server names, and
    /// whatever a newer server adds as ``unknown(_:)``, which a reader sees as
    /// the server's own sentence rather than a guess.
    public enum FailureCode: Equatable, Sendable {
        case noImageModel
        case notConfigured
        case providerUnavailable
        case planRequired
        case budgetExceeded
        case rateLimited
        case quotaExhausted
        case policyViolation
        case workspaceDisabled
        case editUnsupported
        case referenceMissing
        case libraryFull
        case tooManyCalls
        case notRequested
        case providerError
        case unknown(String)

        public init(wire: String) {
            switch wire {
            case "no_image_model": self = .noImageModel
            case "not_configured": self = .notConfigured
            case "provider_unavailable": self = .providerUnavailable
            case "plan_required": self = .planRequired
            case "budget_exceeded": self = .budgetExceeded
            case "rate_limited": self = .rateLimited
            case "quota_exhausted": self = .quotaExhausted
            case "policy_violation": self = .policyViolation
            case "workspace_disabled": self = .workspaceDisabled
            case "edit_unsupported": self = .editUnsupported
            case "reference_missing": self = .referenceMissing
            case "library_full": self = .libraryFull
            case "too_many_calls": self = .tooManyCalls
            case "not_requested": self = .notRequested
            case "provider_error": self = .providerError
            default: self = .unknown(wire)
            }
        }
    }

    public struct Failure: Equatable, Sendable {
        public let code: FailureCode
        /// The server's own sentence, English. Shown only where this build has
        /// no words of its own for the code.
        public let message: String
        public let model: String?
        public let plan: String?

        public init(code: FailureCode, message: String, model: String? = nil, plan: String? = nil) {
            self.code = code
            self.message = message
            self.model = model
            self.plan = plan
        }
    }

    public let callID: String
    public var status: Status
    public let prompt: String
    public let modelID: String?
    public let modelName: String?
    /// Auto chose the model, rather than the person naming one.
    public let auto: Bool
    public let aspect: String?
    public let count: Int
    public let referenceAttachmentID: String?
    /// The files made; empty until done.
    public let attachmentIDs: [String]
    /// The files as attachments, on the live stream only: they let the card
    /// draw the pictures before the `done` frame links them to the answer.
    /// Never present after a reload.
    public let images: [NativeChatAttachment]
    public var failure: Failure?

    public init(
        callID: String,
        status: Status,
        prompt: String = "",
        modelID: String? = nil,
        modelName: String? = nil,
        auto: Bool = true,
        aspect: String? = nil,
        count: Int = 1,
        referenceAttachmentID: String? = nil,
        attachmentIDs: [String] = [],
        images: [NativeChatAttachment] = [],
        failure: Failure? = nil
    ) {
        self.callID = callID
        self.status = status
        self.prompt = prompt
        self.modelID = modelID
        self.modelName = modelName
        self.auto = auto
        self.aspect = aspect
        self.count = count
        self.referenceAttachmentID = referenceAttachmentID
        self.attachmentIDs = attachmentIDs
        self.images = images
        self.failure = failure
    }

    /// The row as a finished message should draw it. The server's reader
    /// rewrites a saved "generating" row as failed, but a row that outlived
    /// its turn some other way (an older server, a cut stream) must not spin
    /// forever under an answer that is over.
    public func settled(live: Bool) -> NativeImageGeneration {
        guard !live, status == .generating else { return self }
        var copy = self
        copy.status = .failed
        copy.failure = Failure(code: .providerError, message: "The image wasn\u{2019}t finished.", model: modelName)
        return copy
    }

    /// The pictures the card must draw itself: the live ones the answer does
    /// not carry yet. Once the answer holds them as attachments they are drawn
    /// there, once, and this is empty.
    public func liveImages(answerAttachmentIDs: Set<String>) -> [NativeChatAttachment] {
        guard status == .done else { return [] }
        return images.filter { !answerAttachmentIDs.contains($0.id) }
    }

    /// The placeholder's progress, so the wait is the transcript's one
    /// tokenised, reduce-motion-aware generation surface.
    public var mediaProgress: NativeMediaProgress {
        NativeMediaProgress(modality: .image, stage: "generating", pct: nil)
    }

    /// What a finished card says under the pictures: who made them.
    public enum Caption: Equatable, Sendable {
        case autoPicked(model: String)
        case madeWith(model: String)
    }

    public var caption: Caption? {
        guard status == .done, let name = modelName, !name.isEmpty else { return nil }
        return auto ? .autoPicked(model: name) : .madeWith(model: name)
    }

    /// The failure as a sentence to localise, with its blanks filled from the
    /// failure first and the call's model second. A code whose sentence needs
    /// a model nobody named, and a code this build does not know, fall back to
    /// the server's own words.
    public enum FailureSentence: Equatable, Sendable {
        case noModel
        case notConfigured(model: String)
        case unavailable(model: String)
        case plan(model: String, plan: String)
        case budget
        case rateLimited
        case quota
        case policy
        case workspace
        case edit(model: String)
        case reference
        case libraryFull
        case tooMany
        case notRequested
        case provider(model: String)
        case message(String)
    }

    public var failureSentence: FailureSentence? {
        guard status == .failed else { return nil }
        let model = [failure?.model, modelName]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        // A failed row without its cause (an older writer): the model's own
        // failure when it is known, the bare title otherwise.
        guard let failure else { return model.map { .provider(model: $0) } ?? .message("") }
        let fallback = FailureSentence.message(failure.message)
        switch failure.code {
        case .noImageModel: return .noModel
        case .notConfigured: return model.map { .notConfigured(model: $0) } ?? fallback
        case .providerUnavailable: return model.map { .unavailable(model: $0) } ?? fallback
        case .planRequired:
            guard let model, let plan = failure.plan, !plan.isEmpty else { return fallback }
            return .plan(model: model, plan: plan)
        case .budgetExceeded: return .budget
        case .rateLimited: return .rateLimited
        case .quotaExhausted: return .quota
        case .policyViolation: return .policy
        case .workspaceDisabled: return .workspace
        case .editUnsupported: return model.map { .edit(model: $0) } ?? fallback
        case .referenceMissing: return .reference
        case .libraryFull: return .libraryFull
        case .tooManyCalls: return .tooMany
        case .notRequested: return .notRequested
        case .providerError: return model.map { .provider(model: $0) } ?? fallback
        case .unknown: return fallback
        }
    }
}

public extension NativeChatActivity {
    /// The picture rows of a message, in the order they were made, as the
    /// transcript should draw them.
    static func imageGenerations(in activity: [NativeChatActivity], live: Bool) -> [NativeImageGeneration] {
        activity.compactMap { $0.imageGeneration?.settled(live: live) }
    }
}

// MARK: - Wire

/// `ClientImageGeneration`, read field by field: a value of the wrong type
/// costs that field, and only a missing `callId` or `status` costs the card.
/// The row it rides on is never at stake (``NativeActivityWire`` reads this
/// with `try?`).
struct NativeImageGenerationWire: Decodable {
    struct FailureWire: Decodable {
        let code: String
        let message: String?
        let model: String?
        let plan: String?

        private enum CodingKeys: String, CodingKey { case code, message, model, plan }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decode(String.self, forKey: .code)
            message = try? container.decodeIfPresent(String.self, forKey: .message)
            model = try? container.decodeIfPresent(String.self, forKey: .model)
            plan = try? container.decodeIfPresent(String.self, forKey: .plan)
        }
    }

    /// `ClientAttachment`, the subset a picture tile needs.
    struct ImageWire: Decodable {
        let id: String
        let kind: String?
        let fileName: String?
        let mimeType: String?
        let size: Int?
        let url: String?
        let width: Int?
        let height: Int?

        private enum CodingKeys: String, CodingKey { case id, kind, fileName, mimeType, size, url, width, height }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            kind = try? container.decodeIfPresent(String.self, forKey: .kind)
            fileName = try? container.decodeIfPresent(String.self, forKey: .fileName)
            mimeType = try? container.decodeIfPresent(String.self, forKey: .mimeType)
            size = (try? container.decodeIfPresent(Double.self, forKey: .size)).map { Int($0.rounded()) }
            url = try? container.decodeIfPresent(String.self, forKey: .url)
            width = (try? container.decodeIfPresent(Double.self, forKey: .width)).map { Int($0.rounded()) }
            height = (try? container.decodeIfPresent(Double.self, forKey: .height)).map { Int($0.rounded()) }
        }

        /// A drawable picture or nothing: a FILE, a type the image route does
        /// not serve, or an over-long id is dropped rather than drawn broken.
        var attachment: NativeChatAttachment? {
            let mime = (mimeType ?? "image/png").lowercased()
            guard !id.isEmpty, id.utf8.count <= 256,
                  (kind?.uppercased() ?? "IMAGE") == "IMAGE",
                  NativeToolRunWire.drawableImageMimes.contains(mime)
            else { return nil }
            return NativeChatAttachment(
                id: id,
                fileName: String((fileName ?? "image").prefix(1_024)),
                mimeType: mime,
                kind: "IMAGE",
                size: max(0, size ?? 0),
                width: width.flatMap { $0 > 0 ? $0 : nil },
                height: height.flatMap { $0 > 0 ? $0 : nil },
                url: url
            )
        }
    }

    let callId: String
    let status: String
    let prompt: String?
    let modelId: String?
    let modelName: String?
    let auto: Bool?
    let aspect: String?
    let count: Int?
    let referenceAttachmentId: String?
    let attachmentIds: [String]?
    let images: LossyList<ImageWire>?
    let failure: FailureWire?

    private enum CodingKeys: String, CodingKey {
        case callId, status, prompt, modelId, modelName, auto, aspect, count, referenceAttachmentId, attachmentIds,
             images, failure
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        callId = try container.decode(String.self, forKey: .callId)
        status = try container.decode(String.self, forKey: .status)
        prompt = try? container.decodeIfPresent(String.self, forKey: .prompt)
        modelId = try? container.decodeIfPresent(String.self, forKey: .modelId)
        modelName = try? container.decodeIfPresent(String.self, forKey: .modelName)
        auto = try? container.decodeIfPresent(Bool.self, forKey: .auto)
        aspect = try? container.decodeIfPresent(String.self, forKey: .aspect)
        count = (try? container.decodeIfPresent(Double.self, forKey: .count)).map { Int($0.rounded()) }
        referenceAttachmentId = try? container.decodeIfPresent(String.self, forKey: .referenceAttachmentId)
        attachmentIds = try? container.decodeIfPresent([String].self, forKey: .attachmentIds)
        images = try? container.decodeIfPresent(LossyList<ImageWire>.self, forKey: .images)
        failure = try? container.decodeIfPresent(FailureWire.self, forKey: .failure)
    }

    /// Nil for a status this build does not know: a card in a state it cannot
    /// draw honestly is left to the row's own title.
    var generation: NativeImageGeneration? {
        guard !callId.isEmpty, callId.utf8.count <= 256,
              let state = NativeImageGeneration.Status(rawValue: status) else { return nil }
        func bounded(_ text: String?, _ limit: Int) -> String? {
            guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
            return String(trimmed.prefix(limit))
        }
        return NativeImageGeneration(
            callID: callId,
            status: state,
            prompt: bounded(prompt, 600) ?? "",
            modelID: bounded(modelId, 200),
            modelName: bounded(modelName, 120),
            auto: auto ?? true,
            aspect: bounded(aspect, 20),
            count: min(4, max(1, count ?? 1)),
            referenceAttachmentID: bounded(referenceAttachmentId, 256),
            attachmentIDs: Array((attachmentIds ?? []).filter { !$0.isEmpty && $0.utf8.count <= 256 }.prefix(8)),
            images: Array((images?.elements ?? []).compactMap(\.attachment).prefix(8)),
            failure: failure.map {
                NativeImageGeneration.Failure(
                    code: NativeImageGeneration.FailureCode(wire: String($0.code.prefix(80))),
                    message: bounded($0.message, 600) ?? "",
                    model: bounded($0.model, 120),
                    plan: bounded($0.plan, 40)
                )
            }
        )
    }
}
