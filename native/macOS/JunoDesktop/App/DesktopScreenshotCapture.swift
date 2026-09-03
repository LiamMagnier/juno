import AppKit
import ScreenCaptureKit

/// ⇧⌘1: a screenshot into the Chat composer, the way the ChatGPT chat bar
/// takes one.
///
/// The system content picker chooses the window or display, so Juno never
/// holds the Screen Recording permission for the whole screen — the reader
/// picks exactly what the model may see, every time, and macOS draws the
/// picker. One still frame is taken from the choice and handed back as PNG
/// data; no stream stays open and nothing is written to disk.
@MainActor
final class DesktopScreenshotCapture: NSObject {
    static let shared = DesktopScreenshotCapture()

    /// The picker's callbacks arrive on its own queue with a filter that is
    /// not `Sendable`; the box is what carries it to the capture task.
    private struct Selection: @unchecked Sendable {
        let filter: SCContentFilter
    }

    private var completion: ((Data) -> Void)?
    private var failure: ((String) -> Void)?
    private var isPresenting = false

    /// Presents the picker. One capture at a time; a second request while the
    /// picker is up is ignored rather than queued.
    func capture(
        completion: @escaping (Data) -> Void,
        failure: @escaping (String) -> Void
    ) {
        guard !isPresenting else { return }
        isPresenting = true
        self.completion = completion
        self.failure = failure

        let picker = SCContentSharingPicker.shared
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleWindow, .singleDisplay]
        configuration.allowsChangingSelectedContent = false
        picker.defaultConfiguration = configuration
        picker.add(self)
        picker.isActive = true
        picker.present()
    }

    private func deliver(_ data: Data) {
        completion?(data)
        tearDown()
    }

    private func fail(_ message: String) {
        failure?(message)
        tearDown()
    }

    private func tearDown() {
        let picker = SCContentSharingPicker.shared
        picker.remove(self)
        picker.isActive = false
        completion = nil
        failure = nil
        isPresenting = false
    }

    /// One frame of the chosen content, at the display's pixel scale.
    private static func snapshot(_ selection: Selection) async throws -> Data {
        let filter = selection.filter
        let configuration = SCStreamConfiguration()
        configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let representation = NSBitmapImageRep(cgImage: image)
        guard let png = representation.representation(using: .png, properties: [:]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return png
    }
}

extension DesktopScreenshotCapture: SCContentSharingPickerObserver {
    nonisolated func contentSharingPicker(
        _ picker: SCContentSharingPicker,
        didUpdateWith filter: SCContentFilter,
        for stream: SCStream?
    ) {
        let selection = Selection(filter: filter)
        Task {
            do {
                let data = try await Self.snapshot(selection)
                await MainActor.run { self.deliver(data) }
            } catch {
                let message = error.localizedDescription
                await MainActor.run { self.fail(message) }
            }
        }
    }

    nonisolated func contentSharingPicker(
        _ picker: SCContentSharingPicker,
        didCancelFor stream: SCStream?
    ) {
        Task { @MainActor in self.tearDown() }
    }

    nonisolated func contentSharingPickerStartDidFailWithError(_ error: any Error) {
        let message = error.localizedDescription
        Task { @MainActor in self.fail(message) }
    }
}
