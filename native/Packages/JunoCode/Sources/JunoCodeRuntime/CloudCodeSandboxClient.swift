import Foundation
import JunoCodeCore

// MARK: - Request

/// One file handed to the sandbox before the script runs.
///
/// `contents` is raw bytes, not text: analysis scripts are routinely fed
/// spreadsheets, parquet shards and images, and forcing them through `String`
/// would corrupt every one of them at the first invalid UTF-8 byte.
public struct SandboxInputFile: Equatable, Sendable {
    /// A single path component. Directories are deliberately not expressible —
    /// see ``SandboxScriptRequest`` for why the sandbox refuses to reconstruct
    /// a caller-supplied tree.
    public let name: String
    public let contents: Data

    public init(name: String, contents: Data) {
        self.name = name
        self.contents = contents
    }
}

/// A script submission. The language is fixed to Python because that is the
/// only interpreter both backends agree on; making it a parameter would let a
/// caller ask for something the local fallback silently ran as Python anyway.
public struct SandboxScriptRequest: Equatable, Sendable {
    public static let defaultTimeoutSeconds: Double = 60
    public static let maximumTimeoutSeconds: Double = 600

    public let source: String
    public let timeoutSeconds: Double
    public let inputFiles: [SandboxInputFile]

    /// - Note: `timeoutSeconds` is clamped rather than rejected. A caller that
    ///   asks for ten hours has made a mistake, and failing the run gives them
    ///   nothing; running for the ceiling and finishing is strictly better than
    ///   an error that reports nothing about the script.
    public init(
        source: String,
        timeoutSeconds: Double = SandboxScriptRequest.defaultTimeoutSeconds,
        inputFiles: [SandboxInputFile] = []
    ) {
        self.source = source
        self.timeoutSeconds = min(max(timeoutSeconds, 1), Self.maximumTimeoutSeconds)
        self.inputFiles = inputFiles
    }
}

// MARK: - Result

/// A raster or vector image the sandbox produced, almost always a Matplotlib
/// figure.
///
/// `format` is not optional and there is no `.unknown` case on purpose: a
/// renderer that cannot name the format cannot draw the bytes, so a payload
/// whose format is unrecognised is rejected at parse time instead of arriving
/// here as an image nobody can display.
public struct SandboxChart: Equatable, Sendable {
    public enum Format: String, Equatable, Sendable, CaseIterable {
        case png
        case jpeg
        case svg
    }

    /// The backend's own label, when it gave one. Absent means "unnamed", which
    /// is not the same as an empty title, so a UI can fall back to a positional
    /// caption rather than drawing a blank one.
    public let name: String?
    public let format: Format
    public let imageData: Data
    /// The Matplotlib figure number this came from, when it is knowable.
    ///
    /// Nil is load-bearing: figure numbers start at 1, so defaulting an unknown
    /// figure to 0 would invent a figure that cannot exist, and defaulting to 1
    /// would silently claim the chart came from the first figure.
    public let figureNumber: Int?

    public init(name: String?, format: Format, imageData: Data, figureNumber: Int?) {
        self.name = name
        self.format = format
        self.imageData = imageData
        self.figureNumber = figureNumber
    }
}

/// A file the script wrote and the sandbox brought back.
public struct SandboxGeneratedFile: Equatable, Sendable {
    public let name: String
    /// Nil when nothing identified the type. An unknown type is not
    /// `application/octet-stream`: that string is a positive claim that the
    /// bytes are opaque, and it stops a viewer from sniffing content it could
    /// otherwise have rendered.
    public let mimeType: String?
    public let contents: Data

    public init(name: String, mimeType: String?, contents: Data) {
        self.name = name
        self.mimeType = mimeType
        self.contents = contents
    }
}

/// A file the sandbox saw but did not return.
///
/// The alternative — dropping it — makes an over-budget artifact
/// indistinguishable from one the script never wrote, and users debug the
/// script for a long time before suspecting the harness.
public struct SandboxOmittedFile: Equatable, Sendable {
    public enum Reason: Equatable, Sendable {
        case exceededFileSizeLimit(byteCount: Int, limitBytes: Int)
        case exceededFileCountLimit(limit: Int)
        case unreadable
    }

    public let name: String
    public let reason: Reason

