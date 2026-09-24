import SwiftUI

#if os(macOS)

// MARK: - The page frame

/// How wide a page's content column may grow (web `AppPage`'s `measure`).
public enum JunoPageMeasure: Sendable {
    /// 768 — prose and settings.
    case reading
    /// 1024 — lists, grids, dashboards.
    case wide
    /// No cap — editors and canvases that own the column.
    case full

    public var maxWidth: CGFloat? {
        switch self {
        case .reading: JunoReadingMeasure.reading
        case .wide: JunoReadingMeasure.wide
        case .full: nil
        }
    }
}

/// Where a page scrolls.
public enum JunoPageScrolling: Sendable {
    /// The whole page — header, controls and content — scrolls as one, as the
    /// web's `.app-page-scroll` does.
    case page
    /// The header and controls stay put and the content fills the rest and
    /// scrolls itself: a `List`, a `Table`, a grid with its own scroller.
    case content
}

/// The page's column, handed to everything inside so content that scrolls on
/// its own can line up with the header above it (``SwiftUI/View/junoPageColumn()``).
public struct JunoPageLayout: Equatable, Sendable {
    public var measure: CGFloat?
    /// 16 below a 640pt column, 24 from 640, 32 from 1024 (the web's
    /// `--page-gutter`, stepped on the page's own width).
    public var gutter: CGFloat
    /// The width of the content column inside the gutters, for the fluid
    /// page title.
    public var columnWidth: CGFloat

    public init(measure: CGFloat?, gutter: CGFloat, columnWidth: CGFloat) {
        self.measure = measure
        self.gutter = gutter
        self.columnWidth = columnWidth
    }

    public static func gutter(forPageWidth width: CGFloat) -> CGFloat {
        if width >= 1024 { return JunoSpace.region }
        if width >= 640 { return JunoSpace.section }
        return JunoSpace.regular
    }
}

public extension EnvironmentValues {
    /// The enclosing ``JunoPage``'s column. Nil outside a page.
    @Entry var junoPageLayout: JunoPageLayout? = nil
}

public extension View {
    /// Sets this view in the enclosing page's column: its measure, centred,
    /// inside its gutters. For content a ``JunoPage`` with
    /// ``JunoPageScrolling/content`` hands its own scroller.
    func junoPageColumn() -> some View {
        modifier(JunoPageColumnModifier())
    }
}

private struct JunoPageColumnModifier: ViewModifier {
    @Environment(\.junoPageLayout) private var layout

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: layout?.measure.map { max($0 - (layout?.gutter ?? 0) * 2, 0) })
            .padding(.horizontal, layout?.gutter ?? 0)
            .frame(maxWidth: .infinity)
    }
}

/// A secondary page (spec §9): the header in content, a controls row, then
/// the page's own content — all opaque, on the canvas the window paints.
///
/// **Pages declare nothing in the toolbar** (§3). Search fields, filters,
/// view switches and page actions live in the header and the controls row,
/// where the reader can see what they act on; a `ToolbarItem` or a
/// `.searchable` that came and went with a destination rebuilt the AppKit
/// toolbar under a live window, which is crash rule 3.
///
/// **It cannot resize the window.** A detail column reports an ideal size
/// upward and `NavigationSplitView` grows its split view to satisfy it, so the
/// page is drawn as `Color.clear.overlay { … }` — a base with no size of its
/// own and an overlay sized by it (see ``JunoDetailPage``).
public struct JunoPage<Header: View, Controls: View, Content: View>: View {
    private let measure: JunoPageMeasure
    private let scrolling: JunoPageScrolling
    private let header: Header
    private let controls: Controls
    private let content: Content

    @State private var pageWidth: CGFloat = 0

    public init(
        measure: JunoPageMeasure = .wide,
        scrolling: JunoPageScrolling = .page,
        @ViewBuilder header: () -> Header,
        @ViewBuilder controls: () -> Controls,
        @ViewBuilder content: () -> Content
    ) {
        self.measure = measure
        self.scrolling = scrolling
        self.header = header()
        self.controls = controls()
        self.content = content()
    }

