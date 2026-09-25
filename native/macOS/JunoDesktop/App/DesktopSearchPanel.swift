import AppKit
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - Geometry

/// Where the detail column sits in the window, read by ``ChatDetail`` so the
/// panel can centre itself on it: the column's frame in the window's
/// coordinate space, and how much of its top the toolbar covers.
struct DesktopPanelAnchor: Equatable {
    var frame: CGRect = .zero
    var toolbarInset: CGFloat = 0
}

/// The panel's measures (Phase 3 brief, B1). One deterministic function of
/// what is showing, so the shape never depends on a measurement taken while
/// it animates.
enum DesktopSearchPanelMetrics {
    static let coordinateSpace = "juno.chat.window"
    static let maxWidth: CGFloat = 640
    static let sideMargin: CGFloat = 16
    /// Below the toolbar.
    static let topOffset: CGFloat = 72
    static let fieldHeight: CGFloat = 56
    static let filtersHeight: CGFloat = 44
    /// The list's floor: the searching state's five skeleton rows and the
    /// list's own padding, so results landing under a query never reshape
    /// the panel (the web's `min-h-[13rem]`).
    static let listFloor: CGFloat = 208
    static let maxHeight: CGFloat = 480
    static let cornerRadius: CGFloat = JunoRadius.panel
    static let listInset: CGFloat = JunoSpace.snug
    static let rowHeight: CGFloat = 36
    static let snippetRowHeight: CGFloat = 52
    static let headerLine: CGFloat = 20
    static let noticeLine: CGFloat = 16

    static func width(detailWidth: CGFloat) -> CGFloat {
        max(280, min(maxWidth, detailWidth - 2 * sideMargin))
    }

    /// The list's natural height: its padding, each group header (4pt above
    /// the first, 24 above later ones, 4 below) and each row.
    static func listContentHeight(_ rows: [DesktopPanelRow]) -> CGFloat {
        var height = 2 * listInset
        var previousGroup: String?
        for row in rows {
            if row.group != previousGroup {
                height += (previousGroup == nil ? 4 : 24) + headerLine + 4
                previousGroup = row.group
            }
            height += row.hasSnippet ? snippetRowHeight : rowHeight
        }
        return height
    }

    static func noticesHeight(_ count: Int) -> CGFloat {
        count == 0 ? 0 : CGFloat(count) * noticeLine + 2 * JunoSpace.snug + 1
    }

    /// The whole panel: field, filters, notices and a list held between its
    /// floor and the cap of `min(480, window − 144)`.
    static func height(
        listContent: CGFloat,
        showsFilters: Bool,
        noticeCount: Int,
        windowHeight: CGFloat
    ) -> CGFloat {
        let chrome = fieldHeight + (showsFilters ? filtersHeight : 0) + noticesHeight(noticeCount)
        let cap = max(chrome + listFloor, min(maxHeight, windowHeight - 144))
        let list = min(max(listContent, listFloor), cap - chrome)
        return chrome + list
    }
}

// MARK: - Host

extension View {
    /// The ⌘K / Search panel over the Chat window (B1): a window-level
    /// overlay on the split view, centred on the detail column.
    ///
    /// No scrim: a clear layer over the whole window takes the click that
    /// dismisses it. Opening it first closes any popover anchored below —
    /// the window does that before it presents (crash rule 4).
    func desktopSearchPanel(
        _ model: DesktopSearchPanelModel,
        anchor: DesktopPanelAnchor,
        hooks: DesktopCommandCatalog.Hooks,
        projects: [NativeProject],
        commands: @escaping () -> DesktopCommandCatalog.Context,
        perform: @escaping (DesktopPanelAction) -> Void
    ) -> some View {
        modifier(
            DesktopSearchPanelHost(
                model: model,
                anchor: anchor,
                hooks: hooks,
                projects: projects,
                commands: commands,
                perform: perform
            )
        )
    }
}

private struct DesktopSearchPanelHost: ViewModifier {
    let model: DesktopSearchPanelModel
    let anchor: DesktopPanelAnchor
    let hooks: DesktopCommandCatalog.Hooks
    let projects: [NativeProject]
    let commands: () -> DesktopCommandCatalog.Context
    let perform: (DesktopPanelAction) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whatever had focus when the panel opened — the composer, usually — so
    /// it can have it back.
    @State private var previousResponder: WeakResponder?

