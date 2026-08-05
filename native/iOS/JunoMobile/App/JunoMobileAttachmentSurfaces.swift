import JunoChatKit
import JunoDesignSystem
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

extension View {
    /// Installs the three attachment surfaces on a chat screen.
    ///
    /// They belong here — on the screen — rather than on the `+` that opens
    /// them. A menu row is gone the instant it is chosen, and a presentation
    /// attached to a view that is disappearing is a presentation that never
    /// arrives; that is the whole history of this feature. The screen is stable
    /// for as long as the chat is, so nothing it presents can be orphaned.
    ///
    /// - Important: apply this *after* the composer's `.safeAreaInset`, so the
    ///   panels are layered above the composer rather than under it.
    func junoAttachmentSurfaces(
        coordinator: JunoMobileAttachmentCoordinator,
        attachmentModel: NativeComposerAttachmentModel?,
        conversationID: String?
    ) -> some View {
        modifier(
            JunoAttachmentSurfaces(
                coordinator: coordinator,
                attachmentModel: attachmentModel,
                conversationID: conversationID
            )
        )
    }
}

private struct JunoAttachmentSurfaces: ViewModifier {
    @Bindable var coordinator: JunoMobileAttachmentCoordinator
    let attachmentModel: NativeComposerAttachmentModel?
    let conversationID: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            // A panel covers the composer, so nothing underneath may still be
            // reachable — not by touch, and not by VoiceOver. An overlay does
            // not do this for us the way a presentation would: a background
            // view is not an accessibility element and does not swallow every
            // touch, so without this the composer stays live beneath a surface
            // nobody can see past.
            .accessibilityHidden(coordinator.isShowingPanel)
            .allowsHitTesting(!coordinator.isShowingPanel)
            // Above the composer, never inside it.
            .overlay { attachmentPanels }
            .fileImporter(
                isPresented: $coordinator.isShowingFiles,
                allowedContentTypes: JunoAttachmentTypes.allowed,
                allowsMultipleSelection: true,
                onCompletion: importFiles
            )
    }

    /// The two floating panels. Only one can ever be up — the coordinator
    /// guarantees it — so they share one overlay and one transition.
    @ViewBuilder
    private var attachmentPanels: some View {
        if coordinator.isShowingPhotos {
            JunoMobilePhotosPanel(
                selectionLimit: remainingCapacity,
                onPick: importPhotos,
                close: { coordinator.dismissPanel(.photos, reduceMotion: reduceMotion) }
            )
            .transition(.junoFloatingPanel(reduceMotion: reduceMotion))
            .zIndex(2)
        }
        if coordinator.isShowingCamera {
            JunoMobileCameraPanel(
                canAttach: attachmentModel?.hasCapacity ?? false,
                onCapture: { file in add([file]) },
                openPhotos: { coordinator.showPhotosFromCamera(reduceMotion: reduceMotion) },
                close: { coordinator.dismissCamera(reduceMotion: reduceMotion) }
            )
            .transition(.junoFloatingPanel(reduceMotion: reduceMotion))
            .zIndex(2)
        }
    }

    private var remainingCapacity: Int {
        guard let attachmentModel else { return 1 }
        return max(
            1, NativeComposerAttachmentModel.maximumAttachments - attachmentModel.attachments.count
        )
    }

    // MARK: Ingest

    /// Loads after the reader confirms. The panel closes at that commit point,
    /// while the asynchronous iCloud imports continue into the composer.
    /// Keeping the load out of the picker avoids making a slow asset download
    /// look like a stuck selection surface.
    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        coordinator.clearImportError()
        Task {
            let batch = await JunoPhotoImport.load(items)
            add(batch.files)
            if batch.failures > 0 { coordinator.reportPhotoImportFailure() }
        }
    }

    private func importFiles(_ result: Result<[URL], any Error>) {
        switch result {
        case .success(let urls):
            guard let attachmentModel else { return }
            JunoFileLoader.load(urls, into: attachmentModel, conversationID: conversationID)
        case .failure:
            // Cancelling is reported as a failure by the importer, and a
            // cancelled pick is not an error worth a line of chrome.
            break
        }
    }

    private func add(_ files: [JunoPickedFile]) {
        JunoAttachmentIngest.add(files, to: attachmentModel, conversationID: conversationID)
    }
}

/// The one place a picked file becomes a pending attachment.
///
/// Photos, files and the camera all arrive here as `JunoPickedFile`, so the
/// capacity rule and the call into the upload model exist once rather than three
/// times with three chances to drift.
@MainActor
enum JunoAttachmentIngest {
    static func add(
        _ files: [JunoPickedFile],
        to model: NativeComposerAttachmentModel?,
        conversationID: String?
    ) {
        guard let model else { return }
        for file in files where model.hasCapacity {
            model.add(
                data: file.data,
                fileName: file.fileName,
                mimeType: file.mimeType,
                conversationID: conversationID,
                isImage: file.isImage
            )
        }
    }
}

/// Loads what the system Photos picker handed back, through `Transferable`.
///
/// Nonisolated on purpose: reading a 12-megapixel asset and re-encoding it is
/// tens of milliseconds of real work, and a `nonisolated` async function runs
/// off the caller's actor — so none of it lands on the main one while the picker
/// is dismissing.
@MainActor
enum JunoPhotoImport {
    struct Batch: Sendable {
        var files: [JunoPickedFile] = []
        /// Items that could not be read: an iCloud asset that never finished
        /// downloading, or a type the server does not accept.
        var failures = 0
    }

    static func load(_ items: [PhotosPickerItem]) async -> Batch {
        var batch = Batch()
        for item in items {
            if let file = await load(item) {
                batch.files.append(file)
            } else {
                batch.failures += 1
            }
        }
        return batch
    }

    private static func load(_ item: PhotosPickerItem) async -> JunoPickedFile? {
        // The asset's own type, which is what `.current` asked for — and the
        // only way to know what the bytes are, because `Data` carries no type.
        guard let type = item.supportedContentTypes.first(where: { $0.conforms(to: .image) })
        else { return nil }
        // Nil or a throw is the honest answer for an iCloud asset that never
        // finished downloading, which is the common real failure.
        guard let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty
        else { return nil }
        return await prepare(data, type: type)
    }

    /// `nonisolated`, so the decode and re-encode run off the main actor rather
    /// than while the picker is dismissing. Passes PNG and JPEG through
    /// untouched and transcodes what the server will not take — the same shared
    /// rule the upload model applies, just run here instead of inside it.
    nonisolated private static func prepare(_ data: Data, type: UTType) async -> JunoPickedFile? {
        let name = "photo-\(UUID().uuidString.prefix(8)).\(type.preferredFilenameExtension ?? "jpg")"
        guard let prepared = try? NativeImageTranscoder.prepareForUpload(
            data: data, mimeType: type.preferredMIMEType ?? "image/jpeg", fileName: name
        ) else { return nil }
        return JunoPickedFile(
            data: prepared.data,
            fileName: prepared.fileName,
            mimeType: prepared.mimeType,
            isImage: true
        )
    }
}
