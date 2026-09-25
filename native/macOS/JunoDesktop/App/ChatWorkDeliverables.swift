import AppKit
import CoreGraphics
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - What a task made, as files

/// One file a task made, with the size this Mac has learned for it (zero
/// until it is on disk: the artifact list carries none).
struct ChatWorkFile: Identifiable, Equatable {
    let artifact: WorkArtifactSummary
    var size: Int = 0

    var id: String { artifact.artifactID }

    /// The file as a transcript tile draws it. The id carries the version, so
    /// a revised deliverable is a new page rather than the old one's preview.
    var attachment: NativeChatAttachment {
        NativeChatAttachment(
            id: Self.attachmentID(artifact),
            fileName: Self.fileName(artifact),
            mimeType: artifact.mimeType,
            kind: "FILE",
            size: size,
            width: nil,
            height: nil
        )
    }

    static func attachmentID(_ artifact: WorkArtifactSummary) -> String {
        "work-\(artifact.artifactID)-v\(artifact.currentVersion)"
    }

    /// The title as a file name, with the kind's extension: the legacy
    /// window's rule, so a file saved from either reads the same.
    static func fileName(_ artifact: WorkArtifactSummary) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:\0")
        let cleaned = artifact.title
            .components(separatedBy: invalid)
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = cleaned.isEmpty ? artifact.identifier : cleaned
        let suffix = ".\(artifact.kind.fileExtension)"
        return base.lowercased().hasSuffix(suffix) ? base : base + suffix
    }

    /// The kinds the web previews inline (`canPreviewArtifact`): the newest of
    /// these leads the finished card.
    static func leads(_ kind: JunoWorkArtifactKind) -> Bool {
        kind == .site || kind == .report || kind == .spreadsheet
    }

    /// `stagedArtifact`: the newest previewable one, or nil.
    static func lead(of files: [ChatWorkFile]) -> ChatWorkFile? {
        files.filter { leads($0.artifact.kind) }.max { $0.artifact.updatedAt < $1.artifact.updatedAt }
    }
}

extension EnvironmentValues {
    /// Where a task's files come from — the chat's ``ChatWorkFiles``, or the
    /// snapshot harness's stills — and what opening one does. The card sits
    /// inside the transcript, whose own media provider serves messages.
    @Entry var junoWorkFiles: (any TranscriptMediaProviding)? = nil
    @Entry var junoWorkFileActions = TranscriptMediaActions()
}

/// A task's files on this Mac: downloaded once from
/// `/api/work/artifacts/{id}/download` into
/// `Caches/<bundle>/WorkFiles/<account>/<artifact>/`, purged at sign-out with
/// the transcript's cache, under the transcript's 51 MB ceiling.
///
/// It is a ``TranscriptMediaProviding`` so the finished card draws a task's
/// files with the very tile a chat's files use — Quick Look, Open With, Save
/// As and dragging out included. The page on a tile is drawn here, from the
/// file: PDFKit, ImageIO or QuickLook for a first page, the opening lines for
/// text.
@MainActor
@Observable
final class ChatWorkFiles: TranscriptMediaProviding {
    static let fileByteLimit = NativeChatMediaLoader.fileByteLimit