    func body(content: Content) -> some View {
        content
            .coordinateSpace(.named(DesktopSearchPanelMetrics.coordinateSpace))
            .overlay {
                GeometryReader { proxy in
                    ZStack(alignment: .topLeading) {
                        if model.isPresented {
                            Color.clear
                                .contentShape(.rect)
                                .onTapGesture { model.dismiss() }
                                .accessibilityHidden(true)
                            panel(windowSize: proxy.size)
                        }
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                    .animation(
                        model.isPresented
                            ? JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)
                            : Optional(JunoMotion.exit),
                        value: model.isPresented
                    )
                }
            }
            .onChange(of: model.isPresented) { _, presented in
                if presented {
                    previousResponder = WeakResponder(NSApp.keyWindow?.firstResponder)
                } else if let responder = previousResponder?.value,
                    let window = (responder as? NSView)?.window ?? (responder as? NSWindow)
                {
                    window.makeFirstResponder(responder)
                    previousResponder = nil
                }
            }
    }

    private func panel(windowSize: CGSize) -> some View {
        let detail = anchor.frame.width > 0 ? anchor.frame : CGRect(origin: .zero, size: windowSize)
        let width = DesktopSearchPanelMetrics.width(detailWidth: detail.width)
        let rows = currentRows
        let height = DesktopSearchPanelMetrics.height(
            listContent: DesktopSearchPanelMetrics.listContentHeight(rows),
            showsFilters: model.showsFilters,
            noticeCount: model.notices.count,
            windowHeight: windowSize.height
        )
        let top = detail.minY + anchor.toolbarInset + DesktopSearchPanelMetrics.topOffset
        return DesktopSearchPanel(
            model: model,
            rows: rows,
            projects: projects,
            height: height,
            run: run
        )
        .frame(width: width, height: height)
        .offset(x: detail.midX - width / 2, y: min(top, max(0, windowSize.height - height - JunoSpace.section)))
        .transition(
            .asymmetric(
                insertion: .opacity.combined(
                    with: .scale(scale: JunoMotion.scaleFrom(0.98, reduceMotion: reduceMotion), anchor: .top)
                ),
                removal: .opacity
            )
        )
        .animation(JunoMotion.reduced(JunoMotion.layout, when: reduceMotion), value: height)
    }

    private var currentRows: [DesktopPanelRow] {
        switch model.mode {
        case .commands:
            var context = commands()
            context.hooks = hooks
            return DesktopCommandCatalog.rows(query: model.query, context: context)
        case .search:
            return model.searchRows(hooks: hooks)
        }
    }

    /// Runs a row. "Search everything" changes mode in place; everything
    /// else closes the panel first and runs a turn later, so a surface it
    /// opens is not closed again by the panel's own focus hand-back.
    private func run(_ row: DesktopPanelRow) {
        if row.action == .searchEverything {
            model.switchMode(to: .search)
            return
        }
        model.dismiss()
        let action = row.action
        Task { @MainActor in perform(action) }
    }
}

/// A first responder, held weakly: the panel must not keep a closed
/// window's field alive.
private struct WeakResponder: Equatable {
    weak var value: NSResponder?

    init(_ value: NSResponder?) {
        self.value = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.value === rhs.value }
}

// MARK: - The panel

/// The ⌘K / Search panel (Phase 3 brief, B1; spec §7.4): one glass panel with
/// two modes.
///
/// **The signature detail** is that it holds its shape while you type — the
/// list has a floor, so a keystroke never shrinks the panel to a sliver and
/// back — and that the reason each row is there is legible in it: the words
/// that matched are set in semibold in the row's own ink, never washed in
/// coral (P3-10).
///
/// Glass is the shell only (an allow-listed site, §0.1). Rows are plain; the
/// active one takes the glass hover fill in a concentric rectangle.
struct DesktopSearchPanel: View {
    @Bindable var model: DesktopSearchPanelModel
    let rows: [DesktopPanelRow]
    let projects: [NativeProject]
    let height: CGFloat
    let run: (DesktopPanelRow) -> Void

    enum Focus: Hashable {
        case field
        case filters
    }

