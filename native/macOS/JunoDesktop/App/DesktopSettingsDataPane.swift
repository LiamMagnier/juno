import AppKit
import JunoChatKit
import JunoDesignSystem
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

/// Settings › Data & privacy (`sections/data-privacy.tsx`): export and import,
/// the links you have shared, and deleting every conversation at once.
struct DesktopSettingsDataPane: View {
    let context: DesktopSettingsContext

    @State private var exporting: NativeAccountDataClient.ExportFormat?
    @State private var exportDocument: DesktopSettingsExportDocument?
    @State private var exportType: UTType = .json
    @State private var exportName = ""
    @State private var showingExporter = false
    @State private var importPhase: DesktopImportPhase = .idle
    @State private var showingImporter = false
    @State private var isDropTargeted = false
    @State private var showsExportHelp = false
    @State private var confirmation: JunoConfirmation?
    @State private var copiedLinkID: String?

    var body: some View {
        DesktopSettingsForm {
            Section {
                exportRow
                importRow
            }

            Section {
                sharedLinkRows
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Shared links",
                    note: "Anyone with one of these links can open what it shows."
                )
            }

            Section {
                DesktopSettingRow(
                    title: "Delete all conversations",
                    description: "Every chat and its messages, at once. Memories and projects stay.",
                    tone: .destructive
                ) {
                    DesktopOutlineButton(title: "Delete All…", destructive: true) {
                        confirmation = JunoConfirmation(
                            title: "Delete all conversations?",
                            message: "Every conversation and its messages are deleted for good. Memories and projects stay. This can’t be undone.",
                            confirmTitle: "Delete All Conversations"
                        ) { deleteAll() }
                    }
                    .disabled(context.services.accountData == nil)
                    .accessibilityIdentifier("juno.desktop.settings.delete-all-conversations")
                }
            }
        }
        .junoConfirmation($confirmation)
        .fileExporter(
            isPresented: $showingExporter,
            document: exportDocument,
            contentType: exportType,
            defaultFilename: exportName
        ) { result in
            if case .failure(let error) = result {
                context.toasts.post(.error("Couldn’t export your data.", detail: error.localizedDescription))
            }
            exportDocument = nil
        }
        .task { await context.loadSharedLinks() }
    }

    // MARK: Export

    private var exportRow: some View {
        DesktopSettingRow(
            title: "Export your data",
            description: "Profile, settings, conversations, memories, projects and file details."
        ) {
            HStack(spacing: JunoSpace.snug) {
                if exporting != nil {
                    ProgressView().controlSize(.small)
                }
                Menu {
                    exportItem(.json, title: "JSON", detail: "Everything, in one readable file.")
                    exportItem(.juno, title: "Alevr Package", detail: "Everything, plus your Library files where they fit.")
                    exportItem(.csv, title: "CSV", detail: "Your conversations, for a spreadsheet.")
                } label: {
                    Text("Export")
                }
                .menuStyle(.button)
                .buttonStyle(.junoGlass)
                .tint(nil)
                .fixedSize()
                .disabled(exporting != nil || context.services.accountData == nil)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.desktop.settings.export")
            }
        }
    }

    private func exportItem(_ format: NativeAccountDataClient.ExportFormat, title: String, detail: String) -> some View {
        Button {
            export(format)
        } label: {
            Label {
                Text(title)
                Text(detail)
            } icon: {
                JunoIconView(.download, size: 16)
            }
        }
        .contentShape(.rect)
    }

    private func export(_ format: NativeAccountDataClient.ExportFormat) {
        guard let client = context.services.accountData else { return }
        exporting = format
        Task {
            defer { exporting = nil }
            do {
                let url = try await client.export(format: format, for: context.accountID)
                let data = try Data(contentsOf: url)
                try? FileManager.default.removeItem(at: url)
                exportDocument = DesktopSettingsExportDocument(data: data)
                switch url.pathExtension {
                case "csv": exportType = .commaSeparatedText
                case "zip": exportType = .zip
                default: exportType = .json
                }
                exportName = url.deletingPathExtension().lastPathComponent
                showingExporter = true
            } catch {
                context.toasts.post(.error("Couldn’t export your data.", detail: NativeFailureMessage.presentable(error)))
            }
        }
    }

    // MARK: Import

    private var importRow: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            DesktopSettingRow(
                title: "Import chat history",
                description: "From ChatGPT, Claude, Gemini or another Alevr account. A .zip or .json export up to 100 MB, or drop it here."
            ) {
                DesktopOutlineButton(title: "Choose File…") { showingImporter = true }
                    .disabled(importPhase.isBusy || context.services.importer == nil)
                    .accessibilityIdentifier("juno.desktop.settings.import")
            }
            DesktopImportProgress(phase: importPhase, retry: { showingImporter = true })
            Button {
                showsExportHelp.toggle()
            } label: {
                Text("Where to find your export")
                    .junoType(.ui)
                    .underline(color: Color.junoBorder)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if showsExportHelp {
                Text("In ChatGPT, open Settings, Data controls, Export data. In Claude, open Settings, Privacy, Export data. Both email you a .zip. Imported messages are encrypted at rest like everything else in Alevr.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, isDropTargeted ? JunoSpace.snug : 0)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoHover)
                .opacity(isDropTargeted ? 1 : 0)
        }
        .animation(JunoMotion.fast, value: isDropTargeted)
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
            guard !importPhase.isBusy, let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in startImport(url) }
            }
            return true
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.zip, .json]) { result in
            if case .success(let url) = result { startImport(url) }
        }
    }

    private func startImport(_ url: URL) {
        guard let importer = context.services.importer, !importPhase.isBusy else { return }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if let refusal = NativeImportClient.refusal(fileName: url.lastPathComponent, byteCount: size) {
            importPhase = .failed(refusal)
            return
        }
        importPhase = .uploading
        let name = url.lastPathComponent
        Task {
            // Read off the main actor: an export can be 100 MB.
            let data = await Task.detached(priority: .userInitiated) { () -> Data? in
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return try? Data(contentsOf: url)
            }.value
            guard let data else {
                importPhase = .failed("Alevr couldn’t read that file.")
                return
            }
            do {
                let result = try await importer.importHistory(data: data, fileName: name, for: context.accountID)
                importPhase = .done(result)
                if result.imported == 0 {
                    context.toasts.post(.info("Nothing new to import. Those conversations are already here."))
                }
            } catch {
                importPhase = .failed(NativeFailureMessage.presentable(error))
            }
        }
    }

    // MARK: Shared links

    @ViewBuilder
    private var sharedLinkRows: some View {
        switch context.sharedLinks {
        case .loading:
            DesktopSettingRowSkeleton()
            DesktopSettingRowSkeleton()
        case .failed:
            HStack(spacing: JunoSpace.cozy) {
                DesktopSettingsNote(text: "Couldn’t load your shared links.", tone: .error)
                DesktopOutlineButton(title: "Try Again") {
                    Task { await context.loadSharedLinks() }
                }
            }
        case .loaded(let links):
            if links.isEmpty {
                DesktopSettingsNote(text: "Nothing shared yet. Links you make from a chat or an artifact appear here.")
            } else {
                ForEach(links) { link in
                    DesktopSharedLinkRow(
                        link: link,
                        isCopied: copiedLinkID == link.id,
                        copy: { copy(link) },
                        revoke: { await context.revoke(link) }
                    )
                }
            }
        }
    }

    private func copy(_ link: DesktopSharedLink) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link.url.absoluteString, forType: .string)
        copiedLinkID = link.id
        AccessibilityNotification.Announcement("Copied").post()
        Task {
            try? await Task.sleep(for: .milliseconds(1500))
            if copiedLinkID == link.id { copiedLinkID = nil }
        }
    }

    // MARK: Delete all

    private func deleteAll() {
        guard let client = context.services.accountData else { return }
        Task {
            do {
                try await client.deleteAllConversations(for: context.accountID)
                context.toasts.post(.success("All conversations deleted."))
                await context.services.syncModel?.refresh()
            } catch {
                context.toasts.post(.error("Couldn’t delete conversations."))
            }
        }
    }
}