    /// `~/Library/Caches/<bundle id>/WorkFiles`.
    nonisolated static var defaultCacheRoot: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "Juno", isDirectory: true)
            .appendingPathComponent("WorkFiles", isDirectory: true)
    }

    /// Removes every task file this Mac downloaded, for every account. Called
    /// at sign-out beside the transcript's purge.
    nonisolated static func purgeCachedFiles(at root: URL? = defaultCacheRoot) {
        guard let root else { return }
        try? FileManager.default.removeItem(at: root)
    }

    let accountID: AccountID?
    @ObservationIgnored private let client: NativeWorkClient?
    @ObservationIgnored private let cacheRoot: URL?

    /// Bytes on disk by artifact id, for the captions.
    private(set) var sizes: [String: Int] = [:]
    /// Artifacts whose bytes the export validator never confirmed open.
    private(set) var unvalidated: Set<String> = []
    private var previews: [String: NativeTranscriptPreviewState] = [:]

    @ObservationIgnored private var files: [String: URL] = [:]
    @ObservationIgnored private var fileTasks: [String: Task<URL, any Error>] = [:]
    @ObservationIgnored private var previewLoads: Set<String> = []

    init(client: NativeWorkClient?, accountID: AccountID?, cacheRoot: URL? = ChatWorkFiles.defaultCacheRoot) {
        self.client = client
        self.accountID = accountID
        self.cacheRoot = cacheRoot
    }

    /// The task's files with the sizes learned so far.
    func files(for artifacts: [WorkArtifactSummary]) -> [ChatWorkFile] {
        artifacts.map { ChatWorkFile(artifact: $0, size: sizes[$0.artifactID] ?? 0) }
    }

    // MARK: TranscriptMediaProviding

    func imageState(for _: NativeChatAttachment) -> NativeTranscriptImageState { .failed }
    func loadImage(_: NativeChatAttachment) async {}
    func seed(_: Data, for _: String) {}

    func previewState(for attachment: NativeChatAttachment) -> NativeTranscriptPreviewState {
        previews[attachment.id] ?? .loading
    }

    func loadPreview(_ attachment: NativeChatAttachment) async {
        let id = attachment.id
        guard previews[id] == nil, !previewLoads.contains(id) else { return }
        previewLoads.insert(id)
        defer { previewLoads.remove(id) }
        guard let url = try? await fileURL(for: attachment) else {
            previews[id] = .ready(NativeTranscriptFilePreview())
            return
        }
        var preview = NativeTranscriptFilePreview()
        let sized = NativeChatAttachment(
            id: id, fileName: attachment.fileName, mimeType: attachment.mimeType, kind: attachment.kind,
            size: Self.byteCount(at: url), width: nil, height: nil
        )
        if sized.viewerKind == .text {
            preview.excerpt = await Task.detached(priority: .utility) { Self.excerpt(at: url) }.value
        }
        if let kind = NativeChatMediaLoader.localThumbnailKind(for: sized) {
            preview.thumbnail = await NativeChatMediaLoader.localThumbnail(kind, at: url)
        }
        previews[id] = .ready(preview)
    }

    func fileURL(for attachment: NativeChatAttachment) async throws -> URL {
        let id = attachment.id
        if let known = files[id], FileManager.default.fileExists(atPath: known.path) { return known }
        if let running = fileTasks[id] { return try await running.value }
        guard let (artifactID, version) = Self.parse(id) else { throw NativeTranscriptFileError.unavailable }
        let destination = cacheRoot.flatMap { root in
            accountID.map {
                root.appendingPathComponent($0.rawValue, isDirectory: true)
                    .appendingPathComponent(artifactID, isDirectory: true)
                    .appendingPathComponent("v\(version)", isDirectory: true)
                    .appendingPathComponent(attachment.fileName)
            }
        }
        if let destination, FileManager.default.fileExists(atPath: destination.path) {
            files[id] = destination
            sizes[artifactID] = Self.byteCount(at: destination)
            return destination
        }
        let task = Task { @MainActor [weak self] () throws -> URL in
            guard let self else { throw NativeTranscriptFileError.unavailable }
            return try await self.download(artifactID: artifactID, version: version, to: destination, name: attachment.fileName)
        }
        fileTasks[id] = task
        defer { fileTasks[id] = nil }
        let url = try await task.value
        files[id] = url
        return url
    }

    /// Whether this file's bytes were served without passing the export
    /// validator — Save As asks first.
    func isUnvalidated(_ attachment: NativeChatAttachment) -> Bool {
        Self.parse(attachment.id).map { unvalidated.contains($0.artifactID) } ?? false
    }

    private func download(artifactID: String, version: Int, to destination: URL?, name: String) async throws -> URL {
        guard let client, let accountID else { throw NativeTranscriptFileError.signedOut }
        let download: WorkArtifactDownload
        do {
            download = try await client.downloadArtifact(id: artifactID, version: version, for: accountID)
        } catch {
            throw NativeTranscriptFileError.unavailable
        }
        guard download.bytes.count <= Self.fileByteLimit else {
            throw NativeTranscriptFileError.tooLarge(maximumBytes: Self.fileByteLimit)
        }
        let target = destination ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-work-\(artifactID)", isDirectory: true)
            .appendingPathComponent(name)
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try download.bytes.write(to: target, options: .atomic)
        sizes[artifactID] = download.bytes.count
        if !download.validated { unvalidated.insert(artifactID) } else { unvalidated.remove(artifactID) }
        return target
    }

    /// `work-<artifact>-v<version>` back into its parts.
    nonisolated static func parse(_ attachmentID: String) -> (artifactID: String, version: Int)? {
        guard attachmentID.hasPrefix("work-"), let marker = attachmentID.range(of: "-v", options: .backwards),
            let version = Int(attachmentID[marker.upperBound...]), version > 0
        else { return nil }
        let artifactID = String(attachmentID[attachmentID.index(attachmentID.startIndex, offsetBy: 5)..<marker.lowerBound])
        return artifactID.isEmpty ? nil : (artifactID, version)
    }

    private nonisolated static func byteCount(at url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
    }

    /// The opening lines of a text file, as a tile's page prints them.
    private nonisolated static func excerpt(at url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 4_096), let text = String(data: data, encoding: .utf8)
        else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(900))
    }
}

// MARK: - The finished card's deliverables

/// What the task made (register #58): the newest previewable file leads by
/// name, then **every** file as a page tile — Quick Look on a click or Space,
/// Quick Look · Open With Default App · Save As… in the context menu, and a
/// drag out as the file itself.
///
/// **Signature detail of the finished card:** the deliverable leads as a real
/// page, so a finished task reads as "here is what it made" before "here is
/// what it did".
struct ChatWorkDeliverables: View {
    let files: [ChatWorkFile]
    var now: Date? = nil

    @Environment(\.junoWorkFiles) private var workFiles
    @Environment(\.junoWorkFileActions) private var workActions

