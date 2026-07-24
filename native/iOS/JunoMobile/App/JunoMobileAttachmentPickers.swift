import JunoChatKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The two system pickers behind the composer's `+`, wrapped as **views**.
///
/// They used to be SwiftUI's `.photosPicker` and `.fileImporter` modifiers, which
/// is the obvious way to write this and the reason attaching a file stopped
/// working. Those modifiers, plus `.sheet` for the panel and `.fullScreenCover`
/// for the camera, put four separate presentations on one button: SwiftUI
/// honours the first and drops the rest, with no error and no animation — you
/// tap Photos, the panel closes, and nothing happens. As views they all travel
/// through a single `.fullScreenCover(item:)`, so there is exactly one
/// presentation on that button and no way for them to compete.
///
/// Camera capture is its own surface — see `JunoMobileCameraCapture`.

/// A file on its way from a picker into the composer.
struct JunoPickedFile: Identifiable {
    let id = UUID()
    let data: Data
    let fileName: String
    let mimeType: String
    /// Drives the model's HEIC → JPEG transcode, which only applies to images.
    let isImage: Bool
}

/// The system photo library picker.
///
/// `PHPickerViewController` needs no photo-library permission at all in this
/// configuration — the system returns only what was chosen, and the app never
/// gains access to the rest. That is also why there is no authorization dance
/// here and why a limited-library selection needs no special handling.
struct JunoMobilePhotoPicker: UIViewControllerRepresentable {
    let selectionLimit: Int
    let onPick: ([JunoPickedFile]) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = max(1, selectionLimit)
        // `.current` hands back the original file — HEIC included. The model
        // transcodes what the server will not take, on this device, which is why
        // the server never has to decode HEIC.
        configuration.preferredAssetRepresentationMode = .current
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: PHPickerViewController, context _: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick, dismiss: { dismiss() })
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onPick: ([JunoPickedFile]) -> Void
        private let dismiss: () -> Void

        init(onPick: @escaping ([JunoPickedFile]) -> Void, dismiss: @escaping () -> Void) {
            self.onPick = onPick
            self.dismiss = dismiss
        }

        func picker(_: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !results.isEmpty else {
                dismiss()
                return
            }
            // Loading is asynchronous and per-item. The picker is dismissed only
            // once every item has resolved, so the composer receives one batch
            // and the chips appear together rather than trickling in.
            Task { @MainActor in
                var picked: [JunoPickedFile] = []
                for result in results {
                    if let file = await Self.load(result.itemProvider) { picked.append(file) }
                }
                onPick(picked)
                dismiss()
            }
        }

        private static func load(_ provider: NSItemProvider) async -> JunoPickedFile? {
            // The first registered identifier is the asset's own type, which is
            // what `.current` asked for. Asking for `.image` instead would make
            // the system transcode, losing the original.
            guard let identifier = provider.registeredTypeIdentifiers.first,
                let type = UTType(identifier), type.conforms(to: .image)
            else { return nil }
            guard let data = await withCheckedContinuation({
                (continuation: CheckedContinuation<Data?, Never>) in
                provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in
                    continuation.resume(returning: data)
                }
            }) else { return nil }
            let ext = type.preferredFilenameExtension ?? "jpg"
            return JunoPickedFile(
                data: data,
                fileName: "photo-\(UUID().uuidString.prefix(8)).\(ext)",
                mimeType: type.preferredMIMEType ?? "image/jpeg",
                isImage: true
            )
        }
    }
}

/// The system document picker.
struct JunoMobileDocumentPicker: UIViewControllerRepresentable {
    let onPick: ([URL]) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        // `asCopy: true` puts the file in the app's own container, so reading it
        // needs no security-scoped access and cannot fail later because the
        // grant was dropped.
        let controller = UIDocumentPickerViewController(
            forOpeningContentTypes: JunoAttachmentTypes.allowed, asCopy: true
        )
        controller.allowsMultipleSelection = true
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: UIDocumentPickerViewController, context _: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick, dismiss: { dismiss() })
    }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        private let onPick: ([URL]) -> Void
        private let dismiss: () -> Void

        init(onPick: @escaping ([URL]) -> Void, dismiss: @escaping () -> Void) {
            self.onPick = onPick
            self.dismiss = dismiss
        }

        func documentPicker(
            _: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
        ) {
            onPick(urls)
            dismiss()
        }

        func documentPickerWasCancelled(_: UIDocumentPickerViewController) {
            dismiss()
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
    /// Reads the URLs a document picker returned.
    ///
    /// The picker copies into the app container (`asCopy: true`), so no
    /// security-scoped access is needed — but the pair is still balanced for the
    /// case where a provider hands back a scoped URL anyway. Failing to balance
    /// it would leak the grant for the process lifetime.
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
