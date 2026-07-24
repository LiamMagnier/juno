import AVFoundation
import JunoDesignSystem
import SwiftUI
import UIKit

/// Juno's own full-screen camera, presented from the composer's `+`.
///
/// **Why not `UIImagePickerController`.** The system picker is one photo behind a
/// modal that looks nothing like the rest of the app: no Juno chrome, no flash
/// or flip control of our own, and on iPad it arrives inside a form sheet. The
/// reference this was built against (ChatGPT's in-app camera) is a full-bleed
/// preview with the app's own controls, and that is what a capture surface owned
/// by the composer should be.
///
/// **The shape of the flow.** Preview → shutter → review → *Use photo*. The
/// review step is not decoration: a photo taken one-handed is wrong often
/// enough that attaching it irreversibly, into a message the reader is still
/// composing, is the wrong default. Retake returns to the live preview without
/// tearing the session down.
struct JunoMobileCameraCapture: View {
    /// JPEG bytes plus a file name, matching what the composer's attachment
    /// model wants. Encoding here means the composer never has to guess a type.
    let onCapture: (Data, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var camera = JunoCameraController()
    /// The captured frame awaiting *Use photo*. Non-nil means review mode.
    @State private var review: UIImage?
    @State private var shutterFlash = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let review {
                Image(uiImage: review)
                    .resizable()
                    .scaledToFit()
                    .ignoresSafeArea()
                    .transition(.opacity)
            } else {
                JunoCameraPreview(controller: camera)
                    .ignoresSafeArea()
                    .accessibilityIdentifier("juno.mobile.camera-preview")
            }

            // The shutter blink. A capture with no visual acknowledgement reads
            // as a control that did nothing, on the one control where that
            // doubt makes people press twice.
            if shutterFlash {
                Color.white.ignoresSafeArea().transition(.opacity)
            }

            if let message = camera.unavailableMessage {
                unavailable(message)
            } else {
                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                    bottomBar
                }
            }
        }
        .statusBarHidden(true)
        .preferredColorScheme(.dark)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: shutterFlash)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: review != nil)
        .task { await camera.start() }
        .onDisappear { camera.stop() }
    }

    // MARK: Chrome

    private var topBar: some View {
        HStack(spacing: 12) {
            Spacer(minLength: 0)
            if review == nil, camera.hasFlash {
                Button {
                    camera.cycleFlash()
                } label: {
                    Image(systemName: camera.flashMode.symbolName)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(camera.flashMode == .off ? .white : Color.junoAccent)
                        .frame(width: 40, height: 40)
                        .background(.black.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(camera.flashMode.accessibilityLabel)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    @ViewBuilder
    private var bottomBar: some View {
        if let image = review {
            HStack {
                Button("attachments.camera.retake") { review = nil }
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.white)
                Spacer(minLength: 12)
                Button {
                    use(image)
                } label: {
                    Text("attachments.camera.use")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 22)
                        .frame(height: 46)
                        .background(Color.junoAccent, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.camera-use")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 34)
        } else {
            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .background(.black.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("attachments.camera.close")

                Spacer(minLength: 0)
                shutter
                Spacer(minLength: 0)

                Button {
                    camera.flipCamera()
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .background(.black.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!camera.canFlip)
                .opacity(camera.canFlip ? 1 : 0.4)
                .accessibilityLabel("attachments.camera.flip")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 34)
        }
    }

    private var shutter: some View {
        Button {
            capture()
        } label: {
            ZStack {
                Circle().strokeBorder(.white, lineWidth: 4).frame(width: 74, height: 74)
                Circle().fill(.white).frame(width: 60, height: 60)
            }
            .contentShape(Circle())
        }
        .buttonStyle(JunoShutterPressStyle())
        .disabled(camera.isCapturing || !camera.isRunning)
        .accessibilityLabel("attachments.camera.shutter")
        .accessibilityIdentifier("juno.mobile.camera-shutter")
    }

    private func unavailable(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill")
                .font(.system(size: 34))
                .foregroundStyle(.white.opacity(0.7))
            Text(message)
                .font(.callout)
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            // Only offered where it can actually resolve the state. A camera
            // restricted by Screen Time or MDM is not the reader's to grant, so
            // sending them to Settings there would be a dead end.
            if camera.isRecoverableInSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                Link("attachments.camera.open-settings", destination: url)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.junoAccent)
            }
            Button("attachments.camera.close") { dismiss() }
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white.opacity(0.8))
        }
        .padding(32)
        .accessibilityIdentifier("juno.mobile.camera-unavailable")
    }

    // MARK: Actions

    private func capture() {
        shutterFlash = true
        Task {
            let image = await camera.capturePhoto()
            shutterFlash = false
            guard let image else { return }
            review = image
        }
    }

    private func use(_ image: UIImage) {
        // 0.9 rather than 1.0: visually indistinguishable for a photo, and it
        // keeps a 12 MP capture well inside the upload ceiling.
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            dismiss()
            return
        }
        onCapture(data, "photo-\(UUID().uuidString.prefix(8)).jpg")
        dismiss()
    }
}

/// The shutter's press feedback — a small inward scale, nothing more. A ripple
/// or a colour change on the one white control over a live preview would read as
/// the preview changing.
private struct JunoShutterPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.snappy(duration: 0.12), value: configuration.isPressed)
    }
}

