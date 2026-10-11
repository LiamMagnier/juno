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
    @ObservationIgnored private var actions: [() -> Void] = []
    public init() {}
    public func configure(query: String?, actions: [() -> Void]) {
        if self.query != query { selectedIndex = 0; dismissedQuery = nil }
        self.query = query
        self.actions = actions
        selectedIndex = min(selectedIndex, max(0, actions.count - 1))
    }
    public func isOpen(for query: String?) -> Bool { query != nil && dismissedQuery != query }
    public func move(_ offset: Int) {
        guard !actions.isEmpty else { return }
        selectedIndex = (selectedIndex + offset + actions.count) % actions.count
    }
    @discardableResult public func pick() -> Bool {
        guard actions.indices.contains(selectedIndex) else { return false }
        actions[selectedIndex]()
        return true
    }
    public func dismiss(query: String?) { dismissedQuery = query }
}

public enum NativeSlashQuery {
    public static func query(in text: String) -> String? {
        guard text.hasPrefix("/") else { return nil }
        let token = text.dropFirst()
        guard token.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
        return token.lowercased()
    }
}

public struct NativeComposerCommand: Identifiable {
    public let id: String
    public let hint: String
    public let category: String
    public init(_ id: String, hint: String, category: String = "Commands") {
        self.id = id; self.hint = hint; self.category = category
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
    private var rows: [NativeComposerCommand] { commands.filter { $0.id.hasPrefix(query ?? "") } }
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
                                    Text("/" + row.id).fontWeight(.medium)
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
                                Text(item.kind.rawValue.capitalized).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.top, 6)
                            }
                            Button { select(item.token) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.label).fontWeight(.medium).foregroundStyle(.primary)
                                    Text(item.subtitle ?? item.kind.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                                .background(index == cursor.selectedIndex ? Color.primary.opacity(0.06) : Color.clear)
                            }.buttonStyle(.plain).contentShape(.rect)
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
                items = Array(result.filter { $0.available != false }.prefix(12)).sorted { $0.kind.rawValue < $1.kind.rawValue }
                loading = false
                cursor.configure(query: query, actions: items.map { item in { select(item.token) } })
            } catch is CancellationError {} catch {
                guard !Task.isCancelled else { return }
                loading = false
                failure = "Context could not load. Edit the search to try again."
            }
        }
    }
}