    @FocusState private var focus: Focus?
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var announced = ""

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: DesktopSearchPanelMetrics.cornerRadius, style: .continuous)
    }

    private var isCommands: Bool { model.mode == .commands }

    var body: some View {
        ScrollViewReader { scroller in
            VStack(spacing: 0) {
                field(scroller: scroller)
                if model.showsFilters {
                    DesktopSearchPanelFilters(model: model, projects: projects, focus: $focus)
                        .frame(height: DesktopSearchPanelMetrics.filtersHeight)
                    hairline
                }
                if !model.notices.isEmpty {
                    notices
                    hairline
                }
                list
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .frame(height: height, alignment: .top)
        .junoContainerShape(cornerRadius: DesktopSearchPanelMetrics.cornerRadius)
        .modifier(DesktopSearchPanelSurface())
        .onAppear { focus = .field }
        .onChange(of: model.presentationID) { _, _ in focus = .field }
        .onChange(of: statusText) { _, status in announce(status) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel(isCommands ? "Command menu" : "Search everything")
        .accessibilityIdentifier("juno.desktop.search-panel")
    }

    // MARK: Field

    private func field(scroller: ScrollViewProxy) -> some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(.search, size: 18)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)
            TextField(
                isCommands ? "Search or start a chat" : "Search",
                text: Binding(get: { model.query }, set: { model.setQuery($0) })
            )
            .textFieldStyle(.plain)
            .junoType(.bodyLarge)
            .foregroundStyle(Color.junoForeground)
            .focused($focus, equals: .field)
            .onSubmit { runActive() }
            .onKeyPress(.downArrow) { move(1, scroller: scroller) }
            .onKeyPress(.upArrow) { move(-1, scroller: scroller) }
            .onKeyPress(.escape) {
                model.dismiss()
                return .handled
            }
            .onKeyPress(.tab) {
                guard model.showsFilters else { return .ignored }
                focus = .filters
                return .handled
            }
            .onKeyPress(keys: ["k", "K", "f", "F"], phases: .down) { press in
                // The panel's own chords, for when no menu item claims them:
                // ⌘K closes, ⇧⌘F switches Commands to Search.
                guard press.modifiers.contains(.command) else { return .ignored }
                let key = String(press.key.character).lowercased()
                if key == "k", !press.modifiers.contains(.shift) {
                    model.dismiss()
                    return .handled
                }
                if key == "f", press.modifiers.contains(.shift) {
                    model.present(.search)
                    return .handled
                }
                return .ignored
            }
            .accessibilityLabel(isCommands ? "Command menu" : "Search everything")
            .accessibilityIdentifier("juno.desktop.search-panel.field")
            trailingControl
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.cozy)
        .frame(height: DesktopSearchPanelMetrics.fieldHeight)
        .overlay(alignment: .bottom) { hairline }
    }

    /// "esc" at rest; once there is text, the ✕ that clears it, faded in.
    @ViewBuilder
    private var trailingControl: some View {
        ZStack {
            DesktopPanelKeycap("esc")
                .opacity(model.query.isEmpty ? 1 : 0)
                .accessibilityHidden(true)
            Button {
                model.setQuery("")
                focus = .field
            } label: {
                JunoIconView(.close, size: 14)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 28, height: 28)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .contentShape(.circle)
            .opacity(model.query.isEmpty ? 0 : 1)
            .allowsHitTesting(!model.query.isEmpty)
            .help("Clear")
            .accessibilityLabel("Clear search")
            .accessibilityHidden(model.query.isEmpty)
        }
        .animation(JunoMotion.fast, value: model.query.isEmpty)
    }

    // MARK: Notices

    private var notices: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.notices, id: \.self) { line in
                noticeText(line)
                    .junoType(.caption)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(height: DesktopSearchPanelMetrics.noticeLine, alignment: .leading)
            }
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        // A plain band: a bare colour would take the panel's container
        // shape and round its corners.
        .background { Rectangle().fill(Color.junoGlassFill) }
        .accessibilityElement(children: .combine)
    }

    /// "Memory: not searched while offline." with the source in the row's ink
    /// and the rest muted.
    private func noticeText(_ line: String) -> Text {
        var text = AttributedString(line)
        text.foregroundColor = Color.junoSecondaryInk
        if let colon = line.firstIndex(of: ":") {
            let head = String(line[...colon])
            if let range = text.range(of: head) {
                text[range].foregroundColor = Color.junoForeground
            }
        }
        return Text(text)
    }

    private var hairline: some View {
        Rectangle()
            .fill(Color.junoBorder.opacity(contrast == .increased ? 1 : 0.6))
            .frame(height: 1)
    }

    // MARK: List

    @ViewBuilder
    private var list: some View {
        if let state = emptyState {
            state
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index == 0 || rows[index - 1].group != row.group {
                            DesktopSearchPanelHeader(title: row.group, isFirst: index == 0, index: index)
                        }
                        DesktopSearchPanelRowView(
                            row: row,
                            isActive: index == activeIndex,
                            index: index,
                            hover: { model.hover(row) },
                            run: { run(row) }
                        )
                        .id(row.id)
                    }
                }
                .padding(DesktopSearchPanelMetrics.listInset)
            }
            .scrollIndicators(.automatic)
            .accessibilityIdentifier("juno.desktop.search-panel.list")
        }
    }

    private var activeIndex: Int { model.activeIndex(in: rows) }

    /// Nil while there are rows to show.
    private var emptyState: AnyView? {
        guard rows.isEmpty else { return nil }
        switch model.mode {
        case .commands:
            guard !model.trimmedQuery.isEmpty else { return nil }
            return AnyView(
                DesktopSearchPanelEmpty(
                    icon: .search,
                    title: "No matches for “\(model.query)”.",
                    hint: "Try a chat title, or a command like “settings”."
                )
            )
        case .search:
            if model.trimmedQuery.isEmpty {
                if model.recentsLoading && model.recents == nil {
                    return AnyView(DesktopSearchPanelSkeleton())
                }
                return AnyView(
                    DesktopSearchPanelEmpty(
                        icon: .search,
                        title: "Search everything in Juno",
                        hint: "Chats and their messages, projects, files, artifacts, memories and tasks."
                    )
                )
            }
            if model.searchFailed {
                return AnyView(
                    DesktopSearchPanelEmpty(
                        icon: .error,
                        title: "Search is unavailable right now.",
                        hint: "Check your connection and try the search again.",
                        isError: true
                    )
                )
            }
            if model.isSearching {
                return AnyView(DesktopSearchPanelSkeleton())
            }
            return AnyView(
                DesktopSearchPanelEmpty(
                    icon: .search,
                    title: "Nothing matches “\(model.query)”.",
                    hint: "Try fewer words, or widen the filters above."
                )
            )
        }
    }

    // MARK: Keys

    private func move(_ delta: Int, scroller: ScrollViewProxy) -> KeyPress.Result {
        guard !rows.isEmpty else { return .handled }
        model.moveCursor(by: delta, in: rows)
        let index = model.activeIndex(in: rows)
        if index == 0, let first = rows.first {
            scroller.scrollTo(first.id, anchor: .bottom)
        } else {
            scroller.scrollTo(rows[index].id)
        }
        return .handled
    }

    private func runActive() {
        guard rows.indices.contains(activeIndex) else { return }
        run(rows[activeIndex])
    }

    // MARK: Announcements

    private var statusText: String {
        model.status(rowCount: rows.count)
    }

    /// Once per settled set, in the web's words.
    private func announce(_ status: String) {
        guard !status.isEmpty, status != "Searching", status != announced else { return }
        announced = status
        AccessibilityNotification.Announcement(status).post()
    }
}

