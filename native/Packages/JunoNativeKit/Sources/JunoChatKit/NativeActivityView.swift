import JunoDesignSystem
import SwiftUI

/// Activity (G70) on both apps: the web's `/activity` page
/// (`src/components/activity/activity-view.tsx`) as one native list.
///
/// Four sections in reading order (Needs you, Running, Ready, Blocked), each
/// state with its glyph AND its word, never colour alone. A row opens the
/// surface that owns the item, where approvals and questions are answered;
/// the one action taken in place is Stop, through each product's own route.
///
/// Keyboard: the list's selection moves with the arrow keys and Return (or a
/// double click) opens the selected row, through `contextMenu(forSelectionType:)`.
public struct NativeActivityView: View {
    @Bindable private var model: NativeActivityModel
    private let onOpen: (NativeActivityItem) -> Void
    private let onStartChat: (() -> Void)?

    @State private var selection: String?
    @State private var now = Date()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        model: NativeActivityModel,
        onOpen: @escaping (NativeActivityItem) -> Void,
        onStartChat: (() -> Void)? = nil
    ) {
        self.model = model
        self.onOpen = onOpen
        self.onStartChat = onStartChat
    }

    public var body: some View {
        content
            .navigationTitle("Activity")
            .task { await model.load() }
            // The web's cadence: 5s while something runs, 30s while only
            // decisions wait, nothing when nothing is live. Paused off screen
            // and while the scene is in the background.
            .task(id: PollKey(interval: model.pollInterval, active: scenePhase == .active)) {
                guard scenePhase == .active, let interval = model.pollInterval else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: interval)
                    if Task.isCancelled { break }
                    now = Date()
                    await model.load()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.load() } }
            }
    }

    private struct PollKey: Hashable {
        let interval: Duration?
        let active: Bool
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading your activity")
        case .failed(let message):
            // ContentUnavailableView rather than JunoEmptyState, which is
            // Mac-only: this view compiles for the phone too.
            ContentUnavailableView {
                Label("Couldn’t load your activity", image: JunoIcon.circleX.assetName)
            } description: {
                Text(verbatim: message)
            } actions: {
                Button("Try again") { Task { await model.retry() } }
            }
        case .loaded:
            if model.isEmpty {
                ContentUnavailableView {
                    Label("Nothing is running", image: JunoIcon.chartLine.assetName)
                } description: {
                    Text("Tasks, Code sessions and research you start show up here while they work, and stay for a day after they finish.")
                } actions: {
                    if let onStartChat {
                        Button("Start a chat", action: onStartChat)
                    }
                }
            } else {
                list
            }
        }
    }

    private var list: some View {
        List(selection: $selection) {
            Section {
                filterPicker
            }
            if model.groups.isEmpty {
                Section {
                    Text("Nothing in this group right now.")
                        .junoUI()
                        .foregroundStyle(Color.junoMutedForeground)
                }
            }
            ForEach(model.groups) { group in
                Section {
                    ForEach(group.items) { item in
                        NativeActivityRow(
                            item: item,
                            now: now,
                            stopping: model.stopping.contains(item.id),
                            stop: { Task { await model.stop(item) } }
                        )
                        .tag(item.id)
                    }
                } header: {
                    NativeActivityGroupHeader(state: group.state, count: model.counts?[group.state] ?? group.items.count)
                }
            }
            if model.nextCursor != nil {
                Section {
                    Button {
                        Task { await model.loadMore() }
                    } label: {
                        HStack {
                            Text(model.loadingMore ? "Loading" : "Show more").junoUI()
                            Spacer(minLength: 0)
                        }
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.loadingMore)
                }
            }
        }
        .contextMenu(forSelectionType: String.self) { ids in
            if let item = item(for: ids) {
                Button("Open") { onOpen(item) }
                if item.canStop {
                    Button("Stop", role: .destructive) { Task { await model.stop(item) } }
                }
            }
        } primaryAction: { ids in
            if let item = item(for: ids) { onOpen(item) }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: model.items.map(\.id))
        .overlay(alignment: .bottom) {
            if let error = model.lastError {
                Text(error)
                    .junoLabel()
                    .foregroundStyle(Color.junoDestructiveInk)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
    }

    private var filterPicker: some View {
        Picker("Show", selection: $model.filter) {
            Text("All").tag(NativeActivityState?.none)
            ForEach(NativeActivityState.allCases) { state in
                Text(verbatim: "\(String(localized: String.LocalizationValue(state.label))) \(model.counts?[state] ?? 0)")
                    .tag(NativeActivityState?.some(state))
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }

    private func item(for ids: Set<String>) -> NativeActivityItem? {
        guard let id = ids.first else { return nil }
        return model.items.first { $0.id == id }
    }
}

/// The state's glyph in its ink (spec §3.4): hand, galaxy, check, circle-x.
public struct NativeActivityStatusMark: View {
    private let state: NativeActivityState
    private let active: Bool
    private let size: CGFloat

    public init(state: NativeActivityState, active: Bool = false, size: CGFloat = 14) {
        self.state = state
        self.active = active
        self.size = size
    }

    public var body: some View {
        Group {
            switch state {
            case .running:
                JunoGalaxyMark(size: size + 2, active: active)
            case .needsYou:
                JunoIconView(.hand, size: size)
            case .ready:
                JunoIconView(.check, size: size)
            case .blocked:
                JunoIconView(.circleX, size: size)
            }
        }
        .foregroundStyle(Self.ink(state))
        .accessibilityHidden(true)
    }

    /// The status ink each state is drawn in. Needs you takes the attention
    /// ink the apps' existing needs-you marks use; the others take the
    /// presence, foreground and destructive inks the web's role tokens alias.
    public static func ink(_ state: NativeActivityState) -> Color {
        switch state {
        case .running: Color.junoPresenceInk
        case .needsYou: JunoStatusTone.attention.color
        case .ready: Color.junoForeground
        case .blocked: Color.junoDestructiveInk
        }
    }
}

struct NativeActivityGroupHeader: View {
    let state: NativeActivityState
    let count: Int

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            NativeActivityStatusMark(state: state, size: 12)
            Text(LocalizedStringKey(state.label))
                .junoLabel()
                .foregroundStyle(NativeActivityStatusMark.ink(state))
            Text(verbatim: "\(count)")
                .junoMicro()
                .monospacedDigit()
                .foregroundStyle(Color.junoMutedForeground)
            Text(LocalizedStringKey(state.hint))
                .junoMicro()
                .foregroundStyle(Color.junoMutedForeground)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct NativeActivityRow: View {
    let item: NativeActivityItem
    let now: Date
    let stopping: Bool
    let stop: () -> Void

    @State private var hovered = false

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.close) {
            NativeActivityStatusMark(state: item.state, active: hovered)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(verbatim: item.title)
                    .junoUI()
                    .fontWeight(item.state == .ready ? .medium : .regular)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                Text(verbatim: meta)
                    .junoMicro()
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.snug)
            if item.canStop {
                Button(action: stop) {
                    JunoIconView(stopping ? .refresh : .circleStop, size: 14)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .disabled(stopping)
                .help("Stop")
                .accessibilityLabel(Text("Stop \(item.title)"))
            }
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "\(item.title), \(String(localized: String.LocalizationValue(item.kind.label))), \(String(localized: String.LocalizationValue(item.state.label)))"))
        .accessibilityHint(Text(LocalizedStringKey(item.verb)))
    }

    private var meta: String {
        var parts = [String(localized: String.LocalizationValue(item.kind.label))]
        if let need = item.need { parts.append(String(localized: String.LocalizationValue(need.label))) }
        if let summary = item.needSummary { parts.append(summary) }
        parts.append(NativeActivityGrouping.timeLabel(for: item, now: now))
        return parts.joined(separator: " · ")
    }
}
