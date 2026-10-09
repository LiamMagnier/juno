import Foundation
import JunoCodeCore

/// The kinds of media the Code agent can ask Alevr to make. Each maps to the
/// catalogue's modality of the same name and to one setting in
/// Settings › Generation models; audio is the catalogue's music modality.
public enum CodeMediaKind: String, CaseIterable, Sendable {
    case image
    case video
    case audio

    /// The tool the agent calls: `generate_image`, `generate_video`, `generate_audio`.
    public var toolName: String { "generate_\(rawValue)" }

    /// "Image", "Video", "Music": the setting's label.
    public var title: String {
        switch self {
        case .image: "Image"
        case .video: "Video"
        case .audio: "Music"
        }
    }

    /// The word in sentences: "an image", "a video", "a track".
    var noun: String {
        switch self {
        case .image: "an image"
        case .video: "a video"
        case .audio: "a track"
        }
    }

    /// The extension a destination gets when the agent names none.
    var defaultExtension: String {
        switch self {
        case .image: "png"
        case .video: "mp4"
        case .audio: "mp3"
        }
    }
}

/// One file a generation produced.
public struct CodeGeneratedFile: Equatable, Sendable {
    public let fileName: String
    public let mimeType: String
    public let data: Data

    public init(fileName: String, mimeType: String, data: Data) {
        self.fileName = fileName
        self.mimeType = mimeType
        self.data = data
    }
}

/// The transport seam for the media tools. The runtime knows nothing about
/// authentication or providers; the desktop composition root supplies an
/// implementation over Alevr's own generation API, metered on the reader's plan.
public protocol CodeMediaGenerating: Sendable {
    /// The model the reader chose for `kind` in Settings › Generation models,
    /// or the catalogue's default for it. Nil when the catalogue has none.
    func model(for kind: CodeMediaKind) -> String?
    func generate(kind: CodeMediaKind, prompt: String, model: String) async throws -> [CodeGeneratedFile]
}

/// `generate_image`, `generate_video` and `generate_audio`: Alevr makes the
/// media with the model chosen in Settings › Generation models and saves it
/// into the workspace. The Code picker itself lists only text models; this is
/// how an agent running one of them still gets an image, a clip or a track.
///
/// Approval-gated in every mode but full access (``ActionRisk/critical``): it
/// spends from the reader's plan and reaches the network.
public struct GenerateMediaTool: CodeTool {
    public let kind: CodeMediaKind
    private let service: any CodeMediaGenerating
    private let workspaceRoot: URL

    public init(kind: CodeMediaKind, service: any CodeMediaGenerating, workspaceRoot: URL) {
        self.kind = kind
        self.service = service
        self.workspaceRoot = workspaceRoot
    }

    /// One tool per kind the service has a model for.
    public static func all(service: any CodeMediaGenerating, workspaceRoot: URL) -> [GenerateMediaTool] {
        CodeMediaKind.allCases
            .filter { service.model(for: $0) != nil }
            .map { GenerateMediaTool(kind: $0, service: service, workspaceRoot: workspaceRoot) }
    }

    public var name: String { kind.toolName }