    var body: some View {
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if let lead = ChatWorkFile.lead(of: files) {
                    leadLine(lead)
                }
                JunoChipFlow(spacing: JunoSpace.snug) {
                    // The lead first, so the page named above is the first
                    // one under it.
                    ForEach(Self.ordered(files)) { file in
                        ChatWorkFileTile(attachment: file.attachment)
                    }
                }
                .environment(\.junoTranscriptMedia, workFiles)
                .environment(\.junoTranscriptMediaActions, workActions)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("What it produced")
            .accessibilityIdentifier("juno.chat.work-card.deliverables")
        }
    }

    static func ordered(_ files: [ChatWorkFile]) -> [ChatWorkFile] {
        guard let lead = ChatWorkFile.lead(of: files) else { return files }
        return [lead] + files.filter { $0.id != lead.id }
    }

    private func leadLine(_ file: ChatWorkFile) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
            Text(file.artifact.title)
                .junoFont(size: 15, relativeTo: .body, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 0) {
                // The format is an identifier, so mono; the rest is words.
                Text(file.artifact.kind.fileExtension.uppercased())
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                Text(" \u{00B7} v\(file.artifact.currentVersion) \u{00B7} \(ChatWorkFormat.ago(file.artifact.updatedAt, now: now ?? Date()))")
                    .junoFont(size: 11, relativeTo: .caption)
                    .monospacedDigit()
            }
            .foregroundStyle(Color.junoSecondaryInk)
        }
    }
}

/// A task's file as the transcript's page tile, which also drags out as the
/// file — fetched when the drop asks for it, not when the drag starts.
struct ChatWorkFileTile: View {
    let attachment: NativeChatAttachment
    @Environment(\.junoTranscriptMedia) private var media

    var body: some View {
        FileTile(attachment: attachment)
            .onDrag { dragItem() }
    }

    private func dragItem() -> NSItemProvider {
        let provider = NSItemProvider()
        provider.suggestedName = attachment.fileName
        guard let media else { return provider }
        let attachment = attachment
        let type = UTType(filenameExtension: attachment.fileExtension) ?? UTType(mimeType: attachment.mimeType) ?? .data
        provider.registerFileRepresentation(for: type, visibility: .all, openInPlace: false) { completion in
            let reply = DragFileReply(completion)
            Task { @MainActor in
                do {
                    reply.send(try await media.fileURL(for: attachment))
                } catch {
                    reply.fail(error)
                }
            }
            return nil
        }
        return provider
    }
}

// MARK: - Saving a file

/// The save panel for a task's file (moved from the legacy window's
/// `DesktopWorkArtifactSavePanel`): the panel opens at once, and the copy
/// lands when the download behind it is done.
enum ChatWorkFileSaving {
    /// The question asked before saving bytes the validator never opened —
    /// the legacy window's words.
    static let unvalidatedTitle = "This artifact has not been validated"
    static let unvalidatedMessage =
        "Juno verified the bytes but the export validator has not confirmed that this file opens. Save it only if you are ready to check it yourself."

    @MainActor
    static func save(
        _ attachment: NativeChatAttachment,
        from files: any TranscriptMediaProviding,
        failed: @escaping @MainActor (String) -> Void
    ) {
        let download = Task { try await files.fileURL(for: attachment) }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = attachment.fileName
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let destination = panel.url else { return }
            Task { @MainActor in
                do {
                    let source = try await download.value
                    let manager = FileManager.default
                    if manager.fileExists(atPath: destination.path) {
                        try manager.removeItem(at: destination)
                    }
                    try manager.copyItem(at: source, to: destination)
                } catch {
                    failed(NativeFailureMessage.presentable(error))
                }
            }
        }
    }
}

// MARK: - The column's task presentations

/// What the chat column presents for its tasks, kept off the column's own
/// long modifier chain: "Save this task as a skill", the question before
/// saving a file the validator never opened, and the permissions re-read each
/// time Juno comes to the front (B4).
struct ChatWorkPresentations: ViewModifier {
    @Binding var skillCapture: ChatSkillCaptureDraft?
    @Binding var pendingUnvalidatedSave: NativeChatAttachment?
    @Binding var systemPermissions: DesktopWorkSystemPermissions
    let saveSkill: (ChatSkillCaptureDraft) async -> String?
    let saveUnvalidated: (NativeChatAttachment) -> Void

    func body(content: Content) -> some View {
        content
            .sheet(item: $skillCapture) { draft in
                ChatSkillCaptureSheet(draft: draft, save: saveSkill, close: { skillCapture = nil })
            }
            .confirmationDialog(
                ChatWorkFileSaving.unvalidatedTitle,
                isPresented: Binding(
                    get: { pendingUnvalidatedSave != nil },
                    set: { if !$0 { pendingUnvalidatedSave = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Save Anyway") {
                    if let attachment = pendingUnvalidatedSave { saveUnvalidated(attachment) }
                    pendingUnvalidatedSave = nil
                }
                Button("Cancel", role: .cancel) { pendingUnvalidatedSave = nil }
            } message: {
                Text(ChatWorkFileSaving.unvalidatedMessage)
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                let current = DesktopWorkSystemPermissions.current
                if current != systemPermissions { systemPermissions = current }
            }
    }
}
