import JunoDesignSystem
import SwiftUI

// MARK: - The tray's pickers (owner, Oct 10: "rework completely the UI and UX
// of submenus on the macOS app")
//
// What a tray chip opens on the Mac: the system popover (Liquid Glass on
// macOS 26, nothing inside draws glass of its own), holding the model
// selector's list language rather than a plain menu:
//
//   ┌──────────────────────────────────────┐
//   │ ⌕  Search projects…                  │  only past ``searchThreshold`` rows
//   ├──────────────────────────────────────┤
//   │ [▢] No project                    ✓  │  pinned, above the sections
//   │ STARRED                              │
//   │ [▣] Field Notes 2.0                  │
//   │     Edited 2 days ago                │
//   │ …                                    │
//   ├──────────────────────────────────────┤
//   │  +  New project…                     │  footer actions
//   └──────────────────────────────────────┘
//
// Each row is an icon on a quiet tile, a title and one secondary line; the
// chosen row carries a quiet check in the foreground ink, never the system's
// blue highlight. One cursor (pointer or arrow keys) draws the hover tone.
// ↑↓ walk the rows and the footer, Return picks, Esc closes, and typing
// searches (or, in a short list with no field, jumps to the first match).
//
// The phone keeps the platform menu: a popover is the Mac's.

/// What a row's trailing edge shows.
public enum NativeTrayPickerAccessory: Equatable, Sendable {
    /// A pick-one row: the quiet check when chosen.
    case check(Bool)
    /// A switch, the stock one, for a row that turns something on for the
    /// next message (an app). Picking it toggles and keeps the list open.
    case toggle(Bool)
    case none
}

/// One row.
public struct NativeTrayPickerItem: Identifiable {
    public let id: String
    public var title: String
    public var subtitle: String?
    /// The row's mark on its tile, or nil for a row of words alone (a
    /// quality, a count), which then needs no column for one.
    public var icon: AnyView?
    public var accessory: NativeTrayPickerAccessory
    public var isEnabled: Bool
    /// More words a search may match (a skill's slug, an app's account).
    public var keywords: String
    public var action: () -> Void

    public init<Icon: View>(
        id: String,
        title: String,
        subtitle: String? = nil,
        accessory: NativeTrayPickerAccessory = .none,
        isEnabled: Bool = true,
        keywords: String = "",
        action: @escaping () -> Void,
        @ViewBuilder icon: () -> Icon
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.icon = AnyView(icon())
        self.accessory = accessory
        self.isEnabled = isEnabled
        self.keywords = keywords
        self.action = action
    }

    /// A row with no mark.
    public init(
        id: String,
        title: String,
        subtitle: String? = nil,
        accessory: NativeTrayPickerAccessory = .none,
        isEnabled: Bool = true,
        keywords: String = "",
        action: @escaping () -> Void
    ) {
        self.init(id: id, title: title, subtitle: subtitle, accessory: accessory, isEnabled: isEnabled, keywords: keywords, action: action) {
            EmptyView()
        }
        icon = nil
    }

    var isToggle: Bool {
        if case .toggle = accessory { return true }
        return false
    }

    var isChosen: Bool {
        switch accessory {
        case .check(let on), .toggle(let on): on
        case .none: false
        }
    }
}

/// A run of rows under an optional heading.
public struct NativeTrayPickerSection: Identifiable {
    public let id: String
    public var title: String?
    /// Quiet words after the heading ("2 of 5 on").
    public var detail: String?
    public var items: [NativeTrayPickerItem]

    public init(id: String, title: String? = nil, detail: String? = nil, items: [NativeTrayPickerItem]) {
        self.id = id
        self.title = title
        self.detail = detail
        self.items = items
    }
}

/// An action under the list: "New project…", "Manage skills…".
public struct NativeTrayPickerAction: Identifiable {
    public let id: String
    public var title: String
    public var icon: JunoIcon
    public var action: () -> Void

    public init(id: String, title: String, icon: JunoIcon, action: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.icon = icon
        self.action = action
    }
}

