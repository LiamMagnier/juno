import Foundation
import JunoCore
import JunoSync
import Observation

/// Runs one image edit and reports where it landed.
///
/// `/api/generate` writes the result into a conversation — a new one when the
/// request carries no `conversationId`, which is the case for an edit started
/// from the Library. So the edit does not "return an image": it produces a
/// conversation, whose id arrives in the stream's first `meta` frame and whose
/// row reaches this device on the next sync.
///
/// That is why this exists rather than the caller simply awaiting the stream.
/// The screen that started the edit needs three things it cannot get from a
/// `Task`: the live stage while twenty to ninety seconds pass, the conversation
/// to offer to open afterwards, and a failure in the house voice.
@MainActor
@Observable
public final class NativeImageEditSession {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Running. The stage word is the server's own, carried verbatim.
        case running(NativeMediaProgress)
        /// Finished, and the picture is in this conversation.
        case finished(conversationID: String?)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let client: NativeChatAPIClient
    private var work: Task<Void, Never>?

    public init(client: NativeChatAPIClient) {
        self.client = client
    }

    public var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    public func start(_ request: NativeMediaGenerationRequest, for accountID: AccountID) {
        guard !isRunning else { return }
        // No stage yet: the server has not said anything, so the surface shows
        // "Preparing" rather than a stage this client made up.
        phase = .running(NativeMediaProgress(modality: .image, stage: "queued", pct: nil))
        work = Task { [weak self] in
            await self?.consume(request, accountID: accountID)
        }
    }

    /// Abandons the local stream. The generation continues server-side and is
    /// still billed — an image is not cancellable the way a chat turn is, and
    /// pretending otherwise would be the lie.
    public func dismiss() {
        work?.cancel()
        work = nil
        phase = .idle
    }

    private func consume(
        _ request: NativeMediaGenerationRequest,
        accountID: AccountID
    ) async {
        var conversationID: String?
        do {
            let events = try await client.mediaGenerationEvents(request, for: accountID)
            for try await event in events {
                if Task.isCancelled { return }
                switch event {
                case .metadata(let id, _, _, _):
                    conversationID = id
                case .mediaProgress(let progress):
                    phase = .running(progress)
                case .completed:
                    phase = .finished(conversationID: conversationID)
                    return
                case .failed(let message, _, _, _):
                    phase = .failed(message)
                    return
                default:
                    break
                }
            }
            // The stream ended with no terminal frame. The generation may well
            // have succeeded server-side, so this does not claim it failed — it
            // says the connection did, and sync will bring the picture in.
            phase = .failed("The connection dropped before the edit finished. It may still arrive.")
        } catch is CancellationError {
            phase = .idle
        } catch {
            phase = .failed(NativeFailureMessage.presentable(error))
        }
    }
}