/// One shared link: its kind's glyph, the title, "Chat · Sep 22, 2026 · 14
/// views", Copy Link and Revoke.
struct DesktopSharedLinkRow: View {
    let link: DesktopSharedLink
    let isCopied: Bool
    let copy: () -> Void
    let revoke: () async -> Void

    @State private var revoking = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(link.isChat ? .chats : .codeBrackets, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Button {
                    openURL(link.url)
                } label: {
                    Text(link.title.trimmingCharacters(in: .whitespaces).isEmpty ? "Untitled" : link.title)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                Text(Self.meta(link))
                    .junoType(JunoType.label.weight(.regular))
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.cozy)
            Button(action: copy) {
                JunoIconView(isCopied ? .check : .copy, size: 15)
                    .foregroundStyle(isCopied ? Color.junoSuccessInk : Color.junoSecondaryInk)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(isCopied ? "Copied" : "Copy link")
            .accessibilityLabel(isCopied ? "Copied" : "Copy link")
            Button {
                revoking = true
                Task {
                    await revoke()
                    revoking = false
                }
            } label: {
                Text(revoking ? "Revoking…" : "Revoke")
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Color.junoDestructiveInk)
            .disabled(revoking)
        }
        .frame(minHeight: 44)
    }

    static func meta(_ link: DesktopSharedLink) -> String {
        var parts = [link.isChat ? "Chat" : "Artifact"]
        if let date = link.snapshotAt {
            parts.append(date.formatted(.dateTime.month(.abbreviated).day().year()))
        }
        parts.append("\(link.views.formatted()) \(link.views == 1 ? "view" : "views")")
        return parts.joined(separator: " · ")
    }
}