/// The live preview layer. `AVCaptureVideoPreviewLayer` is attached to the
/// session on the main thread here and never re-attached: handing it a new
/// session on every SwiftUI update black-framed the preview each time any
/// observable state on the controller changed.
private struct JunoCameraPreview: UIViewRepresentable {
    let controller: JunoCameraController

    func makeUIView(context _: Context) -> JunoCameraPreviewView {
        let view = JunoCameraPreviewView()
        view.previewLayer.session = controller.session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: JunoCameraPreviewView, context _: Context) {
        if view.previewLayer.session !== controller.session {
            view.previewLayer.session = controller.session
        }
    }
}

final class JunoCameraPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    // swiftlint:disable:next force_cast
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// Flash states, in the order the button cycles them.
enum JunoCameraFlashMode: CaseIterable {
    case off
    case auto
    case on

    var next: JunoCameraFlashMode {
        switch self {
        case .off: .auto
        case .auto: .on
        case .on: .off
        }
    }

    var symbolName: String {
        switch self {
        case .off: "bolt.slash.fill"
        case .auto: "bolt.badge.a.fill"
        case .on: "bolt.fill"
        }
    }

    var accessibilityLabel: LocalizedStringKey {
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

/// Owns the capture session.
///
/// The session is configured and started on its own serial queue — doing that
/// work on the main thread stalls the presentation animation for the ~300 ms the
/// hardware takes to come up, which reads as the sheet freezing on open. UI
/// state stays `@MainActor`, so nothing here hands a non-`Sendable` AVFoundation
/// object across an isolation boundary except the session itself, which is
/// documented as safe to reference from any queue once configured.
@MainActor
@Observable
final class JunoCameraController {
    private(set) var isRunning = false
    private(set) var isCapturing = false
    private(set) var canFlip = false
    private(set) var hasFlash = false
    /// Non-nil when there is no usable camera. Carries the *reason*, because
    /// "no camera on this device", "you declined access" and "a policy forbids
    /// it" have three different remedies and one shared useless message.
    private(set) var unavailableMessage: String?
    private(set) var isRecoverableInSettings = false
    var flashMode: JunoCameraFlashMode = .off

    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.liammagnier.juno.camera")
    private let output = AVCapturePhotoOutput()
    private var position: AVCaptureDevice.Position = .back
    private var configured = false

    func start() async {
        guard unavailableMessage == nil else { return }
        guard !UIDevice.isSimulator else {
            // The simulator has no capture hardware at all. Saying so beats a
            // black rectangle that looks like a bug in the app.
            unavailableMessage = String(localized: "attachments.camera.unavailable")
            return
        }
        switch await Self.authorize() {
        case .authorized:
            break
        case .denied:
            unavailableMessage = String(localized: "attachments.camera.denied")
            isRecoverableInSettings = true
            return
        case .restricted:
            unavailableMessage = String(localized: "attachments.camera.restricted")
            return
        case .unavailable:
            unavailableMessage = String(localized: "attachments.camera.unavailable")
            return
        }

        if !configured {
            guard configureSession() else {
                unavailableMessage = String(localized: "attachments.camera.unavailable")
                return
            }
            configured = true
        }
        let session = session
        await withCheckedContinuation { continuation in
            queue.async {
                if !session.isRunning { session.startRunning() }
                continuation.resume()
            }
        }
        isRunning = session.isRunning
    }

    func stop() {
        let session = session
        queue.async {
            if session.isRunning { session.stopRunning() }
        }
        isRunning = false
    }

    func cycleFlash() {
        flashMode = flashMode.next
    }

    func flipCamera() {
        guard canFlip else { return }
        position = position == .back ? .front : .back
        session.beginConfiguration()
        for input in session.inputs { session.removeInput(input) }
        if let input = Self.input(for: position), session.canAddInput(input) {
            session.addInput(input)
        }
        session.commitConfiguration()
        refreshCapabilities()
    }

    /// Takes one photo. Returns nil when the capture failed — the caller stays on
    /// the live preview rather than advancing to a review of nothing.
    func capturePhoto() async -> UIImage? {
        guard !isCapturing, isRunning else { return nil }
        isCapturing = true
        defer { isCapturing = false }

        let settings = AVCapturePhotoSettings()
        if output.supportedFlashModes.contains(flashMode.captureMode) {
            settings.flashMode = flashMode.captureMode
        }
        let delegate = JunoPhotoCaptureDelegate()
        // The delegate is retained only by AVFoundation for the duration of the
        // capture, so it has to be held here too or it is deallocated before the
        // callback and the continuation never resumes.
        let data = await withCheckedContinuation { continuation in
            delegate.onFinish = { result in continuation.resume(returning: result) }
            output.capturePhoto(with: settings, delegate: delegate)
        }
        withExtendedLifetime(delegate) {}
        guard let data, let image = UIImage(data: data) else { return nil }
        return image
    }

    // MARK: Session setup

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
        refreshCapabilities()
        return true
    }

    private func refreshCapabilities() {
        canFlip = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInDualCamera, .builtInTripleCamera],
            mediaType: .video,
            position: .unspecified
        ).devices.contains { $0.position == .front } && AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: .back
        ) != nil
        hasFlash = !output.supportedFlashModes.filter { $0 != .off }.isEmpty
    }

    private static func input(for position: AVCaptureDevice.Position) -> AVCaptureDeviceInput? {
        guard let device = AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: position
        ) else { return nil }
        return try? AVCaptureDeviceInput(device: device)
    }

    private enum Authorization {
        case authorized, denied, restricted, unavailable
    }

    private static func authorize() async -> Authorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .unavailable
        }
    }
}

/// Bridges `AVCapturePhotoCaptureDelegate` — an Objective-C callback that
/// arrives on AVFoundation's own queue — to one `async` result.
private final class JunoPhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    /// Set before the capture starts and called exactly once.
    nonisolated(unsafe) var onFinish: ((Data?) -> Void)?

    func photoOutput(
        _: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: (any Error)?
    ) {
        guard error == nil else {
            onFinish?(nil)
            onFinish = nil
            return
        }
        onFinish?(photo.fileDataRepresentation())
        onFinish = nil
    }
}

extension UIDevice {
    /// True in the simulator, where there is no capture hardware.
    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }
}