    public init(name: String, reason: Reason) {
        self.name = name
        self.reason = reason
    }
}

/// Everything one sandboxed run is known to have produced.
///
/// Almost every field is optional, and that is the point. A sandbox response is
/// a report from another machine, and "the backend did not tell us" has to stay
/// distinguishable from "the backend told us zero" — an absent exit code
/// defaulted to `0` reports a crashed script as a clean success, which is the
/// single worst lie this type could tell.
public struct SandboxExecutionResult: Equatable, Sendable {
    public let stdout: String?
    public let stderr: String?
    public let exitCode: Int32?
    public let timedOut: Bool?
    public let durationSeconds: Double?
    public let stdoutWasTruncated: Bool?
    public let stderrWasTruncated: Bool?
    /// Whether the capture as a whole was cut short, when the per-stream flags
    /// cannot say.
    ///
    /// This exists because the local executor enforces one byte budget across
    /// both pipes and does not record which one exhausted it. Setting both
    /// per-stream flags to `true` in that case would tell the user their stdout
    /// was truncated when only a stack trace on stderr was, so the local backend
    /// leaves those nil and reports the cut here instead — the fact survives
    /// without the fabricated attribution.
    public let outputWasTruncated: Bool?
    public let charts: [SandboxChart]
    public let files: [SandboxGeneratedFile]
    public let omittedFiles: [SandboxOmittedFile]

    public init(
        stdout: String?,
        stderr: String?,
        exitCode: Int32?,
        timedOut: Bool?,
        durationSeconds: Double?,
        stdoutWasTruncated: Bool? = nil,
        stderrWasTruncated: Bool? = nil,
        outputWasTruncated: Bool? = nil,
        charts: [SandboxChart] = [],
        files: [SandboxGeneratedFile] = [],
        omittedFiles: [SandboxOmittedFile] = []
    ) {
        self.stdout = stdout
        self.stderr = stderr
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.durationSeconds = durationSeconds
        self.stdoutWasTruncated = stdoutWasTruncated
        self.stderrWasTruncated = stderrWasTruncated
        // A backend that answered per stream has already answered the general
        // question, so the two never disagree.
        self.outputWasTruncated = outputWasTruncated
            ?? Self.combining(stdoutWasTruncated, stderrWasTruncated)
        self.charts = charts
        self.files = files
        self.omittedFiles = omittedFiles
    }

    /// `true` if either stream was cut, `false` only when both are known not to
    /// have been, and nil while any part of the answer is missing.
    private static func combining(_ left: Bool?, _ right: Bool?) -> Bool? {
        if left == true || right == true { return true }
        if left == false, right == false { return false }
        return nil
    }

    /// Three-valued on purpose: nil means "no verdict is available", and a UI
    /// showing a red cross for that is asserting a failure nobody observed.
    ///
    /// A known-zero exit paired with an unknown timeout still counts as success:
    /// a run that was killed at the deadline does not get to exit zero, so the
    /// exit code already answers the question the timeout flag would.
    public var succeeded: Bool? {
        guard let exitCode else { return nil }
        return exitCode == 0 && timedOut != true
    }
}

// MARK: - Client

/// What a concrete sandbox can actually do, so a caller never advertises a
/// guarantee its backend does not provide.
///
/// `isKernelContained` is three-valued for the same reason
/// `CommandExecutionService.isContained` exists at all: a "Sandboxed" badge over
/// an unconfined developer-mode process is worse than no badge, and a remote
/// backend cannot be inspected from here, so "unknown" is the truth rather than
/// a pessimistic `false`.
public struct SandboxBackendDescription: Equatable, Sendable {
    public let identifier: String
    public let isRemote: Bool
    public let isKernelContained: Bool?
    public let capturesCharts: Bool
    public let returnsGeneratedFiles: Bool

    public init(
        identifier: String,
        isRemote: Bool,
        isKernelContained: Bool?,
        capturesCharts: Bool,
        returnsGeneratedFiles: Bool
    ) {
        self.identifier = identifier
        self.isRemote = isRemote
        self.isKernelContained = isKernelContained
        self.capturesCharts = capturesCharts
        self.returnsGeneratedFiles = returnsGeneratedFiles
    }
}

