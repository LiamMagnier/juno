import SwiftUI
import Observation
import JunoDesignSystem

/// The @ trigger only matches a word boundary, so an email address never
/// opens suggestions. A selected reference is echoed inline as @label.
public enum NativeContextMention {
    public static func query(in text: String) -> String? {
        guard let at = text.lastIndex(of: "@"), at == text.startIndex || text[text.index(before: at)].isWhitespace else { return nil }
        let tail = String(text[text.index(after: at)...])
        guard !tail.contains(where: \.isWhitespace), tail.count <= 200 else { return nil }
        return tail
    }
    public static func inserting(_ token: NativeContextToken, in text: String) -> String {
        guard let at = text.lastIndex(of: "@"), query(in: text) != nil else { return text }
        return String(text[..<at]) + "@" + token.label + " "
    }
}

/// The focused text field owns this cursor, so selecting a row never takes focus.
@MainActor @Observable
public final class NativeSuggestionCursor {
    public private(set) var selectedIndex = 0
    public private(set) var query: String?
    public private(set) var dismissedQuery: String?
    @ObservationIgnored private var actions: [(() -> Void)?] = []
    public init() {}
    public func configure(query: String?, actions: [(() -> Void)?]) {
        if self.query != query { selectedIndex = 0; dismissedQuery = nil }
        self.query = query
        self.actions = actions
        selectedIndex = min(selectedIndex, max(0, actions.count - 1))
        if actions.indices.contains(selectedIndex), actions[selectedIndex] == nil {
            selectedIndex = actions.firstIndex(where: { $0 != nil }) ?? 0
        }
    }
    public func isOpen(for query: String?) -> Bool { query != nil && dismissedQuery != query }
    public func move(_ offset: Int) {
        guard !actions.isEmpty else { return }
        for step in 1...actions.count {
            let candidate = (selectedIndex + (offset < 0 ? -step : step) + actions.count) % actions.count
            if actions[candidate] != nil { selectedIndex = candidate; return }
        }
    }
    @discardableResult public func pick() -> Bool {
        guard actions.indices.contains(selectedIndex), let action = actions[selectedIndex] else { return false }
        action()
        return true
    }
    public func dismiss(query: String?) { dismissedQuery = query }
}

public enum NativeSlashQuery {
    public static func query(in text: String) -> String? {
        guard text.hasPrefix("/") else { return nil }
        let token = text.dropFirst()
        if token.lowercased().hasPrefix("model "), !token.contains("\n") { return token.lowercased() }
        guard token.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
        return token.lowercased()
    }
}

public struct NativeComposerCommand: Identifiable {
    public let id: String
    public let hint: String
    public let category: String
    public let label: String?
    public init(_ id: String, hint: String, category: String = "Commands", label: String? = nil) {
        self.id = id; self.hint = hint; self.category = category; self.label = label
    }
    public static func matching(_ commands: [Self], query: String) -> [Self] {
        if query.hasPrefix("model ") {
            let term = String(query.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            return commands.filter { $0.id.hasPrefix("model:") && (term.isEmpty || ($0.label ?? "").lowercased().contains(term) || $0.hint.lowercased().contains(term)) }
        }
        return commands.filter { !$0.id.hasPrefix("model:") && ($0.id.hasPrefix(query) || (!query.isEmpty && $0.hint.lowercased().contains(query))) }
    }
}

public struct NativeCommandSuggestions: View {
    let query: String?
    let commands: [NativeComposerCommand]
    let cursor: NativeSuggestionCursor
    let select: (NativeComposerCommand) -> Void
    public init(query: String?, commands: [NativeComposerCommand], cursor: NativeSuggestionCursor, select: @escaping (NativeComposerCommand) -> Void) {
        self.query = query; self.commands = commands; self.cursor = cursor; self.select = select
    }
    private var rows: [NativeComposerCommand] { NativeComposerCommand.matching(commands, query: query ?? "") }
    public var body: some View {
        Group {
            if cursor.isOpen(for: query) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if rows.isEmpty { Text("No matching commands").font(.caption).foregroundStyle(.secondary).padding(12) }
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index == 0 || rows[index - 1].category != row.category {
                                Text(row.category).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.top, 6)
                            }
                            Button { select(row) } label: {
                                HStack {
                                    Text(row.label ?? ("/" + row.id)).fontWeight(.medium)
                                    Text(row.hint).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12).frame(minHeight: 44).contentShape(.rect)
                                .background(index == cursor.selectedIndex ? Color.primary.opacity(0.06) : Color.clear)
                            }.buttonStyle(.plain)
                        }
                    }
                }.frame(maxHeight: min(240, CGFloat(max(1, rows.count)) * 66))
            }
        }
        .task(id: "\(query ?? "nil"):\(rows.map(\.id).joined(separator: ","))") {
            cursor.configure(query: query, actions: rows.map { row in { select(row) } })
        }
        .accessibilityIdentifier("juno.composer.command-suggestions")
    }
}

