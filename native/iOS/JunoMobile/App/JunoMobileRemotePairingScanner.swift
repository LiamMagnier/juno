import AVFoundation
import SwiftUI
import UIKit

/// A QR reader: an `AVCaptureSession` with a metadata output for `.qr`,
/// handing every code it reads to `onCode` on the main actor.
///
/// `@unchecked Sendable` on the usual terms for a capture session: its state
/// is touched only on `queue`, and the delegate hops to the main actor before
/// anything leaves it.
final class JunoMobileQRScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
  let session = AVCaptureSession()
  private let queue = DispatchQueue(label: "com.liammagnier.juno.pairing.scanner")
  private var configured = false
  private let onCode: @MainActor @Sendable (String) -> Void
  /// The last code read, so one held under the camera does not fire every frame.
  private var lastCode: String?
  private let lock = NSLock()

  init(onCode: @escaping @MainActor @Sendable (String) -> Void) {
    self.onCode = onCode
  }

  func start() {
    queue.async { [self] in
      if !configured { configure() }
      if configured, !session.isRunning { session.startRunning() }
    }
  }

  func stop() {
    queue.async { [self] in
      if session.isRunning { session.stopRunning() }
    }
  }

  /// Lets the same code count again (after a hint or a failed inspect).
  func reset() {
    lock.withLock { lastCode = nil }
  }

  private func configure() {
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: device)
    else { return }
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    guard session.canAddInput(input) else { return }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { return }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: queue)
    if output.availableMetadataObjectTypes.contains(.qr) {
      output.metadataObjectTypes = [.qr]
    }
    configured = true
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    let codes = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
    guard let code = codes.first else { return }
    let isNew = lock.withLock { () -> Bool in
      guard code != lastCode else { return false }
      lastCode = code
      return true
    }
    guard isNew else { return }
    let onCode = onCode
    Task { @MainActor in onCode(code) }
  }
}

/// The camera, full bleed, reading QR codes.
struct JunoMobileQRScannerView: UIViewRepresentable {
  let scanner: JunoMobileQRScanner

  func makeUIView(context _: Context) -> JunoCameraPreviewView {
    let view = JunoCameraPreviewView()
    view.previewLayer.session = scanner.session
    view.previewLayer.videoGravity = .resizeAspectFill
    view.backgroundColor = .black
    scanner.start()
    return view
  }

  func updateUIView(_: JunoCameraPreviewView, context _: Context) {}

  static func dismantleUIView(_: JunoCameraPreviewView, coordinator _: ()) {}
}

/// Camera permission, asked in context: when the scanner opens, not at launch.
enum JunoMobileCameraAccess: Equatable {
  case undetermined
  case granted
  case denied

  static var current: JunoMobileCameraAccess {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: .granted
    case .notDetermined: .undetermined
    default: .denied
    }
  }

  static func request() async -> JunoMobileCameraAccess {
    await AVCaptureDevice.requestAccess(for: .video) ? .granted : .denied
  }
}
