import Foundation

/// Capturing what the simulated device is showing.
///
/// Frames come from `simctl io … screenshot`, which is a supported public
/// interface and captures **only the named device** — not the display, not the
/// desktop, not another window. That property is why this build does not need
/// Screen Recording permission for verification at all, and why a captured
/// frame cannot contain anything but the simulator.
///
/// Frames are captured on demand, never continuously:
///  - a visual check asks for one frame;
///  - the pane asks for one frame at a bounded rate while it is open;
///  - nothing streams video to a model.
///
/// Nothing captured here is written to a log or persisted. A frame lives in a
/// temporary file for as long as it takes to read it, and the file is removed
/// on the way out — the only copies that survive are ones the user explicitly
/// saved or attached.
public actor SimulatorFrameService {
    /// The pane's ceiling. A simulator screenshot costs real work on both sides,
    /// and a faster loop buys nothing a person can perceive.
    public static let maxFramesPerSecond: Double = 4
    /// Frames are downscaled past this before anything is shown or shared, so a
    /// Pro Max at 3× cannot push a 9 MB PNG through a UI update or a request.
    public static let maxDimension: Int = 1_600

    private let runner: SimulatorProcessRunner
    private let directory: URL
    private var lastCaptureAt: Date?
    private var captureCount = 0

    public init(runner: SimulatorProcessRunner, temporaryDirectory: URL = FileManager.default.temporaryDirectory) {
        self.runner = runner
        self.directory = temporaryDirectory.appendingPathComponent("juno-simulator-frames", isDirectory: true)
    }

    public struct Frame: Sendable, Equatable {
        public let png: Data
        public let capturedAt: Date
        /// Monotonic within a session, so a stale frame arriving out of order
        /// can be dropped rather than shown after a newer one.
        public let sequence: Int
    }

    public enum CaptureError: Error, Equatable, CustomStringConvertible {
        case notBooted
        case throttled(retryAfter: TimeInterval)
        case failed(String)

        public var description: String {
            switch self {
            case .notBooted: "The simulator is not booted, so there is nothing to capture."
            case .throttled(let retry): "Frames are limited; try again in \(String(format: "%.2f", retry))s."
            case .failed(let reason): reason
            }
        }
    }

    /// Capture one frame.
    ///
    /// `enforceRate` is on for the live pane and off for an explicit visual
    /// check, because a check the model asked for should not silently fail
    /// because the pane happened to refresh a moment earlier.
    public func capture(udid: String, enforceRate: Bool = true) async throws -> Frame {
        let now = Date()
        if enforceRate, let last = lastCaptureAt {
            let minimumGap = 1.0 / Self.maxFramesPerSecond
            let elapsed = now.timeIntervalSince(last)
            if elapsed < minimumGap {
                throw CaptureError.throttled(retryAfter: minimumGap - elapsed)
            }
        }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("frame-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }

        let result: SimulatorProcessRunner.Result
        do {
            result = try await runner.run(SimulatorCommands.screenshot(udid: udid, outputPath: file.path), timeout: 30)
        } catch {
            throw CaptureError.failed("\(error)")
        }
        guard result.succeeded else {
            if result.combined.contains("Booted") || result.combined.contains("current state") {
                throw CaptureError.notBooted
            }
            throw CaptureError.failed(String(result.combined.suffix(500)))
        }
        guard let data = try? Data(contentsOf: file), !data.isEmpty else {
            throw CaptureError.failed("The simulator produced no image.")
        }

        lastCaptureAt = now
        captureCount += 1
        return Frame(png: data, capturedAt: now, sequence: captureCount)
    }

    /// Remove any frame files a crash left behind. Called on session start.
    public func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
        lastCaptureAt = nil
    }

    public var framesCaptured: Int { captureCount }
}
