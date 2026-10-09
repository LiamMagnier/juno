import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

/// Everything Alevr made — chat artifacts and task deliverables — newest first,
/// from `GET /api/library/made`: the Library's other half (the web's "Made by
/// Alevr", `library-home.tsx`).
///
/// A plain list: the type glyph, the title, one quiet line ("Made by Alevr ·
/// Spreadsheet · 3 days ago"). An artifact opens its page; a deliverable opens
/// the chat its task ran in, and its file can be saved from the row's menu.
struct JunoMobileLibraryMadeView: View {
    @Bindable var model: NativeLibraryMadeModel
    var artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    var accountID: AccountID?
    var workClient: NativeWorkClient?
    var openConversation: ((String) -> Void)?

    @State private var searchText = ""
    @State private var export: JunoMobileMadeExport?
    @State private var failure: String?

    var body: some View {
        List {
            if let items = model.items {
                ForEach(items, id: \.listID) { item in
                    row(item)
                }
                if model.hasMore {
                    Button(model.isLoadingMore ? "Loading…" : "Show more") {
                        Task { await model.loadMore() }
                    }
                    .contentShape(.rect)
                    .disabled(model.isLoadingMore)
                    .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { overlay }
        .navigationTitle("Made by Alevr")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $searchText, prompt: "Search what was made")
        .refreshable { await model.reload() }
        .task {
            if model.items == nil { await model.reload() }
        }
        .task(id: searchText) {
            if !searchText.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            var query = model.query
            query.q = searchText
            await model.setQuery(query)
        }
        .navigationDestination(for: JunoMobileMadeArtifactRoute.self) { route in
            if let artifactModel, let artifact = artifactModel.artifacts.first(where: { $0.id == route.id }) {
                JunoMobileArtifactDetail(
                    model: artifactModel,
                    artifact: artifact,
                    openConversation: { openConversation?($0) }
                )
            } else {
                ContentUnavailableView(
                    "Not on this iPhone yet",
                    systemImage: "arrow.triangle.2.circlepath",
                    description: Text("It will open once your account finishes syncing.")
                )
            }
        }
        .fileExporter(
            isPresented: Binding(get: { export != nil }, set: { if !$0 { export = nil } }),
            document: export?.document,
            contentType: .data,
            defaultFilename: export?.name
        ) { _ in export = nil }
        .alert("Couldn’t download", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK") { failure = nil }
                .contentShape(.rect)
        } message: {
            Text(failure ?? "")
        }
    }

    @ViewBuilder
    private var overlay: some View {
        if model.items == nil, let error = model.errorDescription {
            ContentUnavailableView {
                Label("Couldn’t load what Alevr made", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try Again") { Task { await model.reload() } }
                    .contentShape(.rect)
            }
        } else if model.items == nil {
            ProgressView()
        } else if model.items?.isEmpty == true {
            if searchText.isEmpty {
                ContentUnavailableView(
                    "Nothing made yet",
                    systemImage: "square.stack",
                    description: Text("Pages, documents, spreadsheets and decks Alevr makes in your chats and tasks gather here.")
                )
            } else {
                ContentUnavailableView.search(text: searchText)
            }
        }
    }

    @ViewBuilder
    private func row(_ item: NativeLibraryMadeItem) -> some View {
        let label = HStack(spacing: JunoSpace.cozy) {
            Image(systemName: Self.symbol(for: item))
                .font(.body)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 32, height: 32)
                .background(Color.junoSecondary, in: .rect(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.isEmpty ? "Untitled" : item.title)
                    .font(.body)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(Self.meta(item))
                    .font(.footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)

        Group {
            switch item.kind {
            case .artifact:
                NavigationLink(value: JunoMobileMadeArtifactRoute(id: item.id)) { label }
            case .deliverable:
                Button {
                    if let conversationID = item.conversationId, let openConversation {
                        openConversation(conversationID)
                    } else {
                        save(item)
                    }
                } label: { label.contentShape(.rect) }
                .buttonStyle(.plain)
            }
        }
        .contextMenu {
            if item.kind == .deliverable, workClient != nil {
                Button { save(item) } label: { Label("Save to Files", systemImage: "square.and.arrow.down") }
                    .contentShape(.rect)
            }
            if let conversationID = item.conversationId, let openConversation {
                Button { openConversation(conversationID) } label: {
                    Label("Open Its Chat", systemImage: "bubble.left")
                }
                .contentShape(.rect)
            }
        }
    }

    private func save(_ item: NativeLibraryMadeItem) {
        guard let workClient, let accountID else { return }
        Task {
            do {
                let file = try await workClient.downloadArtifact(id: item.id, for: accountID)
                export = JunoMobileMadeExport(
                    name: Self.fileName(for: item),
                    document: JunoMobileMadeDocument(data: file.bytes)
                )
            } catch {
                failure = NativeFailureMessage.presentable(error)
            }
        }
    }

    static func meta(_ item: NativeLibraryMadeItem) -> String {
        "\(item.byline) · \(item.typeLabel) · \(item.updatedAt.formatted(.relative(presentation: .named)))"
    }

    static func symbol(for item: NativeLibraryMadeItem) -> String {
        switch item.type.uppercased() {
        case "SPREADSHEET", "XLSX", "CSV": "tablecells"
        case "PRESENTATION", "PPTX": "rectangle.on.rectangle"
        case "DOCUMENT", "DOCX", "MARKDOWN": "doc.text"
        case "PDF", "REPORT": "doc.richtext"
        case "DESIGN", "SVG", "IMAGE": "paintbrush"
        case "CODE", "REACT": "chevron.left.forwardslash.chevron.right"
        case "HTML", "SITE": "globe"
        case "MERMAID": "point.3.connected.trianglepath.dotted"
        default: "square.stack"
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

struct JunoMobileMadeArtifactRoute: Hashable {
    let id: String
}

private struct JunoMobileMadeExport {
    let name: String
    let document: JunoMobileMadeDocument
}

private struct JunoMobileMadeDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration _: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
