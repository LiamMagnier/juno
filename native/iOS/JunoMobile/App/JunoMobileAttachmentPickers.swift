import JunoChatKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The loaders behind the composer's `+`: the photo library and the document
/// picker. Camera capture is its own surface — see `JunoMobileCameraCapture`.

/// Loads the chosen photo-library items and hands their bytes to the composer.
///
/// `PhotosPicker` needs no library permission at all in its default mode — the
/// system delivers only what was chosen — which is why there is no authorization
/// dance here. Limited-library selection therefore needs no special handling
/// either: the picker shows what the reader allowed, and Juno never sees the
/// rest.
@MainActor
enum JunoPhotoLoader {
    static func load(
        _ items: [PhotosPickerItem],
        into model: NativeComposerAttachmentModel,
        conversationID: String?
    ) async {
        for item in items {
            guard model.hasCapacity else { break }
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            let ext = type?.preferredFilenameExtension ?? "jpg"
            model.add(
                data: data,
                fileName: "photo-\(UUID().uuidString.prefix(8)).\(ext)",
                mimeType: mime,
                conversationID: conversationID,
                // HEIC arrives here; the model transcodes it before upload.
                isImage: type?.conforms(to: .image) ?? true
            )
        }
    }
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
    /// Reads a security-scoped URL from the document picker.
    ///
    /// The `startAccessingSecurityScopedResource` pair is not optional: a file
    /// outside the app container is unreadable without it, and failing to
    /// balance the call leaks the grant for the process lifetime.
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