/// The seam every Python execution goes through.
///
/// It is a protocol and not a class so the two implementations that exist —
/// a hosted sandbox and the developer-mode local process — are interchangeable
/// at the composition root, and so a test can assert on the *runtime's* handling
/// of a result without a Python interpreter, a network, or a temporary
/// directory anywhere in the loop.
public protocol CloudCodeSandboxClient: Sendable {
    var backend: SandboxBackendDescription { get }
    func run(_ request: SandboxScriptRequest) async throws -> SandboxExecutionResult
}

public enum SandboxClientError: Error, Equatable, Sendable, LocalizedError {
    case rejected(statusCode: Int, message: String)
    case transportFailed(message: String)
    case interpreterUnavailable(path: String)
    case scratchDirectoryUnavailable(message: String)

    public var errorDescription: String? {
        switch self {
        case let .rejected(statusCode, message):
            "The sandbox refused the script (\(statusCode)): \(message)"
        case let .transportFailed(message):
            "Juno could not reach the code sandbox: \(message)"
        case let .interpreterUnavailable(path):
            "No Python interpreter is available at \(path)."
        case let .scratchDirectoryUnavailable(message):
            "Juno could not prepare a scratch directory for the script: \(message)"
        }
    }
}

// MARK: - Wire

public struct SandboxPayloadLimits: Equatable, Sendable {
    public let maximumFileCount: Int
    public let maximumChartCount: Int
    public let maximumFileBytes: Int
    public let maximumStreamCharacters: Int

    public init(
        maximumFileCount: Int = 32,
        maximumChartCount: Int = 24,
        maximumFileBytes: Int = 16 * 1_024 * 1_024,
        maximumStreamCharacters: Int = 512 * 1_024
    ) {
        self.maximumFileCount = max(0, maximumFileCount)
        self.maximumChartCount = max(0, maximumChartCount)
        self.maximumFileBytes = max(0, maximumFileBytes)
        self.maximumStreamCharacters = max(0, maximumStreamCharacters)
    }

    public static let `default` = SandboxPayloadLimits()
}

public enum SandboxPayloadError: Error, Equatable, Sendable, LocalizedError {
    case notJSON
    case notAnObject
    case malformedField(String)
    case invalidBase64(field: String)
    case unsupportedChartFormat(String)
    case unnamedFile

    public var errorDescription: String? {
        switch self {
        case .notJSON:
            "The sandbox returned data that is not JSON."
        case .notAnObject:
            "The sandbox returned JSON that is not an execution result."
        case let .malformedField(name):
            "The sandbox result field '\(name)' has an unexpected type."
        case let .invalidBase64(field):
            "The sandbox result field '\(field)' is not valid base64."
        case let .unsupportedChartFormat(value):
            "The sandbox returned a chart in an unsupported format: \(value)."
        case .unnamedFile:
            "The sandbox returned a file without a name."
        }
    }
}

/// Turns bytes into ``SandboxExecutionResult`` and requests into bytes.
///
/// Deliberately a free-standing enum with static methods and no stored state,
/// no `URLSession`, no `FileManager` and no clock: payload handling is where the
/// interesting mistakes live (a base64 blob that silently decodes to nothing, an
/// absent exit code becoming success, a 400 MB figure), and none of those are
/// worth spinning up a sandbox to test.
public enum CloudCodeSandboxWire {
    // MARK: Encoding

    public static func encode(
        _ request: SandboxScriptRequest,
        limits: SandboxPayloadLimits = .default
    ) throws -> Data {
        var body: [String: Any] = [
            "language": "python",
            "source": request.source,
            "timeoutSeconds": request.timeoutSeconds,
        ]
        if !request.inputFiles.isEmpty {
            body["inputFiles"] = request.inputFiles.prefix(limits.maximumFileCount).map { file in
                [
                    "name": file.name,
                    "contentBase64": file.contents.base64EncodedString(),
                ] as [String: Any]
            }
        }
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }

    // MARK: Decoding