/// The geometry, shared by the view and the height it asks for.
public enum NativeTrayPickerMetrics {
    public static let width: CGFloat = 320
    /// A short list of values (a quality, a count).
    public static let compactWidth: CGFloat = 260
    /// Above this many rows the list carries a search field.
    public static let searchThreshold = 7
    public static let maxListHeight: CGFloat = 360
    static let searchHeight: CGFloat = 40
    static let rowHeight: CGFloat = 36
    static let tallRowHeight: CGFloat = 46
    static let headingHeight: CGFloat = 28
    static let actionHeight: CGFloat = 32
    static let tile: CGFloat = 26
    static let listPadding: CGFloat = JunoSpace.snug
    static let noteHeight: CGFloat = 64
}

/// The list itself, sized to its rows up to ``NativeTrayPickerMetrics/maxListHeight``.
public struct NativeTrayPicker: View {
    private let identifier: String
    private let header: String?
    private let headerDetail: String?
    private let searchPrompt: String
    private let pinned: [NativeTrayPickerItem]
    private let sections: [NativeTrayPickerSection]
    private let actions: [NativeTrayPickerAction]
    private let emptyMessage: String
    private let width: CGFloat
    private let close: () -> Void

    @State private var query: String
    @State private var cursor: String?
    @State private var keyboardMoved = false
    @State private var lastPointer: CGPoint?
    @State private var typed = ""
    @State private var typedAt = Date.distantPast
    @FocusState private var searchFocused: Bool
    @FocusState private var listFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// - Parameters:
    ///   - pinned: rows above the sections ("No project"), hidden while searching.
    ///   - query/cursor: a starting state, for a preview or a snapshot.
    public init(
        identifier: String,
        header: String? = nil,
        headerDetail: String? = nil,
        searchPrompt: String,
        pinned: [NativeTrayPickerItem] = [],
        sections: [NativeTrayPickerSection],
        actions: [NativeTrayPickerAction] = [],
        emptyMessage: String,
        width: CGFloat = NativeTrayPickerMetrics.width,
        query: String = "",
        cursor: String? = nil,
        close: @escaping () -> Void
    ) {
        self.identifier = identifier
        self.header = header
        self.headerDetail = headerDetail
        self.searchPrompt = searchPrompt
        self.pinned = pinned
        self.sections = sections
        self.actions = actions
        self.emptyMessage = emptyMessage
        self.width = width
        self.close = close
        _query = State(initialValue: query)
        _cursor = State(initialValue: cursor)
    }

    // MARK: Model

    private var rowCount: Int { pinned.count + sections.reduce(0) { $0 + $1.items.count } }
    private var showsSearch: Bool { rowCount > NativeTrayPickerMetrics.searchThreshold }
    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isSearching: Bool { !needle.isEmpty }

    static func matches(_ item: NativeTrayPickerItem, _ needle: String) -> Bool {
        guard !needle.isEmpty else { return true }
        return [item.title, item.subtitle ?? "", item.keywords].contains {
            $0.localizedCaseInsensitiveContains(needle)
        }
    }

    private var visiblePinned: [NativeTrayPickerItem] { isSearching ? [] : pinned }

    private var visibleSections: [NativeTrayPickerSection] {
        sections.compactMap { section in
            let items = section.items.filter { Self.matches($0, needle) }
            guard !items.isEmpty else { return nil }
            var copy = section
            copy.items = items
            return copy
        }
    }

    private static func actionKey(_ action: NativeTrayPickerAction) -> String { "action:" + action.id }

    /// What the arrow keys walk: every enabled row, then the footer.
    private var order: [String] {
        (visiblePinned + visibleSections.flatMap(\.items)).filter(\.isEnabled).map(\.id)
            + actions.map(Self.actionKey)
    }