public struct NativeContextSuggestions: View {
    private let query: String?
    private let search: (String) async throws -> [NativeMentionItem]
    private let select: (NativeContextToken) -> Void
    private let cursor: NativeSuggestionCursor
    @State private var items: [NativeMentionItem] = []
    @State private var failure: String?
    @State private var loading = false

    public init(query: String?, cursor: NativeSuggestionCursor = NativeSuggestionCursor(), search: @escaping (String) async throws -> [NativeMentionItem], select: @escaping (NativeContextToken) -> Void) {
        self.query = query; self.cursor = cursor
        self.search = search; self.select = select
    }

    public var body: some View {
        Group {
            if cursor.isOpen(for: query) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let failure { Text(failure).font(.caption).padding(12) }
                        else if items.isEmpty {
                            Text(loading ? "Searching context…" : "No matching context").font(.caption).foregroundStyle(.secondary).padding(12)
                        }
                        ForEach(Array(items.enumerated()), id: \.element.token.identity) { index, item in
                            if index == 0 || items[index - 1].kind != item.kind {
                                Text(item.kind.suggestionCategory).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.top, 6)
                            }
                            Button { select(item.token) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.label).fontWeight(.medium).foregroundStyle(.primary)
                                    Text(item.subtitle ?? (item.available == false ? "Not connected" : item.kind.suggestionCategory)).font(.caption).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                                .background(index == cursor.selectedIndex ? Color.primary.opacity(0.06) : Color.clear)
                            }.buttonStyle(.plain).disabled(item.available == false).contentShape(.rect)
                        }
                    }
                }.frame(maxHeight: min(240, CGFloat(max(1, items.count)) * 66))
                .accessibilityIdentifier("juno.composer.context-suggestions")
            }
        }
        .task(id: query) {
            items = []; failure = nil; loading = query != nil
            cursor.configure(query: query, actions: [])
            guard let query else { return }
            do {
                try await Task.sleep(for: .milliseconds(120))
                let result = try await search(query)
                guard !Task.isCancelled else { return }
                items = result.sorted { $0.kind.suggestionOrder < $1.kind.suggestionOrder }
                loading = false
                cursor.configure(query: query, actions: items.map { item in item.available == false ? nil : { select(item.token) } })
            } catch is CancellationError {} catch {
                guard !Task.isCancelled else { return }
                loading = false
                failure = "Context could not load. Edit the search to try again."
            }
        }
    }
}

private extension NativeContextToken.Kind {
    var suggestionOrder: Int {
        switch self { case .file: 0; case .project: 1; case .chat: 2; case .app: 3; case .artifact: 4; case .skill: 5; case .crew: 6 }
    }
    var suggestionCategory: String {
        switch self { case .file: "Files"; case .project: "Projects"; case .chat: "Conversations"; case .app: "Apps"; case .artifact: "Library"; case .skill: "Skills"; case .crew: "Agents" }
    }
}
