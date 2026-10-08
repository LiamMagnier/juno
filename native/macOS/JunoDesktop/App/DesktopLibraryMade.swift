import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

/// What the Library shows: the files you gave Alevr, or what it made.
///
/// The web's Library is one page for both (`library-home.tsx`, "All · Made ·
/// Files · Media"). The Mac's file half has its own controls (type, sort,
/// list/grid, selection, drop to upload) that mean nothing for made things, so
/// the two halves are two views of one page rather than one interleaved list.
enum DesktopLibraryShow: String, CaseIterable {
    case files
    case made
}

/// Everything Alevr made — chat artifacts and task deliverables — newest
/// first, from `GET /api/library/made`.
///
/// Rows, not cards: a type glyph, the title, one quiet line ("Made by Alevr ·
/// Spreadsheet · 3 days ago"). An artifact opens its page; a deliverable opens
/// the chat its task ran in, and saves its file from the row's menu.
struct DesktopLibraryMadeList: View {
    @Bindable var model: NativeLibraryMadeModel
    var accountID: AccountID?
    var workClient: NativeWorkClient?
    var openConversation: ((String) -> Void)?

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @State private var hoveredID: String?
    @State private var download: DesktopLibraryMadeDownload?

    var body: some View {
        Group {
            if let error = model.errorDescription, model.items == nil {
                JunoEmptyState(
                    title: "Couldn’t load what Alevr made",
                    message: error,
                    icon: .triangleAlert,
                    actionLabel: "Try Again",
                    action: { Task { await model.reload() } },
                    tone: .error
                )
            } else if model.items == nil {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 160)
            } else if let items = model.items, items.isEmpty {
                JunoEmptyState(
                    title: model.query.q.isEmpty ? "Nothing made yet" : "Nothing made matches",
                    message: model.query.q.isEmpty
                        ? "Pages, documents, spreadsheets and decks Alevr makes in your chats and tasks gather here."
                        : "Search looks at the names of what was made. Try a client, a month or a number.",
                    icon: .artifacts
                )
            } else if let items = model.items {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    VStack(spacing: 0) {
                        ForEach(items, id: \.listID) { item in
                            row(item)
                        }
                    }
                    if model.hasMore {
                        Button(model.isLoadingMore ? "Loading…" : "Show more") {
                            Task { await model.loadMore() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.isLoadingMore)
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .task {
            if model.items == nil { await model.reload() }
        }
        .fileExporter(
            isPresented: Binding(get: { download != nil }, set: { if !$0 { download = nil } }),
            document: download?.document,
            contentType: .data,
            defaultFilename: download?.name
        ) { _ in download = nil }
    }

    private func row(_ item: NativeLibraryMadeItem) -> some View {
        let hovered = hoveredID == item.listID
        return HStack(spacing: JunoSpace.cozy) {
            JunoIconView(Self.icon(for: item), size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(Color.junoSecondary)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.isEmpty ? "Untitled" : item.title)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(Self.meta(item))
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                actions(for: item)
            } label: {
                JunoIconView(.ellipsis, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .opacity(hovered ? 1 : 0)
            .accessibilityLabel("More actions for \(item.title)")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(hovered ? Color.junoHover : Color.clear)
                .padding(.horizontal, JunoSpace.tight)
        )
        .contentShape(.rect)
        .onTapGesture { open(item) }
        .onHover { inside in
            withAnimation(JunoMotion.fast) { hoveredID = inside ? item.listID : (hoveredID == item.listID ? nil : hoveredID) }
        }
        .contextMenu { actions(for: item) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title), \(Self.meta(item))")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private func actions(for item: NativeLibraryMadeItem) -> some View {
        switch item.kind {
        case .artifact:
            Button("Open") { open(item) }
        case .deliverable:
            Button("Save a Copy…") { save(item) }
                .disabled(workClient == nil || accountID == nil)
        }
        if let conversationID = item.conversationId, openConversation != nil {
            Button("Open Its Chat") { openConversation?(conversationID) }
        }
    }

    private func open(_ item: NativeLibraryMadeItem) {
        switch item.kind {
        case .artifact:
            push(.artifact(item.id, version: nil))
        case .deliverable:
            if let conversationID = item.conversationId, let openConversation {
                openConversation(conversationID)
            } else {
                save(item)
            }
        }
    }

    private func save(_ item: NativeLibraryMadeItem) {
        guard let workClient, let accountID else { return }
        Task {
            do {
                let file = try await workClient.downloadArtifact(id: item.id, for: accountID)
                download = DesktopLibraryMadeDownload(
                    name: Self.fileName(for: item),
                    document: DesktopLibraryFileDocument(data: file.bytes)
                )
            } catch {
                toast(.error("Couldn’t download \(item.title)", detail: NativeFailureMessage.presentable(error)))
            }
        }
    }

    // MARK: - Words

    static func meta(_ item: NativeLibraryMadeItem) -> String {
        let age = item.updatedAt.formatted(.relative(presentation: .named))
        return "\(item.byline) · \(item.typeLabel) · \(age)"
    }

    static func icon(for item: NativeLibraryMadeItem) -> JunoIcon {
        switch item.type.uppercased() {
        case "DESIGN": .design
        case "CODE", "REACT": .code
        default: item.kind == .deliverable ? .file : .artifacts
        }
    }

    static func fileName(for item: NativeLibraryMadeItem) -> String {
        let base = item.title.isEmpty ? "Untitled" : item.title
        let ext: String? = switch item.type.uppercased() {
        case "SPREADSHEET", "XLSX": "xlsx"
        case "PRESENTATION", "PPTX": "pptx"
        case "DOCUMENT", "DOCX": "docx"
        case "PDF", "REPORT": "pdf"
        case "CSV": "csv"
        default: item.mimeType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
        }
        guard let ext, !base.lowercased().hasSuffix(".\(ext)") else { return base }
        return "\(base).\(ext)"
    }
}

private struct DesktopLibraryMadeDownload {
    let name: String
    let document: DesktopLibraryFileDocument
}
