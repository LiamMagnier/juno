import Foundation
import ImageIO
import JunoCodeCore
import JunoCodeLocal
import JunoCodeUI
import JunoSimulator
import UniformTypeIdentifiers

/// The Mac's own answers on the device link (docs/code-v2/REMOTE-CONTROL.md
/// §3): `host.info` (who this Mac is and what a paired device may reach) and
/// `host.capture` (a picture of the Code preview or the Simulator).
///
/// Captures are taken by WebKit (the preview's page) and `simctl` (the named
/// Simulator), never by reading the screen: neither can contain anything but
/// the page or the device. Each is downscaled to at most 1600 px on its long
/// edge before it leaves the Mac.
struct DesktopRemoteHostResponder: Sendable {
    struct Facts: Sendable, Equatable {
        var name: String
        var sharedFolders: [String]
        var terminal: Bool
        var appVersion: String?
    }

    /// The Mac's name, shared folders and terminal consent, read per command.
    var facts: @Sendable () async -> Facts
    /// The UDID of a booted Simulator, or nil.
    var bootedSimulator: @Sendable () async -> String?
    /// Whether the Code preview has a page to photograph.
    var hasPreview: @Sendable () async -> Bool
    /// PNG of the Simulator with that UDID.
    var captureSimulator: @Sendable (_ udid: String) async throws -> Data
    /// PNG of the preview's page, or nil when there is none.
    var capturePreview: @Sendable () async throws -> Data?
    var now: @Sendable () -> Date = { Date() }

    static let maxLongEdge = 1_600

    /// The ``EnvServerDeviceLink/HostHandler``.
    func handle(_ type: CodeV2.ClientCommandType, _ params: JSONValue) async throws -> JSONValue? {
        switch type {
        case .hostInfo:
            return try CodeV2.ClientCommand.encodeParams(await info())
        case .hostCapture:
            guard case let .object(object) = params, case let .string(raw)? = object["target"],
                let target = CodeV2.RemoteCaptureTarget(rawValue: raw)
            else {
                throw EnvServerConnectionError.server(.badRequest, "Say which to capture: the preview or the Simulator.")
            }
            return try CodeV2.ClientCommand.encodeParams(await capture(target))
        default:
            throw EnvServerConnectionError.server(.unsupported, "Your Mac does not answer that itself.")
        }
    }

    func info() async -> CodeV2.HostInfo {
        let facts = await facts()
        var captures: [CodeV2.RemoteCaptureTarget] = []
        if await hasPreview() { captures.append(.preview) }
        if await bootedSimulator() != nil { captures.append(.simulator) }
        return CodeV2.HostInfo(
            name: facts.name,
            sharedFolders: facts.sharedFolders,
            terminal: facts.terminal,
            captures: captures,
            appVersion: facts.appVersion
        )
    }

    func capture(_ target: CodeV2.RemoteCaptureTarget) async throws -> CodeV2.HostCapture {
        let png: Data
        switch target {
        case .simulator:
            guard let udid = await bootedSimulator() else {
                throw EnvServerConnectionError.server(
                    .notReady, "No Simulator is running on this Mac. Run your app in Alevr Code, then try again."
                )
            }
            do {
                png = try await captureSimulator(udid)
            } catch {
                throw EnvServerConnectionError.server(.notReady, "The Simulator on this Mac could not be captured. Try again.")
            }
        case .preview:
            let captured: Data?
            do {
                captured = try await capturePreview()
            } catch {
                throw EnvServerConnectionError.server(.notReady, "The preview on this Mac could not be captured. Try again.")
            }
            guard let captured else {
                throw EnvServerConnectionError.server(
                    .notReady, "No preview is open on this Mac. Open one in Alevr Code, then try again."
                )
            }
            png = captured
        }
        guard let scaled = Self.downscaledPNG(png, maxLongEdge: Self.maxLongEdge) else {
            throw EnvServerConnectionError.server(.internal, "Your Mac took a picture it could not read. Try again.")
        }
        return CodeV2.HostCapture(
            data: scaled.data.base64EncodedString(),
            width: scaled.width,
            height: scaled.height,
            at: Self.timestamp(now())
        )
    }

    /// Re-encodes an image as PNG no larger than `maxLongEdge` on its long side.
    static func downscaledPNG(_ data: Data, maxLongEdge: Int) -> (data: Data, width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
        else { return nil }
        let image: CGImage?
        if max(width, height) <= maxLongEdge {
            image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        } else {
            image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxLongEdge,
                kCGImageSourceCreateThumbnailWithTransform: true,
            ] as CFDictionary)
        }
        guard let image, let encoded = png(image) else { return nil }
        return (encoded, image.width, image.height)
    }

    static func png(_ image: CGImage) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

extension DesktopRemoteHostResponder {
    /// The real Mac: the Simulator through `simctl`, the preview through WebKit.
    static func live(facts: @escaping @Sendable () async -> Facts) -> Self {
        let runner = SimulatorProcessRunner()
        let devices = SimulatorDeviceService(runner: runner)
        let frames = SimulatorFrameService(runner: runner)
        return DesktopRemoteHostResponder(
            facts: facts,
            bootedSimulator: {
                (try? await devices.devices())?.first { $0.state == .booted }?.udid
            },
            hasPreview: { await MainActor.run { CodeV2PreviewCapture.hasPage } },
            captureSimulator: { udid in
                try await frames.capture(udid: udid, enforceRate: false).png
            },
            capturePreview: { try await previewPNG() }
        )
    }

    @MainActor
    private static func previewPNG() async throws -> Data? {
        guard let image = try await CodeV2PreviewCapture.capture() else { return nil }
        return png(image)
    }
}
