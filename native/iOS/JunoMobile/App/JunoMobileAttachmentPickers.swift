import AVFoundation
import JunoChatKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The three ways a file gets into the composer, and the states each of them
/// can fail in.
///
/// The states matter as much as the happy path. A camera that is unavailable,
/// restricted by policy, or denied are three different situations with three
/// different remedies, and collapsing them into "couldn't open the camera"
/// leaves the reader with nothing to do about it.
enum JunoCameraAvailability: Equatable {
    case available
    /// No camera at all — the simulator, or an iPad without one.
    case unavailable
    /// Denied earlier. Recoverable, but only in Settings, so the message has to
    /// say so.
    case denied
    /// Screen Time or an MDM policy. The reader cannot grant this themselves.
    case restricted

    static func current() -> JunoCameraAvailability {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return .unavailable }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized, .notDetermined: return .available
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .unavailable
        }
    }

    var message: String? {
        switch self {
        case .available: nil
        case .unavailable: String(localized: "attachments.camera.unavailable")
        case .denied: String(localized: "attachments.camera.denied")
        case .restricted: String(localized: "attachments.camera.restricted")
        }
    }
}

/// A minimal camera capture sheet.
///
/// `UIImagePickerController` rather than a custom `AVCaptureSession`: the
/// system UI already handles the permission prompt, the flip and flash
/// controls, and the retake step, and none of that is worth reimplementing to
/// take one photo.
struct JunoCameraPicker: UIViewControllerRepresentable {
    /// Delivers JPEG bytes. The capture is encoded here rather than handed over
    /// as a `UIImage` so the composer never has to guess at a type or a name.
    let onCapture: (Data, String) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.mediaTypes = [UTType.image.identifier]
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: UIImagePickerController, context _: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, dismiss: { dismiss() })
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate
    {
        private let onCapture: (Data, String) -> Void
        private let dismiss: () -> Void

        init(onCapture: @escaping (Data, String) -> Void, dismiss: @escaping () -> Void) {
            self.onCapture = onCapture
            self.dismiss = dismiss
        }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            defer { dismiss() }
            guard let image = info[.originalImage] as? UIImage else { return }
            // `jpegData` applies the image's orientation as it encodes, so the
            // bytes handed to the composer are already upright.
            guard let data = image.jpegData(compressionQuality: 0.9) else { return }
            onCapture(data, "camera-\(Int(Date().timeIntervalSince1970)).jpg")
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) {
            dismiss()
        }
    }
}

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