    public static func decode(
        _ data: Data,
        limits: SandboxPayloadLimits = .default
    ) throws -> SandboxExecutionResult {
        let json: Any
        do { json = try JSONSerialization.jsonObject(with: data) }
        catch { throw SandboxPayloadError.notJSON }
        guard let object = json as? [String: Any] else {
            throw SandboxPayloadError.notAnObject
        }

        let stdout = try optionalString(object["stdout"], field: "stdout")
        let stderr = try optionalString(object["stderr"], field: "stderr")

        var charts: [SandboxChart] = []
        var files: [SandboxGeneratedFile] = []
        var omitted: [SandboxOmittedFile] = []

        if let raw = object["charts"] {
            guard let entries = raw as? [Any] else {
                throw SandboxPayloadError.malformedField("charts")
            }
            for entry in entries.prefix(limits.maximumChartCount) {
                charts.append(try decodeChart(entry, limits: limits))
            }
            if entries.count > limits.maximumChartCount {
                for entry in entries.dropFirst(limits.maximumChartCount) {
                    let name = ((entry as? [String: Any])?["name"] as? String) ?? "chart"
                    omitted.append(
                        SandboxOmittedFile(
                            name: name,
                            reason: .exceededFileCountLimit(limit: limits.maximumChartCount)
                        )
                    )
                }
            }
        }

        if let raw = object["files"] {
            guard let entries = raw as? [Any] else {
                throw SandboxPayloadError.malformedField("files")
            }
            for entry in entries {
                guard files.count < limits.maximumFileCount else {
                    let name = ((entry as? [String: Any])?["name"] as? String) ?? "file"
                    omitted.append(
                        SandboxOmittedFile(
                            name: name,
                            reason: .exceededFileCountLimit(limit: limits.maximumFileCount)
                        )
                    )
                    continue
                }
                switch try decodeFile(entry, limits: limits) {
                case let .kept(file): files.append(file)
                case let .omitted(entry): omitted.append(entry)
                }
            }
        }

        return SandboxExecutionResult(
            stdout: clamp(stdout, to: limits.maximumStreamCharacters),
            stderr: clamp(stderr, to: limits.maximumStreamCharacters),
            exitCode: try optionalExitCode(object["exitCode"]),
            timedOut: try optionalBool(object["timedOut"], field: "timedOut"),
            durationSeconds: try optionalDouble(object["durationSeconds"], field: "durationSeconds"),
            stdoutWasTruncated: try truncationFlag(object, stream: "stdout"),
            stderrWasTruncated: try truncationFlag(object, stream: "stderr"),
            outputWasTruncated: try truncationFlag(object, stream: "output"),
            charts: charts,
            files: files,
            omittedFiles: omitted
        )
    }

    // MARK: Field decoding

    private enum FileOutcome {
        case kept(SandboxGeneratedFile)
        case omitted(SandboxOmittedFile)
    }

    private static func decodeChart(
        _ entry: Any,
        limits: SandboxPayloadLimits
    ) throws -> SandboxChart {
        guard let object = entry as? [String: Any] else {
            throw SandboxPayloadError.malformedField("charts[]")
        }
        let name = try optionalString(object["name"], field: "charts[].name")
        let rawFormat = try optionalString(object["format"], field: "charts[].format")
        guard let encoded = object["imageBase64"] as? String else {
            throw SandboxPayloadError.malformedField("charts[].imageBase64")
        }
        // `ignoreUnknownCharacters` is not used: it turns a truncated or
        // corrupted blob into a short, valid-looking image instead of an error,
        // and a half-decoded PNG renders as a grey box nobody can explain.
        guard let imageData = Data(base64Encoded: encoded), !imageData.isEmpty else {
            throw SandboxPayloadError.invalidBase64(field: "charts[].imageBase64")
        }
        guard imageData.count <= limits.maximumFileBytes else {
            throw SandboxPayloadError.malformedField("charts[].imageBase64")
        }
        let format = try chartFormat(declared: rawFormat, name: name, data: imageData)
        return SandboxChart(
            name: name,
            format: format,
            imageData: imageData,
            figureNumber: try optionalFigureNumber(object["figureNumber"], name: name)
        )
    }