// MARK: - Surface

/// The panel's glass (one of the allow-listed sites, §0.1), or its Reduce
/// Transparency recipe: the popover fill under a hairline and the float
/// throw. Under Increase Contrast the edge strengthens.
private struct DesktopSearchPanelSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: DesktopSearchPanelMetrics.cornerRadius, style: .continuous)
    }

    func body(content: Content) -> some View {
        if reduceTransparency || snapshotOpaqueGlass {
            content
                .clipShape(shape)
                .background {
                    shape
                        .fill(Color.junoPopover)
                        .shadow(color: Color.junoCardShadow, radius: JunoSpace.regular, y: JunoSpace.tight)
                }
                .overlay {
                    shape.strokeBorder(
                        Color.junoBorder.opacity(contrast == .increased ? 1 : 0.9),
                        lineWidth: 1
                    )
                }
        } else {
            GlassEffectContainer {
                content
                    .clipShape(shape)
                    .glassEffect(.regular, in: shape)
            }
            .overlay {
                if contrast == .increased {
                    shape.strokeBorder(Color.junoBorder, lineWidth: 1)
                }
            }
        }
    }
}

// MARK: - Filters

/// The filter row, shown only in Search with a query (decision 8): the nine
/// type chips in one scrolling row, then the date and project menus.
private struct DesktopSearchPanelFilters: View {
    @Bindable var model: DesktopSearchPanelModel
    let projects: [NativeProject]
    var focus: FocusState<DesktopSearchPanel.Focus?>.Binding