    /// The height the list asks for: its rows, never past the cap.
    private var listHeight: CGFloat {
        let sections = visibleSections
        var height = NativeTrayPickerMetrics.listPadding * 2
        for item in visiblePinned + sections.flatMap(\.items) {
            height += item.subtitle == nil ? NativeTrayPickerMetrics.rowHeight : NativeTrayPickerMetrics.tallRowHeight
        }
        height += CGFloat(sections.filter { $0.title != nil }.count) * NativeTrayPickerMetrics.headingHeight
        if sections.isEmpty, visiblePinned.isEmpty { height = NativeTrayPickerMetrics.noteHeight }
        return min(height, NativeTrayPickerMetrics.maxListHeight)
    }

    // MARK: Body

    public var body: some View {
        VStack(spacing: 0) {
            if showsSearch {
                searchField
                Divider()
            } else if let header {
                heading(header, detail: headerDetail)
                    .padding(.horizontal, NativeTrayPickerMetrics.listPadding)
                    .padding(.top, JunoSpace.hairline)
            }
            list
            if !actions.isEmpty {
                Divider()
                VStack(spacing: 0) {
                    ForEach(actions) { action in
                        actionRow(action)
                    }
                }
                .padding(NativeTrayPickerMetrics.listPadding)
            }
        }
        .frame(width: width)
        .fixedSize(horizontal: false, vertical: true)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .focusable(!showsSearch)
        .focused($listFocused)
        .focusEffectDisabled()
        .onKeyPress(.downArrow) { move(by: 1) }
        .onKeyPress(.upArrow) { move(by: -1) }
        .onKeyPress(.home) { place(order.first) }
        .onKeyPress(.end) { place(order.last) }
        .onKeyPress(.return) { commit() ? .handled : .ignored }
        .onKeyPress(.escape) {
            if isSearching {
                query = ""
                return .handled
            }
            close()
            return .handled
        }
        .onKeyPress(characters: .alphanumerics.union(.punctuationCharacters).union(.whitespaces), phases: .down) { press in
            typeSelect(press.characters)
        }
        .onAppear {
            if showsSearch { searchFocused = true } else { listFocused = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var searchField: some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(.search, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
            TextField(searchPrompt, text: $query)
                .textFieldStyle(.plain)
                .junoType(.ui)
                .focused($searchFocused)
                .onSubmit { _ = commit() }
                .onChange(of: query) { _, _ in
                    cursor = nil
                }
                .accessibilityLabel(searchPrompt.replacingOccurrences(of: "…", with: ""))
                .accessibilityIdentifier("\(identifier).search")
            if isSearching {
                Button {
                    query = ""
                } label: {
                    JunoIconView(.close, size: 12)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: JunoSpace.section, height: JunoSpace.section)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Clear search")
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: NativeTrayPickerMetrics.searchHeight)
    }

    @ViewBuilder
    private var list: some View {
        let sections = visibleSections
        if sections.isEmpty, visiblePinned.isEmpty {
            Text(isSearching ? "No matches for \u{201C}\(needle)\u{201D}" : emptyMessage)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .frame(height: NativeTrayPickerMetrics.noteHeight)
                .padding(.horizontal, JunoSpace.regular)
                .accessibilityIdentifier("\(identifier).empty")
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(visiblePinned) { item in
                            row(item)
                        }
                        ForEach(sections) { section in
                            if let title = section.title {
                                heading(title, detail: section.detail)
                            }
                            ForEach(section.items) { item in
                                row(item)
                            }
                        }
                    }
                    .padding(NativeTrayPickerMetrics.listPadding)
                }
                .scrollIndicators(.automatic)
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: listHeight)
                .onAppear {
                    // Open on the chosen row when the list is longer than its room.
                    if let chosen = (pinned + self.sections.flatMap(\.items)).first(where: { $0.isChosen && !$0.isToggle }) {
                        proxy.scrollTo(chosen.id, anchor: .center)
                    }
                }
                .onChange(of: cursor) { _, key in
                    guard let key, keyboardMoved else { return }
                    keyboardMoved = false
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        proxy.scrollTo(key)
                    }
                }
            }
        }
    }

    /// The one heading: a word in the second ink, medium, and a quiet detail.
    private func heading(_ title: String, detail: String?) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Text(title)
                .junoType(JunoType.caption.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
            if let detail {
                Text(detail)
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk.opacity(0.7))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.close)
        .frame(height: NativeTrayPickerMetrics.headingHeight - JunoSpace.micro, alignment: .bottom)
        .padding(.bottom, JunoSpace.micro)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ item: NativeTrayPickerItem) -> some View {
        let lit = cursor == item.id && item.isEnabled
        return HStack(spacing: JunoSpace.close) {
            if let icon = item.icon {
                icon.frame(width: NativeTrayPickerMetrics.tile, height: NativeTrayPickerMetrics.tile)
            }
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(item.title)
                    .junoType(item.isChosen && !item.isToggle ? JunoType.ui.weight(.medium) : .ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: JunoSpace.tight)
            accessory(item)
        }
        .padding(.horizontal, JunoSpace.tight)
        .frame(height: item.subtitle == nil ? NativeTrayPickerMetrics.rowHeight : NativeTrayPickerMetrics.tallRowHeight)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoGlassHover.opacity(lit ? 1 : 0))
        }
        .contentShape(.rect)
        .opacity(item.isEnabled ? 1 : 0.45)
        .onTapGesture { activate(item) }
        .onContinuousHover(coordinateSpace: .global) { phase in
            guard case .active(let point) = phase, point != lastPointer else { return }
            lastPointer = point
            if cursor != item.id { cursor = item.id }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .id(item.id)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.subtitle.map { "\(item.title), \($0)" } ?? item.title)
        .accessibilityValue(item.isToggle ? (item.isChosen ? "On" : "Off") : "")
        .accessibilityAddTraits(item.isChosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { activate(item) }
        .accessibilityIdentifier("\(identifier).row.\(item.id)")
    }

    @ViewBuilder
    private func accessory(_ item: NativeTrayPickerItem) -> some View {
        switch item.accessory {
        case .check(let on):
            JunoIconView(.check, size: 14)
                .foregroundStyle(Color.junoForeground)
                .opacity(on ? 1 : 0)
                .frame(width: JunoSpace.regular)
                .accessibilityHidden(true)
        case .toggle(let on):
            Toggle("", isOn: Binding(get: { on }, set: { _ in activate(item) }))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .disabled(!item.isEnabled)
                .accessibilityHidden(true)
        case .none:
            EmptyView()
        }
    }

    private func actionRow(_ action: NativeTrayPickerAction) -> some View {
        let key = Self.actionKey(action)
        let lit = cursor == key
        return HStack(spacing: JunoSpace.close) {
            JunoIconView(action.icon, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: NativeTrayPickerMetrics.tile)
            Text(action.title)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.tight)
        .frame(height: NativeTrayPickerMetrics.actionHeight)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                .fill(Color.junoGlassHover.opacity(lit ? 1 : 0))
        }
        .contentShape(.rect)
        .onTapGesture { run(action) }
        .onContinuousHover(coordinateSpace: .global) { phase in
            guard case .active(let point) = phase, point != lastPointer else { return }
            lastPointer = point
            if cursor != key { cursor = key }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(action.title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { run(action) }
        .accessibilityIdentifier("\(identifier).action.\(action.id)")
    }

    // MARK: Acting

    private func activate(_ item: NativeTrayPickerItem) {
        guard item.isEnabled else { return }
        item.action()
        // A switch stays open for the next one; a pick is done.
        if !item.isToggle { close() }
    }

    private func run(_ action: NativeTrayPickerAction) {
        close()
        action.action()
    }

    private func move(by offset: Int) -> KeyPress.Result {
        let order = order
        guard !order.isEmpty else { return .ignored }
        let at = cursor.flatMap { order.firstIndex(of: $0) } ?? (offset > 0 ? -1 : order.count)
        let next = ((at + offset) % order.count + order.count) % order.count
        return place(order[next])
    }

    private func place(_ key: String?) -> KeyPress.Result {
        guard let key else { return .ignored }
        keyboardMoved = true
        cursor = key
        return .handled
    }

    private func commit() -> Bool {
        let key = cursor ?? (isSearching ? order.first : nil)
        guard let key else { return false }
        if let action = actions.first(where: { Self.actionKey($0) == key }) {
            run(action)
            return true
        }
        guard let item = (visiblePinned + visibleSections.flatMap(\.items)).first(where: { $0.id == key }) else {
            return false
        }
        activate(item)
        return true
    }

    /// A short list has no field: typing jumps to the first row that starts
    /// with what was typed in the last second, as a Mac list does.
    private func typeSelect(_ characters: String) -> KeyPress.Result {
        guard !showsSearch, !characters.isEmpty else { return .ignored }
        let now = Date()
        typed = now.timeIntervalSince(typedAt) < 1 ? typed + characters : characters
        typedAt = now
        let rows = (visiblePinned + visibleSections.flatMap(\.items)).filter(\.isEnabled)
        let hit = rows.first { $0.title.lowercased().hasPrefix(typed.lowercased()) }
            ?? rows.first { Self.matches($0, typed) }
        guard let hit else { return .ignored }
        return place(hit.id)
    }
}

