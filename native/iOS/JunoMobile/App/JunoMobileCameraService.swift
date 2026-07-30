import AVFoundation
import Foundation
import JunoChatKit
import Observation
import UIKit

/// Flash states, in the order the camera's controls cycle them.
enum JunoCameraFlashMode: CaseIterable, Sendable {
    case off
    case auto
    case on

    var symbolName: String {
        switch self {
        case .off: "bolt.slash"
        case .auto: "bolt.badge.a"
        case .on: "bolt.fill"
        }
    }

    var label: LocalizedStringResource {
        switch self {
        case .off: "attachments.camera.flash.off"
        case .auto: "attachments.camera.flash.auto"
        case .on: "attachments.camera.flash.on"
        }
    }

    var captureMode: AVCaptureDevice.FlashMode {
        switch self {
        case .off: .off
        case .auto: .auto
        case .on: .on
        }
    }
}

/// What the current camera can do. Read once after configuring and again after
/// a flip, because the front camera of most iPhones has no flash.
struct JunoCameraCapabilities: Equatable, Sendable {
    var canFlip = false
    var hasFlash = false
}

/// Why there is no live preview.
///
/// Three states, not one, because "no camera on this device", "you declined
/// access" and "a policy forbids it" have three different remedies and one
/// shared useless message.
enum JunoCameraUnavailability: Error, Equatable, Sendable {
    case denied
    case restricted
    case noHardware

    var message: String {
        switch self {
        case .denied: String(localized: "attachments.camera.denied")
        case .restricted: String(localized: "attachments.camera.restricted")
        case .noHardware: String(localized: "attachments.camera.unavailable")
        }
    }

    /// Only a refusal is the reader's to reverse. A camera restricted by Screen
    /// Time or MDM is not, so sending them to Settings there would be a dead end.
    var isRecoverableInSettings: Bool { self == .denied }
}

/// The capture stack: session, input, photo output, and every AVFoundation call
/// that touches them.
///
/// **Nothing here runs on the main actor.** Configuring a session and starting
/// it are ~300 ms of synchronous work on real hardware; done on the main thread
/// they stall the panel's entrance animation, which reads as the app freezing at
/// the moment it opens the camera. Every method below is `async` and does its
/// work on `queue`, so the animation owns the main thread for the whole of the
/// panel's arrival and the preview simply fades in when the hardware is ready.
///
/// The class is `@unchecked Sendable` on the usual terms: its mutable state is
/// only ever touched inside `queue`, which is serial.
///
/// **Video** would slot in here — an `AVCaptureMovieFileOutput` alongside the
/// photo output, a `startRecording`/`stopRecording` pair, and the same
/// continuation-bridged delegate — without changing this type's shape or the
/// panel above it. It is deliberately absent rather than stubbed: the server's
/// accepted attachment set is images and documents, so a video button would be
/// a control that can only fail.
final class JunoCameraCaptureService: @unchecked Sendable {
    /// Handed to the preview layer on the main thread and never replaced.
    let session = AVCaptureSession()

    private let queue = DispatchQueue(label: "com.liammagnier.juno.camera.session")
    private let output = AVCapturePhotoOutput()
    private var position: AVCaptureDevice.Position = .back
    private var configured = false
    /// Held for the duration of one capture. AVFoundation does not retain the
    /// delegate, so without this it is deallocated before its callback and the
    /// continuation never resumes.
    private var pendingCapture: JunoPhotoCaptureDelegate?

