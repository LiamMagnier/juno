import JunoChatKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A file on its way from a picker into the composer.
struct JunoPickedFile: Identifiable, Sendable {
    let id = UUID()
    let data: Data
    let fileName: String
    let mimeType: String
    /// Drives the model's HEIC → JPEG transcode, which only applies to images.
    let isImage: Bool
}

/// The document types the server will accept. Offering more in the picker would
/// mean letting someone choose a file that can only be rejected afterwards.
enum JunoAttachmentTypes {
    static let allowed: [UTType] = [
        .png, .jpeg, .gif, .webP, .heic, .heif,
        .pdf, .plainText, .commaSeparatedText, .json, .rtf,
        UTType(filenameExtension: "md") ?? .plainText,
        UTType(filenameExtension: "docx") ?? .data,
        UTType(filenameExtension: "xlsx") ?? .data,
    ]
}

@MainActor
enum JunoFileLoader {
    /// Reads the URLs the file importer returned.
    ///
    /// `.fileImporter` hands back security-scoped URLs, so the start/stop pair
    /// is load-bearing here rather than defensive: reading without the grant
    /// fails, and failing to balance it leaks the grant for the process
    /// lifetime.
    static func load(
        _ urls: [URL],
        into model: NativeComposerAttachmentModel,
        conversationID: String?
    ) {
        for url in urls {
            guard model.hasCapacity else { break }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            guard let data = try? Data(contentsOf: url) else { continue }
            let type = UTType(filenameExtension: url.pathExtension)
            model.add(
                data: data,
                fileName: url.lastPathComponent,
                mimeType: type?.preferredMIMEType ?? "application/octet-stream",
                conversationID: conversationID,
                isImage: type?.conforms(to: .image) ?? false
            )
        }
    }
}