// MARK: - What a list holds, for tests

extension NativeTrayPicker {
    public var pinnedIDs: [String] { pinned.map(\.id) }
    public var sectionTitles: [String] { sections.compactMap(\.title) }
    /// Every row, pinned first, in the order drawn.
    public var rowIDs: [String] { (pinned + sections.flatMap(\.items)).map(\.id) }
    public var actionTitles: [String] { actions.map(\.title) }
    public func subtitle(of id: String) -> String? {
        (pinned + sections.flatMap(\.items)).first { $0.id == id }?.subtitle
    }
    public func isEnabled(_ id: String) -> Bool {
        (pinned + sections.flatMap(\.items)).first { $0.id == id }?.isEnabled ?? false
    }
}

// MARK: - Row icons

/// A web icon on the quiet tile every row's mark sits on.
public struct NativeTrayPickerTile: View {
    private let icon: JunoIcon
    private let isOn: Bool

    public init(_ icon: JunoIcon, isOn: Bool = false) {
        self.icon = icon
        self.isOn = isOn
    }

    public var body: some View {
        JunoIconView(icon, size: 15)
            .foregroundStyle(isOn ? Color.junoForeground : Color.junoSecondaryInk)
            .frame(width: NativeTrayPickerMetrics.tile, height: NativeTrayPickerMetrics.tile)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(Color.junoForeground.opacity(0.06))
            }
            .accessibilityHidden(true)
    }
}