    /// Authorizes, configures and starts, in that order. Returns the camera's
    /// capabilities, or the reason there is no camera to show.
    func prepare() async -> Result<JunoCameraCapabilities, JunoCameraUnavailability> {
        #if targetEnvironment(simulator)
        // The simulator has no capture hardware at all. Saying so beats a black
        // rectangle that looks like a bug in the app.
        return .failure(.noHardware)
        #else
        switch await Self.authorize() {
        case .success:
            break
        case .failure(let reason):
            return .failure(reason)
        }
        return await withCheckedContinuation { continuation in
            queue.async { [self] in
                guard configured || configureSession() else {
                    continuation.resume(returning: .failure(.noHardware))
                    return
                }
                if !session.isRunning { session.startRunning() }
                continuation.resume(returning: .success(capabilities()))
            }
        }
        #endif
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                if session.isRunning { session.stopRunning() }
                continuation.resume()
            }
        }
    }

    /// Swaps the active camera and reports what the new one can do.
    func flip() async -> JunoCameraCapabilities {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                let next: AVCaptureDevice.Position = position == .back ? .front : .back
                guard let input = Self.input(for: next) else {
                    continuation.resume(returning: capabilities())
                    return
                }
                session.beginConfiguration()
                for existing in session.inputs { session.removeInput(existing) }
                if session.canAddInput(input) {
                    session.addInput(input)
                    position = next
                } else if let restored = Self.input(for: position),
                    session.canAddInput(restored) {
                    session.addInput(restored)
                }
                session.commitConfiguration()
                continuation.resume(returning: capabilities())
            }
        }
    }

    /// Takes one photo. Returns nil when the capture failed, so the caller stays
    /// on the live preview rather than attaching nothing.
    func capturePhoto(flash: JunoCameraFlashMode) async -> Data? {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                guard session.isRunning else {
                    continuation.resume(returning: nil)
                    return
                }
                // JPEG where the hardware offers it: the bytes go straight into
                // a thumbnail and through the shared upload transcoder, and
                // neither has to learn to decode HEIC first.
                let settings: AVCapturePhotoSettings
                if output.availablePhotoCodecTypes.contains(.jpeg) {
                    settings = AVCapturePhotoSettings(
                        format: [AVVideoCodecKey: AVVideoCodecType.jpeg]
                    )
                } else {
                    settings = AVCapturePhotoSettings()
                }
                if output.supportedFlashModes.contains(flash.captureMode) {
                    settings.flashMode = flash.captureMode
                }
                let delegate = JunoPhotoCaptureDelegate { [weak self] data in
                    // Bound to a local before the nested hop: capturing the weak
                    // reference twice would be reading a captured `var` from two
                    // concurrent closures.
                    if let service = self {
                        service.queue.async { service.pendingCapture = nil }
                    }
                    continuation.resume(returning: data)
                }
                pendingCapture = delegate
                output.capturePhoto(with: settings, delegate: delegate)
            }
        }
    }

    // MARK: Session setup

    /// - Important: only ever called on `queue`.
    private func configureSession() -> Bool {
        session.beginConfiguration()
        session.sessionPreset = .photo
        guard let input = Self.input(for: position), session.canAddInput(input) else {
            session.commitConfiguration()
            return false
        }
        session.addInput(input)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return false
        }
        session.addOutput(output)
        session.commitConfiguration()
        configured = true
        return true
    }

    /// - Important: only ever called on `queue`.
    private func capabilities() -> JunoCameraCapabilities {
        let devices = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInDualCamera, .builtInTripleCamera],
            mediaType: .video,
            position: .unspecified
        ).devices
        return JunoCameraCapabilities(
            canFlip: devices.contains { $0.position == .front }
                && devices.contains { $0.position == .back },
            hasFlash: output.supportedFlashModes.contains { $0 != .off }
        )
    }

    private static func input(for position: AVCaptureDevice.Position) -> AVCaptureDeviceInput? {
        guard let device = AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: position
        ) else { return nil }
        return try? AVCaptureDeviceInput(device: device)
    }

    /// Statements, not a switch *expression*, and this is the second time.
    ///
    /// Swift 6.3.3 — the newest toolchain on the CI runner image — crashes in
    /// IRGen emitting the reabstraction thunk an `await` yielding `Bool` needs
    /// inside a switch expression (`@$sSbScA_pSgIeAghyg_SbIeAghn_TR`), taking
    /// the whole iOS build down with a compiler backtrace and no source line.
    /// The crash is in the compiler: the same tree builds clean on Xcode 27.
    ///
    /// `e67840c` fixed it exactly this way and `9c84d4c` reverted it along with
    /// a rewrite it was bundled into, which is why iOS CI has been red since.
    /// Same behaviour, one more line, and it compiles everywhere.
    private static func authorize() async -> Result<Void, JunoCameraUnavailability> {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .success(())
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            return granted ? .success(()) : .failure(.denied)
        case .denied: return .failure(.denied)
        case .restricted: return .failure(.restricted)
        @unknown default: return .failure(.noHardware)
        }
    }
}