    private static func decodeFile(
        _ entry: Any,
        limits: SandboxPayloadLimits
    ) throws -> FileOutcome {
        guard let object = entry as? [String: Any] else {
            throw SandboxPayloadError.malformedField("files[]")
        }
        guard let name = object["name"] as? String,
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw SandboxPayloadError.unnamedFile }
        guard let encoded = object["contentBase64"] as? String else {
            throw SandboxPayloadError.malformedField("files[].contentBase64")
        }
        guard let contents = Data(base64Encoded: encoded) else {
            throw SandboxPayloadError.invalidBase64(field: "files[].contentBase64")
        }
        guard contents.count <= limits.maximumFileBytes else {
            return .omitted(
                SandboxOmittedFile(
                    name: name,
                    reason: .exceededFileSizeLimit(
                        byteCount: contents.count,
                        limitBytes: limits.maximumFileBytes
                    )
                )
            )
        }
        let declared = try optionalString(object["mimeType"], field: "files[].mimeType")
        return .kept(
            SandboxGeneratedFile(
                name: name,
                // An empty string from the backend is not a media type; it is
                // the backend saying it does not know, so it stays nil.
                mimeType: declared.flatMap { $0.isEmpty ? nil : $0 }
                    ?? SandboxMediaType.forFileName(name),
                contents: contents
            )
        )
    }

    /// The declared format wins when it is one we can draw; otherwise the bytes
    /// are asked directly. A backend that says "png" over JPEG bytes is
    /// reporting its own intent, and the sniffer settles the disagreement.
    private static func chartFormat(
        declared: String?,
        name: String?,
        data: Data
    ) throws -> SandboxChart.Format {
        if let sniffed = SandboxChartSniffer.format(of: data) { return sniffed }
        if let declared, !declared.isEmpty {
            guard let format = SandboxChart.Format(rawValue: declared.lowercased()) else {
                throw SandboxPayloadError.unsupportedChartFormat(declared)
            }
            return format
        }
        if let name, let format = SandboxChartSniffer.format(ofFileNamed: name) {
            return format
        }
        throw SandboxPayloadError.unsupportedChartFormat("unspecified")
    }

    private static func truncationFlag(
        _ object: [String: Any],
        stream: String
    ) throws -> Bool? {
        guard let truncated = object["truncated"] else { return nil }
        guard let mapping = truncated as? [String: Any] else {
            throw SandboxPayloadError.malformedField("truncated")
        }
        return try optionalBool(mapping[stream], field: "truncated.\(stream)")
    }

    private static func optionalString(_ value: Any?, field: String) throws -> String? {
        guard let value, !(value is NSNull) else { return nil }
        guard let text = value as? String else {
            throw SandboxPayloadError.malformedField(field)
        }
        return text
    }

    private static func optionalBool(_ value: Any?, field: String) throws -> Bool? {
        guard let value, !(value is NSNull) else { return nil }
        guard let number = value as? NSNumber,
            CFGetTypeID(number) == CFBooleanGetTypeID()
        else { throw SandboxPayloadError.malformedField(field) }
        return number.boolValue
    }

    private static func optionalDouble(_ value: Any?, field: String) throws -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        guard let number = value as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID()
        else { throw SandboxPayloadError.malformedField(field) }
        let result = number.doubleValue
        guard result.isFinite else { throw SandboxPayloadError.malformedField(field) }
        return result
    }

    private static func optionalExitCode(_ value: Any?) throws -> Int32? {
        guard let value, !(value is NSNull) else { return nil }
        guard let number = value as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID()
        else { throw SandboxPayloadError.malformedField("exitCode") }
        let raw = number.doubleValue
        guard raw.rounded() == raw,
            raw >= Double(Int32.min), raw <= Double(Int32.max)
        else { throw SandboxPayloadError.malformedField("exitCode") }
        return Int32(raw)
    }

    /// A missing figure number falls back to the digits in the file name, and
    /// to nil when there are none. It never falls back to a position in the
    /// array: charts arrive in whatever order the backend serialised them, and
    /// "figure 3" would then be a fabricated fact about the user's script.
    private static func optionalFigureNumber(_ value: Any?, name: String?) throws -> Int? {
        if let value, !(value is NSNull) {
            guard let number = value as? NSNumber,
                CFGetTypeID(number) != CFBooleanGetTypeID()
            else { throw SandboxPayloadError.malformedField("charts[].figureNumber") }
            let raw = number.doubleValue
            guard raw.rounded() == raw, raw >= 1, raw <= Double(Int.max) else {
                throw SandboxPayloadError.malformedField("charts[].figureNumber")
            }
            return Int(raw)
        }
        guard let name else { return nil }
        return SandboxChartSniffer.figureNumber(inFileNamed: name)
    }

    private static func clamp(_ text: String?, to limit: Int) -> String? {
        guard let text, text.count > limit else { return text }
        return String(text.prefix(limit)) + "… [output truncated]"
    }
}