    private var types: [NativeUnifiedSearchType?] {
        [nil] + NativeUnifiedSearchType.allCases.map { $0 }
    }

    private var isFocused: Bool { focus.wrappedValue == .filters }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.tight) {
                    ForEach(types, id: \.self) { type in
                        DesktopSearchFilterChip(
                            title: type?.label ?? "Everything",
                            isSelected: model.typeFilter == type,
                            showsFocus: isFocused && model.typeFilter == type
                        ) {
                            model.setTypeFilter(type)
                            // A click leaves the caret in the field, so typing
                            // goes on refining the query; Tab reaches the row.
                            focus.wrappedValue = .field
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Filter by type")
                divider
                windowMenu
                if !projects.isEmpty {
                    divider
                    projectMenu
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(height: DesktopSearchPanelMetrics.filtersHeight)
        }
        .scrollIndicators(.automatic)
        .focusable(interactions: .edit)
        .focusEffectDisabled()
        .focused(focus, equals: .filters)
        .onKeyPress(.leftArrow) { step(-1) }
        .onKeyPress(.rightArrow) { step(1) }
        .onKeyPress(.tab) {
            focus.wrappedValue = .field
            return .handled
        }
        .onKeyPress(.escape) {
            model.dismiss()
            return .handled
        }
    }

    /// ← and → walk the type chips while the row has focus.
    private func step(_ delta: Int) -> KeyPress.Result {
        let current = types.firstIndex(of: model.typeFilter) ?? 0
        let next = min(max(current + delta, 0), types.count - 1)
        model.setTypeFilter(types[next])
        return .handled
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.junoBorder)
            .frame(width: 1, height: 16)
            .padding(.horizontal, JunoSpace.tight)
            .accessibilityHidden(true)
    }

    /// "Any time ▾": the web's words on the trigger, Title Case in the menu.
    private var windowMenu: some View {
        Menu {
            Picker(
                "Date",
                selection: Binding(get: { model.window }, set: { model.setWindow($0) })
            ) {
                ForEach(NativeSearchWindow.allCases, id: \.self) { window in
                    Text(Self.menuTitle(window)).tag(window)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            DesktopSearchFilterTrigger(title: model.window.label)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .contentShape(Capsule())
        .help("Filter by date")
        .accessibilityLabel("Filter by date")
    }

    private var projectMenu: some View {
        Menu {
            Picker(
                "Project",
                selection: Binding(get: { model.projectFilter ?? "" }, set: { model.setProjectFilter($0.isEmpty ? nil : $0) })
            ) {
                Text("All Projects").tag("")
                ForEach(projects, id: \.id) { project in
                    Text(project.name.isEmpty ? "Untitled Project" : project.name).tag(project.id)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            DesktopSearchFilterTrigger(title: projectTitle)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .contentShape(Capsule())
        .help("Filter by project")
        .accessibilityLabel("Filter by project")
    }

    private var projectTitle: String {
        guard let id = model.projectFilter, let project = projects.first(where: { $0.id == id }) else {
            return "All projects"
        }
        return project.name.isEmpty ? "Untitled project" : project.name
    }

    static func menuTitle(_ window: NativeSearchWindow) -> String {
        switch window {
        case .any: "Any Time"
        case .week: "Past Week"
        case .month: "Past Month"
        case .year: "Past Year"
        }
    }
}

/// One type chip: a 28pt capsule at 12pt medium. Selected, the glass fill,
/// the primary ink and a hairline; at rest, the secondary ink and no fill.
private struct DesktopSearchFilterChip: View {
    let title: String
    let isSelected: Bool
    let showsFocus: Bool
    let action: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Text(title)
                .junoType(.label)
                .foregroundStyle(isSelected || isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, JunoSpace.close)
                .frame(height: 28)
                .background(Capsule().fill(isSelected ? Color.junoGlassFill : Color.clear))
                .overlay {
                    Capsule().strokeBorder(
                        showsFocus ? Color.junoRing : Color.junoBorder,
                        lineWidth: showsFocus ? 2 : 1
                    )
                    .opacity(isSelected ? 1 : 0)
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .contentShape(Capsule())
        .onHover { isHovering = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// A menu's trigger in the filter row: its words and a small caret, at the
/// chips' height.
private struct DesktopSearchFilterTrigger: View {
    let title: String

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Text(title)
                .junoType(.label)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 160, alignment: .leading)
            JunoIconView(.chevronDown, size: 10)
                .accessibilityHidden(true)
        }
        .foregroundStyle(Color.junoSecondaryInk)
        .padding(.horizontal, JunoSpace.close)
        .frame(height: 28)
        .fixedSize()
        .contentShape(Capsule())
    }
}

// MARK: - Rows

/// A group's heading: the sidebar's section voice — sentence case, 13pt
/// medium, muted — 4pt above the first group and 24 above later ones.
private struct DesktopSearchPanelHeader: View {
    let title: String
    let isFirst: Bool
    let index: Int

    var body: some View {
        Text(title)
            .junoFont(size: 13, relativeTo: .callout, weight: .medium)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(height: DesktopSearchPanelMetrics.headerLine, alignment: .leading)
            .padding(.top, isFirst ? 4 : 24)
            .padding(.bottom, 4)
            .padding(.horizontal, JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(DesktopPanelArrival(index: index))
            .accessibilityAddTraits(.isHeader)
    }
}

/// One result or command: a plain 18pt glyph in a 20pt slot, the title at
/// 15pt with its matched words in semibold, a 13pt snippet under it when
/// there is one, trailing meta at 11pt and keycaps.
private struct DesktopSearchPanelRowView: View {
    let row: DesktopPanelRow
    let isActive: Bool
    let index: Int
    let hover: () -> Void
    let run: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: row.hasSnippet ? .top : .center, spacing: JunoSpace.close) {
            JunoIconView(row.icon, size: 18)
                .foregroundStyle(isActive ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 20, height: 20)
                .padding(.top, row.hasSnippet ? 1 : 0)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                DesktopMarkedText(text: row.label, marks: row.labelMarks)
                    .junoType(.body)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if row.hasSnippet, let snippet = row.snippet {
                    DesktopMarkedText(text: snippet.text, marks: snippet.marks)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let meta = row.meta, !meta.isEmpty {
                Text(meta)
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.top, row.hasSnippet ? 3 : 0)
            }
            if !row.hint.isEmpty {
                HStack(spacing: JunoSpace.tight) {
                    ForEach(Array(row.hint.enumerated()), id: \.offset) { _, key in
                        DesktopPanelKeycap(key)
                    }
                }
                .accessibilityHidden(true)
            }
            if row.isExternal {
                JunoIconView(.external, size: 12)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, row.hasSnippet ? JunoSpace.snug : 0)
        .frame(height: row.hasSnippet ? DesktopSearchPanelMetrics.snippetRowHeight : DesktopSearchPanelMetrics.rowHeight)
        .background {
            JunoRadius.concentric(minimum: JunoRadius.field)
                .fill(Color.junoGlassHover)
                .opacity(isActive ? 1 : 0)
        }
        .contentShape(JunoRadius.concentric(minimum: JunoRadius.field))
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isActive)
        .onContinuousHover { phase in
            if case .active = phase { hover() }
        }
        .onTapGesture(perform: run)
        .modifier(DesktopPanelArrival(index: index))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { run() }
    }

    private var accessibilityLabel: String {
        var parts = [row.label]
        if row.hasSnippet, let snippet = row.snippet { parts.append(snippet.text) }
        if let meta = row.meta, !meta.isEmpty { parts.append(meta) }
        return parts.joined(separator: ", ")
    }
}

/// Rows and headers arrive with a fade — the first eight 20ms apart, the
/// rest with the eighth. A row that survives a keystroke keeps its identity
/// and does not replay. Opacity only, so nothing moves under a pointer on
/// its way to a row; no stagger under Reduce Motion.
private struct DesktopPanelArrival: ViewModifier {
    let index: Int
    @State private var arrived = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(arrived ? 1 : 0)
            .onAppear {
                let delay = reduceMotion ? 0 : Double(min(index, 8)) * 0.02
                withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)?.delay(delay)) {
                    arrived = true
                }
            }
    }
}

/// Text with its matched spans in semibold, in the text's own ink — the find
/// bar's neutral emphasis rather than the web's coral wash (P3-10).
struct DesktopMarkedText: View {
    let text: String
    let marks: [NativeSearchMark]

    var body: some View {
        Self.text(text, marks: marks)
    }

    /// The text with each marked span at the semibold weight of whatever
    /// font the view sets — not the bold a strong-emphasis run would draw.
    static func text(_ text: String, marks: [NativeSearchMark]) -> Text {
        let ranges = NativeSearchMark.ranges(marks, in: text)
        guard !ranges.isEmpty else { return Text(verbatim: text) }
        var result = Text(verbatim: "")
        var cursor = text.startIndex
        for range in ranges {
            if cursor < range.lowerBound {
                let plain = Text(verbatim: String(text[cursor..<range.lowerBound]))
                result = Text("\(result)\(plain)")
            }
            let marked = Text(verbatim: String(text[range])).fontWeight(.semibold)
            result = Text("\(result)\(marked)")
            cursor = range.upperBound
        }
        if cursor < text.endIndex {
            let rest = Text(verbatim: String(text[cursor...]))
            result = Text("\(result)\(rest)")
        }
        return result
    }
}

/// One key, one cap: the micro rung in the secondary ink, never tertiary.
struct DesktopPanelKeycap: View {
    let key: String

    init(_ key: String) {
        self.key = key
    }

    var body: some View {
        Text(key)
            .junoType(.micro)
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.tight)
            .frame(minWidth: 20, minHeight: 20)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.junoGlassFill)
            )
    }
}