/// Bridges `AVCapturePhotoCaptureDelegate` — an Objective-C callback delivered
/// on AVFoundation's own queue — to one `async` result.
///
/// The lock is not ceremony: `didFinishProcessingPhoto` can be preceded by an
/// error callback for the same capture, and resuming a continuation twice is a
/// crash rather than a warning.
private final class JunoPhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate,
    @unchecked Sendable {
    private let lock = NSLock()
    private var finish: ((Data?) -> Void)?

    init(finish: @escaping (Data?) -> Void) {
        self.finish = finish
    }

    func photoOutput(
        _: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: (any Error)?
    ) {
        complete(error == nil ? photo.fileDataRepresentation() : nil)
    }

    func photoOutput(
        _: AVCapturePhotoOutput,
        didFinishCaptureFor _: AVCaptureResolvedPhotoSettings,
        error: (any Error)?
    ) {
        guard error != nil else { return }
        complete(nil)
    }

    private func complete(_ data: Data?) {
        lock.lock()
        let finish = finish
        self.finish = nil
        lock.unlock()
        finish?(data)
    }
}

/// The camera panel's observable state.
///
/// Deliberately thin: it holds what the view draws and forwards everything else
/// to the capture service, so nothing that touches AVFoundation runs on the main
/// actor and nothing the view reads has to be fetched across an isolation
/// boundary while it draws.
@MainActor
@Observable
final class JunoCameraPanelModel {
    enum Phase: Equatable {
        case starting
        case running
        case unavailable(JunoCameraUnavailability)
    }

    private(set) var phase: Phase = .starting
    private(set) var isCapturing = false
    private(set) var capabilities = JunoCameraCapabilities()
    /// The most recent shot, shown in the panel's library button. A thumbnail,
    /// not the capture: the full frame is already on its way to the server.
    private(set) var lastCapture: UIImage?
    var flashMode: JunoCameraFlashMode = .off

    private let service = JunoCameraCaptureService()

    var session: AVCaptureSession { service.session }

    var isRunning: Bool { phase == .running }

    var unavailability: JunoCameraUnavailability? {
        if case .unavailable(let reason) = phase { return reason }
        return nil
    }

    func start() async {
        guard phase == .starting else { return }
        switch await service.prepare() {
        case .success(let capabilities):
            self.capabilities = capabilities
            phase = .running
        case .failure(let reason):
            phase = .unavailable(reason)
        }
    }

    /// Stops the hardware. Called once the panel's exit animation is under way,
    /// never before it: tearing the session down first freezes the preview on
    /// its last frame and the panel slides away holding a still.
    func stop() {
        guard phase == .running else { return }
        phase = .starting
        Task { await service.stop() }
    }

    func cycleFlash() {
        flashMode = switch flashMode {
        case .off: .auto
        case .auto: .on
        case .on: .off
        }
    }

    func flip() async {
        guard capabilities.canFlip else { return }
        capabilities = await service.flip()
    }

    /// Takes one photo and returns it ready for the composer: upright pixels,
    /// no metadata, JPEG.
    ///
    /// The preparation runs off the main actor through the same transcoder every
    /// other attachment goes through — a 12-megapixel decode is not something to
    /// do while a shutter animation is playing.
    func capture() async -> JunoPickedFile? {
        guard !isCapturing, phase == .running else { return nil }
        isCapturing = true
        defer { isCapturing = false }

        guard let data = await service.capturePhoto(flash: flashMode) else { return nil }
        let name = "photo-\(UUID().uuidString.prefix(8)).jpg"
        guard let prepared = await JunoCameraCapture.prepare(data, fileName: name) else {
            return nil
        }
        lastCapture = await JunoImageDownsampler.thumbnail(
            from: prepared.data, maxPixelSize: JunoImageDownsampler.controlThumbnailSize
        )
        return JunoPickedFile(
            data: prepared.data,
            fileName: prepared.fileName,
            mimeType: prepared.mimeType,
            isImage: true
        )
    }
}

/// Preparing a capture for upload, off the main actor.
///
/// Always transcodes, even though the bytes are already JPEG: that is what bakes
/// the orientation into the pixels and leaves the capture's EXIF behind. A photo
/// this app took should not carry the device's own metadata into a message.
enum JunoCameraCapture {
    static func prepare(_ data: Data, fileName: String) async -> NativeImageTranscoder.Output? {
        await Task.detached(priority: .userInitiated) {
            try? NativeImageTranscoder.transcodeToJPEG(data: data, fileName: fileName)
        }.value
    }
}