    private var layout: JunoPageLayout {
        let gutter = JunoPageLayout.gutter(forPageWidth: pageWidth)
        let column = min(pageWidth, measure.maxWidth ?? .infinity) - gutter * 2
        return JunoPageLayout(measure: measure.maxWidth, gutter: gutter, columnWidth: max(column, 0))
    }

    /// `padding-block: 1.25rem 2.5rem`, and `1.75rem 3rem` from 640.
    private var topInset: CGFloat { pageWidth >= 640 ? JunoSpace.wide : JunoSpace.roomy }
    private var bottomInset: CGFloat { pageWidth >= 640 ? JunoSpace.vast : JunoSpace.expanse }

    public var body: some View {
        Color.clear
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pageWidth = $0 }
            .overlay {
                switch scrolling {
                case .page:
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            top
                            content
                        }
                        .padding(.top, topInset)
                        .padding(.bottom, bottomInset)
                        .junoPageColumn()
                    }
                    .scrollBounceBehavior(.basedOnSize)
                case .content:
                    VStack(spacing: 0) {
                        top
                            .padding(.top, topInset)
                            .junoPageColumn()
                        content
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    }
                }
            }
            .environment(\.junoPageLayout, layout)
    }

    private var top: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            controls
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

public extension JunoPage where Controls == EmptyView {
    /// A page with no controls row.
    init(
        measure: JunoPageMeasure = .wide,
        scrolling: JunoPageScrolling = .page,
        @ViewBuilder header: () -> Header,
        @ViewBuilder content: () -> Content
    ) {
        self.init(measure: measure, scrolling: scrolling, header: header, controls: { EmptyView() }, content: content)
    }
}

// MARK: - Header

/// The way a page opens (web `AppPageHeader`): its own name, one line of what
/// it is for, the page's actions, and the rule under them.
///
/// - The page's own name in the `pageTitle` rung ("Library", not "Your
///   files"), fluid from 26 to 32 with the column, marked as a header.
/// - The lede in the 15pt `body` rung, secondary ink, at most a prose measure.
/// - Actions trailing: `.bordered`, and at most one prominent button in the
///   Juno accent (``SwiftUI/PrimitiveButtonStyle/junoProminent``). They drop
///   under the title when the row cannot hold both.
/// - Then 20pt, a 1pt `--border` rule, and 24pt before what follows.
public struct JunoPageHeader<Actions: View>: View {
    private let title: String
    private let lede: String?
    private let actions: Actions

    @Environment(\.junoPageLayout) private var layout

    public init(_ title: String, lede: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.title = title
        self.lede = lede
        self.actions = actions()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .bottom, spacing: JunoSpace.section) {
                    titleBlock
                    Spacer(minLength: 0)
                    actionRow
                }
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    titleBlock
                    actionRow
                }
            }
            .padding(.bottom, JunoSpace.roomy)
            Rectangle()
                .fill(Color.junoBorder)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .padding(.bottom, JunoSpace.section)
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoPageTitle(columnWidth: layout?.columnWidth)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            if let lede {
                Text(lede)
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(maxWidth: JunoPageMetrics.ledeMeasure, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var actionRow: some View {
        HStack(spacing: JunoSpace.close) {
            actions
        }
        .fixedSize()
    }
}

public extension JunoPageHeader where Actions == EmptyView {
    init(_ title: String, lede: String? = nil) {
        self.init(title, lede: lede) { EmptyView() }
    }
}

/// The page template's metrics.
public enum JunoPageMetrics {
    /// The web's `max-w-prose` (65ch of the 15pt rung).
    public static let ledeMeasure: CGFloat = 560
    /// Every control in the controls row: the Mac's 32 over the web's 36.
    public static let controlHeight: CGFloat = JunoSegmentedMetrics.trackHeight
    /// The search field's range: `basis-48` up to `max-w-xs`.
    public static let searchMinWidth: CGFloat = 192
    public static let searchMaxWidth: CGFloat = 320
    /// The web's `rounded-field`.
    public static let fieldRadius: CGFloat = JunoRadius.field
    /// Space under the controls row before the content (`mt-5`).
    public static let controlsGap: CGFloat = JunoSpace.roomy
}

// MARK: - Controls row

/// The row under the header: search, a filter, a sort, a view switch — the
/// web's `LibraryToolbar` shape. `leading` holds the search and filter;
/// `trailing` is pushed to the far edge (`ml-auto`). When the row cannot
/// hold both, `trailing` drops to a second line.
public struct JunoPageControls<Leading: View, Trailing: View>: View {
    private let leading: Leading
    private let trailing: Trailing

    public init(@ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        // The web's `flex flex-wrap`: one row when everything fits, the
        // trailing group on a line of its own when it does not, and every
        // control wrapping onto as many lines as the column needs at its
        // narrowest — never wider than the page.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: JunoSpace.snug) {
                leading
                Spacer(minLength: JunoSpace.snug)
                trailing
            }
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.snug) { leading }
                HStack(spacing: JunoSpace.snug) { trailing }
            }
            JunoFlowRow(spacing: JunoSpace.snug).callAsFunction {
                leading
                trailing
            }
        }
        .padding(.bottom, JunoPageMetrics.controlsGap)
    }
}