// MARK: - States

/// What the list says when it has no rows (the web's `PaletteEmpty`): one
/// muted glyph on a quiet tile, one sentence, and a second line saying what
/// to do. Inside glass, so the tile is the glass fill, not an opaque plate.
private struct DesktopSearchPanelEmpty: View {
    let icon: JunoIcon
    let title: String
    let hint: String
    var isError = false

    var body: some View {
        VStack(spacing: 0) {
            JunoIconView(icon, size: 20)
                .foregroundStyle(isError ? Color.junoDestructiveInk : Color.junoSecondaryInk)
                .frame(width: 40, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .fill(isError ? Color.junoDestructive.opacity(0.1) : Color.junoGlassFill)
                )
                .accessibilityHidden(true)
            Text(title)
                .junoType(.bodyLarge)
                .foregroundStyle(Color.junoForeground)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.top, JunoSpace.regular)
            Text(hint)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.top, JunoSpace.tight)
        }
        .padding(.horizontal, JunoSpace.section)
        .padding(.top, JunoSpace.region)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isError ? [] : .isStaticText)
    }
}

/// Five placeholder rows at the result row's own geometry, breathing on the
/// skeleton loop — still under Reduce Motion — so a search in flight holds
/// the list's shape rather than its words.
private struct DesktopSearchPanelSkeleton: View {
    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 3) {
            ForEach(0..<5, id: \.self) { _ in
                JunoRadius.concentric(minimum: JunoRadius.field)
                    .fill(Color.junoGlassFill)
                    .frame(height: DesktopSearchPanelMetrics.rowHeight)
            }
        }
        .padding(DesktopSearchPanelMetrics.listInset)
        .opacity(dimmed ? 0.62 : 1)
        .animation(
            JunoMotion.ambient(JunoMotion.breathe(period: JunoMotion.Loop.skeletonBreathe), when: reduceMotion),
            value: dimmed
        )
        .onAppear { if !reduceMotion { dimmed = true } }
        .accessibilityElement()
        .accessibilityLabel("Searching")
    }
}
