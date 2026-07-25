import AVFoundation
import SwiftUI
import UIKit

/// The live preview.
///
/// A `UIViewRepresentable` only because `AVCaptureVideoPreviewLayer` is a
/// `CALayer` and there is no SwiftUI equivalent — it hosts the layer and does
/// nothing else. The session is attached once and never re-attached: handing the
/// layer a session on every SwiftUI update black-framed the preview each time
/// any observable state on the camera model changed.
struct JunoCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context _: Context) -> JunoCameraPreviewView {
        let view = JunoCameraPreviewView()
        view.previewLayer.session = session
        // Fill, not fit. A preview letterboxed inside a panel that is nearly
        // square would show the reader a smaller frame than the camera is
        // actually taking.
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: JunoCameraPreviewView, context _: Context) {
        if view.previewLayer.session !== session {
            view.previewLayer.session = session
        }
    }
}

/// A view whose backing layer *is* the preview layer, so the layer resizes with
/// the view instead of needing its frame kept in step by hand.
final class JunoCameraPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    // swiftlint:disable:next force_cast
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}