/// An app's own mark on a card-white tile with a hairline, so a logo of any
/// colour reads on light and dark alike.
public struct NativeTrayPickerAppTile: View {
    private let connector: NativeConnector

    public init(_ connector: NativeConnector) {
        self.connector = connector
    }

    public var body: some View {
        JunoConnectorMark(connectorID: connector.id, connectorName: connector.label, logoURL: connector.logoURL, size: 17)
            .frame(width: NativeTrayPickerMetrics.tile, height: NativeTrayPickerMetrics.tile)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(Color.junoCard)
            }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5)
            }
            .accessibilityHidden(true)
    }
}

// MARK: - The chip that opens one

/// A tray chip that opens a ``NativeTrayPicker`` in the system popover.
public struct NativeTrayPopoverChip<Label: View, Panel: View>: View {
    let accessibilityLabel: String
    let identifier: String
    let help: String?
    let picker: (_ close: @escaping () -> Void) -> Panel
    let label: () -> Label
    let isPresented: Binding<Bool>?

    @State private var ownOpen = false

    /// `isPresented` lets the owner open the list from elsewhere (the armed
    /// skill's mark in the field opens the tray's Skills list).
    public init(
        accessibilityLabel: String,
        identifier: String,
        help: String? = nil,
        isPresented: Binding<Bool>? = nil,
        @ViewBuilder picker: @escaping (_ close: @escaping () -> Void) -> Panel,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.identifier = identifier
        self.help = help
        self.picker = picker
        self.label = label
        self.isPresented = isPresented
    }

    private var open: Binding<Bool> { isPresented ?? $ownOpen }

