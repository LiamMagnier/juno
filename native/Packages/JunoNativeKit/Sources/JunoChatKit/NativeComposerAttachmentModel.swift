import Foundation
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// One attachment on its way from the picker to a message.
public struct NativeComposerAttachment: Identifiable, Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case preparing
        case uploading
        case uploaded(id: String)
        /// `retryable` decides whether the UI offers Retry. A rejected file
        /// type never becomes acceptable, so offering one there would just be a
        /// button that fails again.
        case failed(message: String, retryable: Bool)
    }

    public let id: UUID
    /// Generated once per attachment and reused across every retry of *this*
    /// attachment, so a retry replaces the upload rather than duplicating it.
    public let idempotencyKey: String
    public var fileName: String
    public var mimeType: String
    public var byteCount: Int
    public var state: State
    /// Set for images so the composer can show a thumbnail without a round trip.
    public var previewData: Data?

    public init(
        id: UUID = UUID(),
        idempotencyKey: String = UUID().uuidString,
        fileName: String,
        mimeType: String,
        byteCount: Int,
        state: State = .preparing,
        previewData: Data? = nil
    ) {
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.fileName = fileName
        self.mimeType = mimeType
        self.byteCount = byteCount
        self.state = state
        self.previewData = previewData
    }

    public var isTerminal: Bool {
        switch state {
        case .uploaded, .failed: true
        case .preparing, .uploading: false
        }
    }

    public var uploadedID: String? {
        if case .uploaded(let id) = state { return id }
        return nil
    }
}

/// Holds the composer's pending attachments and drives their uploads.
///
/// Two rules shape this:
///
/// - **An attachment is never silently dropped.** A failure leaves the chip on
///   screen carrying its reason, because the alternative — removing it — looks
///   identical to a successful send that quietly lost a file.
/// - **Send is blocked while anything is still in flight.** Sending a message
///   that references an attachment the server has not accepted produces a
///   message with a missing file, which cannot be repaired from the client.
@MainActor
@Observable
public final class NativeComposerAttachmentModel {
    /// Matches the web composer's ceiling, so the same message is composable on
    /// either client.
    public static let maximumAttachments = 10

    public private(set) var attachments: [NativeComposerAttachment] = []
    public private(set) var lastErrorDescription: String?

    private let client: NativeAttachmentAPIClient
    private var accountID: AccountID?
    private var tasks: [UUID: Task<Void, Never>] = [:]
    /// Bytes are kept out of `attachments` so the observable state stays cheap
    /// to diff — a 4 MB `Data` in an `@Observable` array is copied on every
    /// read of any field.
    private var payloads: [UUID: Data] = [:]

    public init(client: NativeAttachmentAPIClient) {
        self.client = client
    }

    public func start(for accountID: AccountID) {
        self.accountID = accountID
    }

    public func stop() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        payloads.removeAll()
        attachments.removeAll()
        lastErrorDescription = nil
        accountID = nil
    }

    public var isUploading: Bool { attachments.contains { !$0.isTerminal } }

    public var canSend: Bool { !isUploading && !attachments.contains { $0.uploadedID == nil } }

    public var uploadedIDs: [String] { attachments.compactMap(\.uploadedID) }

    public var hasCapacity: Bool { attachments.count < Self.maximumAttachments }

    /// Adds a file and begins uploading it. Images that the server would not
    /// accept are transcoded to JPEG first, on this device, which is why the
    /// server never has to decode HEIC.
    public func add(
        data: Data,
        fileName: String,
        mimeType: String,
        conversationID: String?,
        isImage: Bool
    ) {
        guard hasCapacity else {
            lastErrorDescription =
                "You can attach up to \(Self.maximumAttachments) files to one message."
            return
        }

        var payload = data
        var name = fileName
        var mime = mimeType

        if isImage, NativeImageTranscoder.needsTranscoding(mimeType: mimeType) {
            do {
                let prepared = try NativeImageTranscoder.transcodeToJPEG(
                    data: data, fileName: fileName
                )
                payload = prepared.data
                name = prepared.fileName
                mime = prepared.mimeType
            } catch {
                // Surfaced as a chip rather than a thrown error: the reader
                // needs to see *which* file failed, and the other attachments
                // in the batch are unaffected.
                attachments.append(NativeComposerAttachment(
                    fileName: fileName, mimeType: mimeType, byteCount: data.count,
                    state: .failed(message: error.localizedDescription, retryable: false)
                ))
                return
            }
        }

        let attachment = NativeComposerAttachment(
            fileName: name,
            mimeType: mime,
            byteCount: payload.count,
            state: .preparing,
            previewData: isImage ? payload : nil
        )
        attachments.append(attachment)
        payloads[attachment.id] = payload
        beginUpload(attachment.id, conversationID: conversationID)
    }

    public func retry(_ id: UUID, conversationID: String?) {
        guard let index = attachments.firstIndex(where: { $0.id == id }),
            case .failed = attachments[index].state,
            payloads[id] != nil
        else { return }
        attachments[index].state = .preparing
        beginUpload(id, conversationID: conversationID)
    }

    public func remove(_ id: UUID) {
        tasks[id]?.cancel()
        tasks[id] = nil
        payloads[id] = nil
        attachments.removeAll { $0.id == id }
    }

    /// Called after a message is sent. Cancels nothing, because by then every
    /// upload has finished — `canSend` guarantees it.
    public func clear() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        payloads.removeAll()
        attachments.removeAll()
    }

    private func beginUpload(_ id: UUID, conversationID: String?) {
        guard let accountID,
            let index = attachments.firstIndex(where: { $0.id == id }),
            let payload = payloads[id]
        else { return }

        let attachment = attachments[index]
        attachments[index].state = .uploading
        tasks[id]?.cancel()
        tasks[id] = Task { [client] in
            do {
                let uploaded = try await client.upload(
                    data: payload,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    conversationID: conversationID,
                    idempotencyKey: attachment.idempotencyKey,
                    for: accountID
                )
                guard !Task.isCancelled else { return }
                update(id) { $0.state = .uploaded(id: uploaded.id) }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                let retryable = (error as? NativeAttachmentAPIError)?.isRetryable
                    ?? NativeFailureClassification.isConnectivityFailure(error)
                update(id) {
                    $0.state = .failed(
                        message: NativeFailureMessage.presentable(error),
                        retryable: retryable
                    )
                }
            }
            tasks[id] = nil
        }
    }

    private func update(
        _ id: UUID,
        _ change: (inout NativeComposerAttachment) -> Void
    ) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        change(&attachments[index])
    }
}