    public var description: String {
        let what: String
        switch kind {
        case .image: what = "Generate an image (an illustration, icon, photo, texture or mockup)"
        case .video: what = "Generate a short video clip"
        case .audio: what = "Generate music or a sound track"
        }
        return "\(what) from a text prompt with the model the user chose in Settings › Generation models, and save it into the workspace at `path`. It costs plan credit: call it only when the task needs new media, never to test it."
    }

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "prompt": [
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4000,
                    "description": "What to make, in detail: subject, style, composition, colours.",
                ],
                "path": [
                    "type": "string",
                    "description": .string("Workspace-relative file to create, e.g. public/hero.\(kind.defaultExtension). Must not exist yet. Defaults to generated/\(kind.rawValue)-<time>.\(kind.defaultExtension)."),
                ],
            ],
            "required": ["prompt"],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .critical }

    public func summary(input: JSONValue) -> String {
        let prompt = input["prompt"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let model = service.model(for: kind).map { " with \($0.split(separator: ":").last.map(String.init) ?? $0)" } ?? ""
        let path = input["path"]?.stringValue.map { " into \($0)" } ?? ""
        return "Generate \(kind.noun)\(model)\(path): \"\(prompt.prefix(100))\""
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let prompt = input["prompt"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else {
            return .invalidInput(message: "prompt must not be empty.")
        }
        guard prompt.count <= 4000 else { return .invalidInput(message: "prompt must be 4000 characters or fewer.") }
        if let raw = input["path"]?.stringValue {
            do { _ = try WorkspacePath(raw) } catch {
                return .invalidInput(message: "path must be a relative path inside the workspace, without `..`.")
            }
        }
        return nil
    }

    public func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        if let error = precheck(input: input) { throw error }
        let prompt = (input["prompt"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let model = service.model(for: kind) else {
            throw ToolError.executionFailed(message: "No \(kind.title.lowercased()) model is available on this account.")
        }
        let files = try await service.generate(kind: kind, prompt: prompt, model: model)
        guard !files.isEmpty else {
            throw ToolError.executionFailed(message: "The generation finished without a file.")
        }
        let requested = try input["path"]?.stringValue.map { try WorkspacePath($0) }
        var saved: [String] = []
        for (index, file) in files.enumerated() {
            let relative = destination(requested: requested?.value, file: file, index: index)
            let url = try resolve(relative)
            guard !FileManager.default.fileExists(atPath: url.path) else {
                throw ToolError.executionFailed(message: "\(relative) already exists. Choose a new path.")
            }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try file.data.write(to: url, options: .withoutOverwriting)
            saved.append("\(relative) (\(file.mimeType), \(ByteCountFormatter.string(fromByteCount: Int64(file.data.count), countStyle: .file)))")
        }
        let modelName = model.split(separator: ":").last.map(String.init) ?? model
        return ToolResult(content: "Generated \(kind.noun) with \(modelName) and saved it to " + saved.joined(separator: ", ") + ".")
    }

    /// The requested path for the first file, numbered for the rest; else a
    /// timestamped file under `generated/` with the file's own extension.
    func destination(requested: String?, file: CodeGeneratedFile, index: Int) -> String {
        let fileExtension = (file.fileName as NSString).pathExtension.isEmpty ? kind.defaultExtension : (file.fileName as NSString).pathExtension
        guard let requested else {
            let stamp = Int(Date().timeIntervalSince1970)
            return "generated/\(kind.rawValue)-\(stamp)\(index == 0 ? "" : "-\(index + 1)").\(fileExtension)"
        }
        guard index > 0 else { return requested }
        let ns = requested as NSString
        let base = ns.deletingPathExtension
        let ext = ns.pathExtension.isEmpty ? fileExtension : ns.pathExtension
        return "\(base)-\(index + 1).\(ext)"
    }

    /// The file URL for a workspace path, refusing anything that resolves
    /// outside the workspace (a symlinked folder included).
    func resolve(_ relative: String) throws -> URL {
        let path = try WorkspacePath(relative)
        let root = workspaceRoot.standardizedFileURL.resolvingSymlinksInPath()
        let url = root.appendingPathComponent(path.value).standardizedFileURL
        // The nearest folder that exists, resolved: a symlink anywhere above
        // the new file is followed before the check, not after the write.
        var ancestor = url.deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: ancestor.path), ancestor.path != "/" {
            ancestor = ancestor.deletingLastPathComponent()
        }
        let parent = ancestor.resolvingSymlinksInPath()
        guard parent.path == root.path || parent.path.hasPrefix(root.path + "/") else {
            throw ToolError.denied(reason: "\(relative) is outside the workspace.")
        }
        return url
    }
}