    public var body: some View {
        Button {
            open.wrappedValue.toggle()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                label()
                NativeTrayChevron()
            }
        }
        .buttonStyle(NativeComposerTrayPillStyle(isOn: open.wrappedValue))
        .fixedSize()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens a list")
        .accessibilityIdentifier(identifier)
        #if os(macOS)
        .help(help ?? accessibilityLabel)
        #endif
        // Torn down with the chip: a popover whose anchor leaves the hierarchy
        // while presented makes AppKit order a child window against one that
        // is going (the model chip's `NSRemoteView` lesson).
        .onDisappear { open.wrappedValue = false }
        .popover(isPresented: open, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            picker { open.wrappedValue = false }
        }
    }
}

// MARK: - The tray's lists

/// The tray's three lists, built from the tray's own values so the chips and
/// the snapshots draw the same thing.
@MainActor
public enum NativeComposerTrayPickers {
    /// "Edited 2 days ago", against `now`.
    public static func edited(_ date: Date, now: Date = Date()) -> String {
        if now.timeIntervalSince(date) < 60 { return "Edited just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return "Edited " + formatter.localizedString(for: date, relativeTo: now)
    }

    static func projectSubtitle(_ project: NativeComposerTrayProject, now: Date) -> String? {
        let edited = project.updatedAt.map { edited($0, now: now) }
        switch (project.parentName, edited) {
        case let (parent?, edited?): return "In \(parent) \u{00B7} \(edited.prefix(1).lowercased() + edited.dropFirst())"
        case let (parent?, nil): return "In \(parent)"
        case let (nil, edited): return edited
        }
    }

    /// The project list: "No project", then Starred and Recent (newest
    /// first), then "New project…".
    public static func projects(
        _ projects: NativeComposerTrayProjects,
        now: Date = Date(),
        query: String = "",
        cursor: String? = nil,
        close: @escaping () -> Void
    ) -> NativeTrayPicker {
        func item(_ project: NativeComposerTrayProject) -> NativeTrayPickerItem {
            let chosen = projects.selectedID == project.id
            return NativeTrayPickerItem(
                id: project.id,
                title: project.name,
                subtitle: projectSubtitle(project, now: now),
                accessory: .check(chosen),
                action: { projects.select(project.id) }
            ) {
                NativeTrayPickerTile(chosen ? .folderOpen : .projects, isOn: chosen)
            }
        }
        let byRecency = projects.items.enumerated().sorted { lhs, rhs in
            switch (lhs.element.updatedAt, rhs.element.updatedAt) {
            case let (l?, r?) where l != r: return l > r
            default: return lhs.offset < rhs.offset
            }
        }.map(\.element)
        let starred = byRecency.filter(\.starred)
        let rest = byRecency.filter { !$0.starred }
        var sections: [NativeTrayPickerSection] = []
        if !starred.isEmpty {
            sections.append(NativeTrayPickerSection(id: "starred", title: "Starred", items: starred.map(item)))
        }
        if !rest.isEmpty {
            sections.append(NativeTrayPickerSection(id: "recent", title: starred.isEmpty ? "Projects" : "Recent", items: rest.map(item)))
        }
        let none = NativeTrayPickerItem(
            id: "none",
            title: "No project",
            accessory: .check(projects.selectedID == nil),
            action: { projects.select(nil) }
        ) {
            NativeTrayPickerTile(.conversation, isOn: projects.selectedID == nil)
        }
        return NativeTrayPicker(
            identifier: "juno.composer-tray.project.list",
            header: "Project",
            searchPrompt: "Search projects…",
            pinned: [none],
            sections: sections,
            actions: projects.create.map { [NativeTrayPickerAction(id: "new", title: "New project…", icon: .plus, action: $0)] } ?? [],
            emptyMessage: "No projects yet",
            query: query,
            cursor: cursor,
            close: close
        )
    }

    /// Every connected app with its own mark, how it is connected, and a
    /// switch for this chat; "Connect more…" under them.
    public static func apps(
        _ apps: NativeComposerTrayApps,
        query: String = "",
        cursor: String? = nil,
        close: @escaping () -> Void
    ) -> NativeTrayPicker {
        let onCount = apps.connectors.filter { apps.enabled.contains($0.id) }.count
        let full = apps.limit.map { onCount >= $0 } ?? false
        let items = apps.connectors.map { connector in
            let on = apps.enabled.contains(connector.id)
            let blocked = full && !on
            let account = connector.accountLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let subtitle: String
            if blocked, let limit = apps.limit {
                subtitle = "Up to \(limit) at once. Turn one off first"
            } else if !connector.connected {
                subtitle = "Not connected"
            } else if !account.isEmpty {
                subtitle = "Connected as \(account)"
            } else {
                subtitle = "Connected"
            }
            return NativeTrayPickerItem(
                id: connector.id,
                title: connector.label,
                subtitle: subtitle,
                accessory: .toggle(on),
                isEnabled: !blocked,
                keywords: [account, connector.detail].joined(separator: " "),
                action: { apps.toggle(connector.id) }
            ) {
                NativeTrayPickerAppTile(connector)
            }
        }
        let detail = apps.limit.map { "\(onCount) of \($0) on" } ?? (onCount > 0 ? "\(onCount) on" : nil)
        return NativeTrayPicker(
            identifier: "juno.composer-tray.apps.list",
            header: "Use in this chat",
            headerDetail: detail,
            searchPrompt: "Search apps…",
            sections: items.isEmpty ? [] : [NativeTrayPickerSection(
                id: "apps",
                title: items.count > NativeTrayPickerMetrics.searchThreshold ? "Use in this chat" : nil,
                detail: detail,
                items: items
            )],
            actions: apps.manage.map {
                [NativeTrayPickerAction(id: "connect", title: apps.connectors.isEmpty ? "Connect an app…" : "Connect more…", icon: .plus, action: $0)]
            } ?? [],
            emptyMessage: apps.isLoading ? "Loading apps…" : "No apps connected yet",
            query: query,
            cursor: cursor,
            close: close
        )
    }

    /// The skills by name with what each does, grouped Yours, Built-in and
    /// Installed; "No skill" first, "Manage skills…" under them.
    public static func skills(
        _ skills: NativeComposerTraySkills,
        query: String = "",
        cursor: String? = nil,
        close: @escaping () -> Void
    ) -> NativeTrayPicker {
        let sections = NativeComposerTraySkill.Origin.allCases.compactMap { origin -> NativeTrayPickerSection? in
            let mine = skills.items.filter { $0.origin == origin }
            guard !mine.isEmpty else { return nil }
            return NativeTrayPickerSection(id: origin.rawValue, title: origin.title, items: mine.map { skill in
                let armed = skills.armed == skill.slug
                let about = skill.description.trimmingCharacters(in: .whitespacesAndNewlines)
                return NativeTrayPickerItem(
                    id: skill.slug,
                    title: skill.name,
                    subtitle: about.isEmpty ? (skill.source ?? "/\(skill.slug)") : about,
                    accessory: .check(armed),
                    keywords: [skill.slug, skill.source ?? ""].joined(separator: " "),
                    action: { skills.arm(armed ? nil : skill.slug) }
                ) {
                    NativeTrayPickerTile(.skills, isOn: armed)
                }
            })
        }
        let none = NativeTrayPickerItem(
            id: "none",
            title: "No skill",
            accessory: .check(skills.armed == nil),
            action: { skills.arm(nil) }
        ) {
            NativeTrayPickerTile(.circleSlash, isOn: skills.armed == nil)
        }
        return NativeTrayPicker(
            identifier: "juno.composer-tray.skills.list",
            header: "Use a skill",
            searchPrompt: "Search skills…",
            pinned: skills.items.isEmpty ? [] : [none],
            sections: sections,
            actions: skills.browse.map { [NativeTrayPickerAction(id: "manage", title: "Manage skills…", icon: .settings, action: $0)] } ?? [],
            emptyMessage: skills.isLoading ? "Loading skills…" : "No skills yet. Write one or install one in Skills.",
            query: query,
            cursor: cursor,
            close: close
        )
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
