import SwiftUI
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

public struct NativeContextSuggestions: View {
    private let query: String?
    private let search: (String) async throws -> [NativeMentionItem]
    private let select: (NativeContextToken) -> Void
    @State private var items: [NativeMentionItem] = []
    @State private var failure: String?

    public init(query: String?, search: @escaping (String) async throws -> [NativeMentionItem], select: @escaping (NativeContextToken) -> Void) {
        self.query = query
        self.search = search
        self.select = select
    }

    public var body: some View {
        Group {
            if query != nil {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Add context").junoType(.caption).foregroundStyle(.secondary).padding(.horizontal, 12)
                    if let failure { Text(failure).font(.caption).padding(12) }
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(items.prefix(12), id: \.token.identity) { item in
                                Button { select(item.token) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.label).foregroundStyle(.primary)
                                        Text(item.subtitle ?? item.kind.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                                }.buttonStyle(.plain).disabled(item.available == false).contentShape(.rect)
                            }
                        }
                    }.frame(maxHeight: 240)
                }
                .accessibilityIdentifier("juno.composer.context-suggestions")
            }
        }
        .task(id: query) {
            items = []; failure = nil
            guard let query else { return }
            do {
                try await Task.sleep(for: .milliseconds(120))
                let result = try await search(query)
                guard !Task.isCancelled else { return }
                items = result
            } catch is CancellationError {} catch {
                guard !Task.isCancelled else { return }
                failure = "Context could not load. Edit the search to try again."
            }
        }
    }
}