public extension JunoPageControls where Trailing == EmptyView {
    init(@ViewBuilder leading: () -> Leading) {
        self.init(leading: leading) { EmptyView() }
    }
}

/// Children laid out left to right at their ideal widths, wrapping onto a
/// new line when the next one would not fit — none ever wider than the row.
struct JunoFlowRow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? .infinity
        let lines = arrange(subviews, limit: limit)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.map(\.height).reduce(0, +) + spacing * CGFloat(max(lines.count - 1, 0))
        return CGSize(width: min(width, limit), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(subviews, limit: bounds.width) {
            var x = bounds.minX
            for item in line.items {
                subviews[item.index].place(
                    at: CGPoint(x: x, y: y + line.height / 2),
                    anchor: .leading,
                    proposal: ProposedViewSize(width: item.width, height: nil)
                )
                x += item.width + spacing
            }
            y += line.height + spacing
        }
    }

    private struct Line {
        var items: [(index: Int, width: CGFloat)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, limit: CGFloat) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for index in subviews.indices {
            let ideal = subviews[index].sizeThatFits(.unspecified)
            let width = min(ideal.width, limit)
            let height = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil)).height
            let needed = line.items.isEmpty ? width : line.width + spacing + width
            if !line.items.isEmpty, needed > limit {
                lines.append(line)
                line = Line()
            }
            line.width = line.items.isEmpty ? width : line.width + spacing + width
            line.height = max(line.height, height)
            line.items.append((index, width))
        }
        if !line.items.isEmpty { lines.append(line) }
        return lines
    }
}

/// The page's search field (spec §9, web `Input` with a leading magnifier):
/// a plain field on the canvas under the `--input` hairline, 32pt tall at the
/// field radius. The edge darkens under the pointer and takes the neutral
/// ring colour while focused — never the accent. Esc clears it.
public struct JunoPageSearchField: View {
    @Binding private var text: String
    private let prompt: String
    private let isSearching: Bool
    private let accessibilityIdentifier: String?
    private let focus: FocusState<Bool>.Binding?
    private let submit: (() -> Void)?

    @FocusState private var ownFocus: Bool
    @State private var isHovering = false

    /// - Parameters:
    ///   - focus: the page's own focus for the field, when the page moves
    ///     focus into it (⇧⌘F opening Search); nil keeps it to itself.
    ///   - submit: Return in the field — open the highlighted result.
    public init(
        text: Binding<String>,
        prompt: String,
        isSearching: Bool = false,
        accessibilityIdentifier: String? = nil,
        focus: FocusState<Bool>.Binding? = nil,
        submit: (() -> Void)? = nil
    ) {
        _text = text
        self.prompt = prompt
        self.isSearching = isSearching
        self.accessibilityIdentifier = accessibilityIdentifier
        self.focus = focus
        self.submit = submit
    }

    private var focusBinding: FocusState<Bool>.Binding { focus ?? $ownFocus }

    private var isFocused: Bool { focusBinding.wrappedValue }

    private var edge: Color {
        if isFocused { return Color.junoRing }
        return isHovering ? Color.junoForeground.opacity(0.3) : Color.junoInput
    }

