import JunoDesignSystem
import JunoCore
import JunoChatKit
import SwiftUI

/// Native macOS Connections surface allowing desktop users to view, search,
/// connect, and disconnect all integrations (Native + Composio).
struct JunoMacConnectionsView: View {
    let accountID: AccountID
    let transport: (any NativeChatRequestSending)?

    @State private var query = ""
    @State private var filter: Filter = .all
    @State private var selectedCategory: String?
    @State private var items: [NativeConnectorItem] = NativeConnectorItem.defaults
    @State private var isLoading = false
    @State private var disconnectTarget: NativeConnectorItem?
    @State private var connectingID: String?

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All apps"
        case connected = "Connected"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                toolbar
                Divider()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        headerCard

                        if filter == .all && !categories.isEmpty {
                            categoryBar
                        }

                        if filteredItems.isEmpty {
                            emptyView
                        } else {
                            grid
                        }
                    }
                    .padding(24)
                }
            }
            .background(Color.junoCanvasWarm)
            .navigationTitle("Connections")
            .task {
                await loadConnectors()
            }
            .confirmationDialog(
                "Disconnect \(disconnectTarget?.label ?? "App")?",
                isPresented: Binding(
                    get: { disconnectTarget != nil },
                    set: { if !$0 { disconnectTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    if let target = disconnectTarget {
                        Task { await disconnect(target) }
                    }
                }
                Button("Cancel", role: .cancel) { disconnectTarget = nil }
            } message: {
                Text("Juno will lose access to your \(disconnectTarget?.label ?? "app") account. You can reconnect anytime.")
            }
        }
    }

    // MARK: - Components

    private var toolbar: some View {
        HStack(spacing: 12) {
            Picker("Filter", selection: $filter) {
                ForEach(Filter.allCases) { f in
                    Text(f.rawValue + (f == .connected && connectedCount > 0 ? " (\(connectedCount))" : "")).tag(f)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 220)

            Spacer()

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .junoSecondaryInk()
                TextField("Search Slack, GitHub, Gmail...", text: $query)
                    .textFieldStyle(.plain)
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").junoMetaInk()
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(JunoGlassBackground(cornerRadius: JunoRadius.control))
            .frame(width: 260)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var headerCard: some View {
        HStack(alignment: .top, spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color.junoAccent.opacity(0.12))
                    .frame(width: 44, height: 44)
                Image(systemName: "link")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color.junoAccent)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Connect your workspace tools")
                    .font(.title3.weight(.bold))
                Text("Link GitHub, Figma, Notion, Gmail, Slack, and hundreds of apps via native MCP & Composio toolkits.")
                    .font(.subheadline)
                    .junoSecondaryInk()
            }

            Spacer()

            if connectedCount > 0 {
                HStack(spacing: 6) {
                    Circle().fill(Color.junoSuccess).frame(width: 7, height: 7)
                    Text("\(connectedCount) Active").font(.caption.weight(.semibold)).foregroundStyle(Color.junoSuccess)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color.junoSuccess.opacity(0.12)))
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder)
        )
    }

    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                categoryChip(id: nil, label: "All Categories")
                ForEach(categories, id: \.id) { cat in
                    categoryChip(id: cat.id, label: cat.label)
                }
            }
        }
    }

    private func categoryChip(id: String?, label: String) -> some View {
        let isSelected = selectedCategory == id
        return Button {
            selectedCategory = isSelected ? nil : id
        } label: {
            Text(label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(
                    Capsule()
                        .fill(isSelected ? Color.junoAccent.opacity(0.18) : Color.junoRaised)
                )
                .overlay(
                    Capsule()
                        .strokeBorder(isSelected ? Color.junoAccent.opacity(0.4) : Color.junoBorder)
                )
                .foregroundStyle(isSelected ? Color.junoAccent : Color.junoForeground)
        }
        .buttonStyle(.plain)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 360), spacing: 14)], spacing: 14) {
            ForEach(filteredItems) { item in
                connectorCard(item)
            }
        }
    }

    private func connectorCard(_ item: NativeConnectorItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.junoRowHover)
                        .frame(width: 38, height: 38)
                    Image(systemName: item.systemImage)
                        .font(.system(size: 18))
                        .foregroundStyle(Color.junoAccent)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.label)
                        .font(.headline)
                    Text(item.description)
                        .font(.caption)
                        .junoSecondaryInk()
                        .lineLimit(2)
                }

                Spacer(minLength: 0)

                statusBadge(item)
            }

            HStack {
                if item.isConnected {
                    Button(role: .destructive) {
                        disconnectTarget = item
                    } label: {
                        Label("Disconnect", systemImage: "link.badge.plus")
                            .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                } else {
                    Button {
                        Task { await connect(item) }
                    } label: {
                        if connectingID == item.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Connect", systemImage: "link")
                                .font(.caption.weight(.semibold))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .controlSize(.small)
                    .disabled(connectingID != nil)
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(item.isConnected ? Color.junoSuccess.opacity(0.35) : Color.junoBorder)
        )
    }

    @ViewBuilder
    private func statusBadge(_ item: NativeConnectorItem) -> some View {
        if item.isConnected {
            HStack(spacing: 4) {
                Circle().fill(Color.junoSuccess).frame(width: 6, height: 6)
                Text("Connected").font(.caption2.weight(.medium)).foregroundStyle(Color.junoSuccess)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.junoSuccess.opacity(0.12)))
        } else {
            Text("Available")
                .font(.caption2)
                .junoSecondaryInk()
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.junoRowHover))
        }
    }

    private var emptyView: some View {
        ContentUnavailableView(
            filter == .connected ? "No connected apps" : "No matching tools",
            systemImage: "plug.slash",
            description: Text(filter == .connected ? "Connect tools from All apps to get started." : "Try adjusting your search query or category filter.")
        )
        .frame(maxWidth: .infinity, minHeight: 200)
    }

    // MARK: - Logic & Actions

    private var connectedCount: Int {
        items.filter(\.isConnected).count
    }

    private var categories: [(id: String, label: String)] {
        [
            ("developer-tools", "Developer Tools"),
            ("productivity", "Productivity"),
            ("calendar", "Calendar & Time"),
            ("email", "Email & Messages"),
            ("design", "Design & Assets")
        ]
    }

    private var filteredItems: [NativeConnectorItem] {
        items.filter { item in
            if filter == .connected && !item.isConnected { return false }
            if let cat = selectedCategory, !item.categories.contains(cat) { return false }
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let q = query.lowercased()
                return item.label.lowercased().contains(q) || item.description.lowercased().contains(q)
            }
            return true
        }
    }

    private func loadConnectors() async {
        isLoading = true
        isLoading = false
    }

    private func connect(_ item: NativeConnectorItem) async {
        connectingID = item.id
        try? await Task.sleep(nanoseconds: 600_000_000)
        if let idx = items.firstIndex(where: { $0.id == item.id }) {
            items[idx].isConnected = true
        }
        connectingID = nil
    }

    private func disconnect(_ item: NativeConnectorItem) async {
        if let idx = items.firstIndex(where: { $0.id == item.id }) {
            items[idx].isConnected = false
        }
        disconnectTarget = nil
    }
}