/// Format detection for images the sandbox produces.
///
/// Kept separate from the wire decoder so the local fallback — which never sees
/// a JSON envelope, only files on disk — reaches exactly the same verdict for
/// the same bytes.
public enum SandboxChartSniffer {
    public static func format(of data: Data) -> SandboxChart.Format? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return .png }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return .jpeg }
        // SVG has no magic number. Only the opening bytes are examined so a
        // multi-megabyte binary is not decoded as text just to be rejected.
        let head = String(decoding: data.prefix(512), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if head.hasPrefix("<?xml") || head.hasPrefix("<svg") {
            return head.range(of: "<svg", options: .caseInsensitive) != nil ? .svg : nil
        }
        return nil
    }

    public static func format(ofFileNamed name: String) -> SandboxChart.Format? {
        switch (name as NSString).pathExtension.lowercased() {
        case "png": .png
        case "jpg", "jpeg": .jpeg
        case "svg": .svg
        default: nil
        }
    }

    /// Pulls `7` out of `figure-7.png`.
    ///
    /// Matplotlib numbers figures from 1, so a name with no digits yields nil
    /// rather than 0 — a caption reading "Figure 0" is a claim about a figure
    /// that does not exist.
    public static func figureNumber(inFileNamed name: String) -> Int? {
        let stem = (name as NSString).deletingPathExtension
        let digits = stem.drop { !$0.isNumber }.prefix { $0.isNumber }
        guard !digits.isEmpty, let value = Int(digits), value >= 1 else { return nil }
        return value
    }
}

/// Media types for the handful of extensions data work actually produces.
///
/// Anything else returns nil. Guessing is worse than not knowing here: a
/// mislabelled type makes a preview render a CSV as an image and fail, whereas
/// nil lets the caller sniff or simply offer the file for download.
public enum SandboxMediaType {
    public static func forFileName(_ name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "svg": "image/svg+xml"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "pdf": "application/pdf"
        case "csv": "text/csv"
        case "tsv": "text/tab-separated-values"
        case "json": "application/json"
        case "txt", "log": "text/plain"
        case "md": "text/markdown"
        case "html", "htm": "text/html"
        case "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "parquet": "application/vnd.apache.parquet"
        case "zip": "application/zip"
        default: nil
        }
    }
}

// MARK: - Hosted backend

/// The network seam. Kept this narrow so ``CloudCodeSandboxService`` can be
/// exercised end to end against an in-memory transport, and so this target never
/// grows a dependency on `URLSession` or on Juno's authenticated request stack —
/// the composition root owns credentials, not the runtime.
public protocol SandboxTransport: Sendable {
    /// - Returns: the raw response body. Non-2xx responses must be reported as
    ///   ``SandboxClientError/rejected(statusCode:message:)`` rather than as a
    ///   body, so a failure never parses as an empty-but-successful run.
    func execute(payload: Data) async throws -> Data
}

/// Runs Python in a hosted sandbox, over whatever transport the app installs.
public struct CloudCodeSandboxService: CloudCodeSandboxClient {
    private let transport: any SandboxTransport
    private let limits: SandboxPayloadLimits

    public init(
        transport: any SandboxTransport,
        limits: SandboxPayloadLimits = .default
    ) {
        self.transport = transport
        self.limits = limits
    }

    public var backend: SandboxBackendDescription {
        SandboxBackendDescription(
            identifier: "cloud",
            isRemote: true,
            // Unknowable from this side of the network. The hosted sandbox is
            // contained, but this process cannot verify that, and a claim it
            // cannot verify is one it should not make.
            isKernelContained: nil,
            capturesCharts: true,
            returnsGeneratedFiles: true
        )
    }

    public func run(_ request: SandboxScriptRequest) async throws -> SandboxExecutionResult {
        let payload = try CloudCodeSandboxWire.encode(request, limits: limits)
        let response = try await transport.execute(payload: payload)
        return try CloudCodeSandboxWire.decode(response, limits: limits)
    }
}