    public var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Group {
                if isSearching {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    JunoIconView(.search, size: JunoSegmentedMetrics.iconSize)
                }
            }
            .frame(width: JunoSegmentedMetrics.iconSize, height: JunoSegmentedMetrics.iconSize)
            .foregroundStyle(Color.junoMutedForeground)
            .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .junoType(.ui)
                .focused(focusBinding)
                .onSubmit { submit?() }
                .onExitCommand { text = "" }
                .accessibilityLabel(prompt)
                .accessibilityIdentifier(accessibilityIdentifier ?? "")
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    JunoIconView(.dismiss, size: JunoSegmentedMetrics.iconSize)
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(width: JunoPageMetrics.controlHeight - JunoSpace.hairline * 2,
                               height: JunoPageMetrics.controlHeight - JunoSpace.hairline * 2)
                }
                .buttonStyle(.junoPress)
                .contentShape(.rect)
                .help("Clear search")
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, text.isEmpty ? JunoSpace.cozy : JunoSpace.hairline)
        .frame(height: JunoPageMetrics.controlHeight)
        // Ideal at the floor, so the row asks for the least it can live with,
        // and growing to the ceiling wherever the row has room (the web's
        // `flex-1 basis-48 max-w-xs`).
        .frame(
            minWidth: JunoPageMetrics.searchMinWidth,
            idealWidth: JunoPageMetrics.searchMinWidth,
            maxWidth: JunoPageMetrics.searchMaxWidth
        )
        .background(
            RoundedRectangle(cornerRadius: JunoPageMetrics.fieldRadius, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoPageMetrics.fieldRadius, style: .continuous)
                .strokeBorder(edge, lineWidth: 1)
        )
        .contentShape(.rect(cornerRadius: JunoPageMetrics.fieldRadius))
        .onTapGesture { focusBinding.wrappedValue = true }
        .onHover { isHovering = $0 }
    }
}

/// One choice in a ``JunoPageMenu``: the web's words on the trigger, Title
/// Case in the native menu (§0.7).
public struct JunoPageMenuOption<Value: Hashable>: Identifiable {
    public let value: Value
    /// The web's copy, as the trigger shows it: "Newest first".
    public let label: String
    /// The menu row's words: "Newest First".
    public let menuTitle: String

    public var id: Value { value }

    public init(_ value: Value, _ label: String, menuTitle: String? = nil) {
        self.value = value
        self.label = label
        self.menuTitle = menuTitle ?? label
    }
}

/// A page's sort (or any single choice) as a 32pt field-shaped trigger
/// over a system menu with an inline picker — the web's `Select`, drawn by
/// the system where it opens (§7.1).
public struct JunoPageMenu<Value: Hashable>: View {
    private let options: [JunoPageMenuOption<Value>]
    @Binding private var selection: Value
    private let accessibilityLabel: String

    @State private var isHovering = false

    public init(options: [JunoPageMenuOption<Value>], selection: Binding<Value>, accessibilityLabel: String) {
        self.options = options
        _selection = selection
        self.accessibilityLabel = accessibilityLabel
    }

    private var current: String {
        options.first { $0.value == selection }?.label ?? ""
    }

    public var body: some View {
        Menu {
            Picker(accessibilityLabel, selection: $selection) {
                ForEach(options) { option in
                    Text(option.menuTitle).tag(option.value)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            HStack(spacing: JunoSpace.snug) {
                Text(current)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .fixedSize()
                JunoIconView(.chevronsUpDown, size: JunoSegmentedMetrics.iconSize)
                    .foregroundStyle(Color.junoMutedForeground)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: JunoPageMetrics.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: JunoPageMetrics.fieldRadius, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.junoCanvas)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoPageMetrics.fieldRadius, style: .continuous)
                    .strokeBorder(Color.junoInput, lineWidth: 1)
            )
            .contentShape(.rect(cornerRadius: JunoPageMetrics.fieldRadius))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .contentShape(.rect(cornerRadius: JunoPageMetrics.fieldRadius))
        .onHover { isHovering = $0 }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(current)
    }
}
#endif
