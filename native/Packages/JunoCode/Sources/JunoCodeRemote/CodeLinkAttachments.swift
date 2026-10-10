import Foundation
import JunoCodeCore

/// A file attached on this device to the next message for the Mac.
public struct CodeLinkDraftAttachment: Identifiable, Equatable, Sendable {
    public let id: UUID
    public var name: String
    public var mediaType: String
    public var data: Data

    public init(id: UUID = UUID(), name: String, mediaType: String, data: Data) {
        self.id = id
        self.name = name
        self.mediaType = mediaType
        self.data = data
    }

    public var isImage: Bool { mediaType.hasPrefix("image/") }
}

public extension CodeLinkRemoteModel {
    /// At most this many files on one message.
    static let maxAttachments = 6
    /// The largest file the phone sends (the link carries it base64; the Mac takes 5 MB).
    static let maxAttachmentBytes = 4 * 1024 * 1024

    var canAttachMore: Bool { draftAttachments.count < Self.maxAttachments }

    /// Adds files to the next message. Too large or one too many is said, not dropped in silence.
    func attach(_ files: [CodeLinkDraftAttachment]) {
        for file in files {
            guard canAttachMore else {
                lastError = "Up to \(Self.maxAttachments) files on one message."
                return
            }
            guard file.data.count <= Self.maxAttachmentBytes else {
                lastError = "\(file.name) is too large to send from the phone (4 MB at most)."
                continue
            }
            draftAttachments.append(file)
        }
    }

    func removeAttachment(_ id: UUID) {
        draftAttachments.removeAll { $0.id == id }
    }

    /// Sends the draft's files to the Mac and answers the message's attachments.
    internal func uploadDraftAttachments(_ client: CodeLinkClient, _ deviceID: String) async throws -> [CodeV2.Attachment] {
        var out: [CodeV2.Attachment] = []
        for file in draftAttachments {
            let kept = try await client.hostUpload(deviceID, name: file.name, mediaType: file.mediaType, data: file.data)
            out.append(CodeV2.Attachment(name: kept.name, mediaType: kept.mediaType, ref: kept.ref))
        }
        return out
    }
}