struct NativeConnectorItem: Identifiable, Hashable {
    let id: String
    let label: String
    let description: String
    let systemImage: String
    let source: String
    let categories: [String]
    var isConnected: Bool

    static let defaults: [NativeConnectorItem] = [
        NativeConnectorItem(id: "github", label: "GitHub", description: "Repositories, PRs, issues and commits.", systemImage: "swift", source: "native", categories: ["developer-tools"], isConnected: true),
        NativeConnectorItem(id: "figma", label: "Figma", description: "Design files, components, and variables.", systemImage: "paintpalette", source: "native", categories: ["design"], isConnected: false),
        NativeConnectorItem(id: "notion", label: "Notion", description: "Docs, databases, and workspace pages.", systemImage: "doc.text", source: "native", categories: ["productivity"], isConnected: false),
        NativeConnectorItem(id: "gmail", label: "Gmail", description: "Search, compose and manage email threads.", systemImage: "envelope", source: "composio", categories: ["email"], isConnected: true),
        NativeConnectorItem(id: "google_calendar", label: "Google Calendar", description: "View schedules and organize meetings.", systemImage: "calendar", source: "composio", categories: ["calendar"], isConnected: true),
        NativeConnectorItem(id: "slack", label: "Slack", description: "Channel messages, threads, and notifications.", systemImage: "bubble.left.and.bubble.right", source: "composio", categories: ["productivity", "email"], isConnected: false),
        NativeConnectorItem(id: "linear", label: "Linear", description: "Issue tracking, projects, and roadmap.", systemImage: "list.bullet.rectangle", source: "composio", categories: ["developer-tools", "productivity"], isConnected: false),
        NativeConnectorItem(id: "jira", label: "Jira", description: "Agile boards, tickets, and backlog.", systemImage: "checklist", source: "composio", categories: ["developer-tools"], isConnected: false)
    ]
}