// MARK: - Import progress

/// Where an import stands (the web's `ImportPhase`, less the byte count the
/// Mac's sender cannot report).
enum DesktopImportPhase: Equatable {
    case idle
    case uploading
    case done(NativeImportResult)
    case failed(String)

    var isBusy: Bool { self == .uploading }
}

/// The line under the import row, in the web's words.
struct DesktopImportProgress: View {
    let phase: DesktopImportPhase
    let retry: () -> Void

    var body: some View {
        switch phase {
        case .idle:
            EmptyView()
        case .uploading:
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Uploading")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                ProgressView()
                    .progressViewStyle(.linear)
                    .tint(Color.junoAccent)
                    .frame(maxWidth: 320)
                    .accessibilityLabel("Upload progress")
            }
        case .done(let result):
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.circleCheck, size: 14)
                    .foregroundStyle(Color.junoSuccessInk)
                Text(Self.summary(result))
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .failed(let message):
            HStack(spacing: JunoSpace.cozy) {
                DesktopSettingsNote(text: message, tone: .error)
                DesktopOutlineButton(title: "Try Another File", action: retry)
            }
        }
    }

    /// The web's result sentence.
    static func summary(_ result: NativeImportResult) -> String {
        guard result.restoredAnything else { return "Everything in that export is already here." }
        func count(_ n: Int, _ one: String, _ many: String) -> String {
            "\(n.formatted()) \(n == 1 ? one : many)"
        }
        var sentence = "\(count(result.imported, "conversation", "conversations")), "
            + "\(count(result.projectsImported, "project", "projects")), "
            + "\(count(result.memoriesImported, "memory", "memories")) and "
            + "\(count(result.attachmentsImported, "file", "files")) restored from \(result.providerLabel)."
        let left = result.skipped + result.attachmentsSkipped
        if left > 0 { sentence += " \(left.formatted()) already here or unavailable." }
        return sentence
    }
}
