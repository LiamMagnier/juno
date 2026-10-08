import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The web sidebar's numbers (`app-sidebar.tsx`, the V3 shell), in points, for
/// both products' columns on the Mac.
///
/// Rows are 32 tall and abut. Every glyph starts 16pt from the panel's edge
/// in a 20pt slot, and every label 46pt (the slot plus a 10pt gap); rows with
/// no glyph — a chat's title, a section heading — put their text on the 16pt
/// edge. Fills sit 8pt in from the panel, radius 8: hover one rung off the
/// panel, selection one rung past it, neither with an edge.
enum DesktopSidebarMetrics {
    static let minimumWidth: CGFloat = 220
    static let idealWidth: CGFloat = 260
    static let maximumWidth: CGFloat = 360

    static let rowHeight: CGFloat = 32
    static let headingHeight: CGFloat = 28
    /// The space above a section heading, between one group and the next.
    static let headingGap: CGFloat = 8
    static let glyphSlot: CGFloat = 20
    static let glyphSize: CGFloat = 16
    static let gap: CGFloat = 10
    static let radius: CGFloat = 8
    /// The fill's distance from the panel's edge.
    static let fillInset: CGFloat = 8
    /// Where every glyph, and every glyph-less text, starts.
    static let glyphEdge: CGFloat = 16
    /// Where every label after a glyph starts: 16 + 20 + 10.
    static var labelEdge: CGFloat { glyphEdge + glyphSlot + gap }
    /// Where a row's own content starts inside the panel once the list's row
    /// insets are zeroed: the source list keeps this much margin of its own,
    /// measured in the window capture (Tahoe's sidebar, standard metrics).
    static let listOrigin: CGFloat = 16

    static let labelSize: CGFloat = 14
    static let headingSize: CGFloat = 12
    static let accountHeight: CGFloat = 48
}

/// The glyph gesture a destination makes under the pointer (the web's
/// `sidebar-motion-icon.tsx`): the folder opens, the search glass tilts, the
/// gear turns. At most one per row; none under Reduce Motion.
enum DesktopSidebarGesture {
    case none
    case folderOpens
    case tilts
    case turns
}

extension View {
    /// A sidebar row's fills and frame: zeroed list insets, the 32pt (or
    /// heading) height, and the hover and selected fills 8pt in from the
    /// panel, cross-faded on the fast rung.
    func desktopSidebarRow(selected: Bool, hovered: Bool, height: CGFloat = DesktopSidebarMetrics.rowHeight) -> some View {
        modifier(DesktopSidebarRowFrame(selected: selected, hovered: hovered, height: height))
    }
}

private struct DesktopSidebarRowFrame: ViewModifier {
    let selected: Bool
    let hovered: Bool
    let height: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .leading)
            .contentShape(.rect)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(
                RoundedRectangle(cornerRadius: DesktopSidebarMetrics.radius, style: .continuous)
                    .fill(selected ? Color.junoSelectedFill : (hovered ? Color.junoSidebarHover : Color.clear))
                    // The row's background spans the panel's full width (its
                    // content does not), so the fill's 8pt is measured from
                    // the panel's edge.
                    .padding(.horizontal, DesktopSidebarMetrics.fillInset)
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: selected)
            )
    }
}

/// A destination or action row: a 16pt web glyph in its 20pt slot on the
/// 16pt edge, the 14pt label on the 46pt edge, an optional trailing view.
/// Muted at rest; the glyph and label lift to the foreground under the
/// pointer and on the selected row.
struct DesktopSidebarNavRow<Trailing: View>: View {
    let icon: JunoIcon
    let title: String
    var selected = false
    var gesture: DesktopSidebarGesture = .none
    /// A row that acts (New chat, Search) rather than being selected: the
    /// row itself is the button, so the list's row metrics land on it.
    var action: (() -> Void)? = nil
    @ViewBuilder var trailing: () -> Trailing

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var lit: Bool { selected || hovered }

    var body: some View {
        Group {
            if let action {
                Button(action: action) { face.contentShape(.rect) }
                    .buttonStyle(.plain)
                    .contentShape(.rect)
            } else {
                face
            }
        }
        .onHover { hovered = $0 }
        .desktopSidebarRow(selected: selected, hovered: hovered)
    }

    private var face: some View {
        HStack(spacing: DesktopSidebarMetrics.gap) {
            glyph
                .frame(width: DesktopSidebarMetrics.glyphSlot, height: DesktopSidebarMetrics.glyphSlot)
            Text(title)
                .junoFont(size: DesktopSidebarMetrics.labelSize, relativeTo: .body)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            trailing()
        }
        .foregroundStyle(lit ? Color.junoForeground : Color.junoSidebarInk)
        .padding(.leading, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .padding(.trailing, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
        .frame(maxWidth: .infinity, minHeight: DesktopSidebarMetrics.rowHeight, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var glyph: some View {
        let moving = hovered && !reduceMotion
        switch gesture {
        case .folderOpens:
            JunoIconView(moving ? .folderOpen : icon, size: DesktopSidebarMetrics.glyphSize)
                .contentTransition(.opacity)
                .animation(JunoMotion.fast, value: moving)
        case .tilts:
            JunoIconView(icon, size: DesktopSidebarMetrics.glyphSize)
                .rotationEffect(.degrees(moving ? -12 : 0))
                .animation(JunoMotion.fast, value: moving)
        case .turns:
            JunoIconView(icon, size: DesktopSidebarMetrics.glyphSize)
                .rotationEffect(.degrees(moving ? 45 : 0))
                .animation(JunoMotion.fast, value: moving)
        case .none:
            JunoIconView(icon, size: DesktopSidebarMetrics.glyphSize)
        }
    }
}

extension DesktopSidebarNavRow where Trailing == EmptyView {
    init(
        icon: JunoIcon,
        title: String,
        selected: Bool = false,
        gesture: DesktopSidebarGesture = .none,
        action: (() -> Void)? = nil
    ) {
        self.init(icon: icon, title: title, selected: selected, gesture: gesture, action: action) { EmptyView() }
    }
}

/// A section heading as a row of the list: 28pt, the 12pt medium label in the
/// muted ink on the 16pt edge, sentence case. No fill under the pointer — the
/// words brighten instead. Pressing it folds the section when it folds.
struct DesktopSidebarHeadingRow<Trailing: View>: View {
    let title: String
    /// A heading that names a place wears its glyph (Orbit), and its words
    /// move to the label edge.
    var icon: JunoIcon? = nil
    var isFirst = false
    var action: (() -> Void)? = nil
    @ViewBuilder var trailing: () -> Trailing

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: DesktopSidebarMetrics.gap) {
            if let icon {
                JunoIconView(icon, size: DesktopSidebarMetrics.glyphSize)
                    .foregroundStyle(hovered && action != nil ? Color.junoForeground : Color.junoSecondaryInk)
                    .frame(width: DesktopSidebarMetrics.glyphSlot, height: DesktopSidebarMetrics.glyphSlot)
            }
            // The web's label rung for headings: mono, as `/dev/shell` sets it.
            Text(title)
                .junoFont(size: DesktopSidebarMetrics.headingSize, relativeTo: .caption, weight: .medium, design: .monospaced)
                .foregroundStyle(hovered && action != nil ? Color.junoForeground : Color.junoSecondaryInk)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.leading, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .padding(.trailing, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .frame(height: DesktopSidebarMetrics.headingHeight)
        .padding(.top, isFirst ? 0 : DesktopSidebarMetrics.headingGap)
        .frame(maxWidth: .infinity, alignment: .bottomLeading)
        .contentShape(.rect)
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        .onTapGesture { action?() }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .selectionDisabled()
    }
}

extension DesktopSidebarHeadingRow where Trailing == EmptyView {
    init(_ title: String, icon: JunoIcon? = nil, isFirst: Bool = false, action: (() -> Void)? = nil) {
        self.init(title: title, icon: icon, isFirst: isFirst, action: action) { EmptyView() }
    }
}

/// A heading's one action at its end (New agent, New project): a 12pt web
/// glyph in a 28pt target, muted, lifting under the pointer.
struct DesktopSidebarHeadingAction: View {
    let icon: JunoIcon
    let help: String
    let action: () -> Void

    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: 12)
                .foregroundStyle(hovered ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

/// An Orbit row: the agent's face in the glyph slot, the name on the label
/// edge. An agent waiting on the reader is set at medium weight — never a
/// coloured dot (owner directive 2026-09-26).
struct DesktopSidebarAgentRow: View {
    let agent: NativeAgent
    let selected: Bool

    @State private var hovered = false

    var body: some View {
        HStack(spacing: DesktopSidebarMetrics.gap) {
            JunoAgentFace(avatar: agent.avatar, state: agent.state, size: JunoAgentFaceSize.xs)
                .frame(width: DesktopSidebarMetrics.glyphSlot, height: DesktopSidebarMetrics.glyphSlot)
            Text(agent.name)
                .junoFont(
                    size: DesktopSidebarMetrics.labelSize,
                    relativeTo: .body,
                    weight: agent.state == .waiting ? .medium : .regular
                )
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .foregroundStyle(selected || hovered ? Color.junoForeground : Color.junoSidebarInk)
        .padding(.leading, DesktopSidebarMetrics.glyphEdge - DesktopSidebarMetrics.listOrigin)
        .onHover { hovered = $0 }
        .desktopSidebarRow(selected: selected, hovered: hovered)
    }
}

// MARK: - The content panel

/// The chat or Code column as the web draws it beside the sidebar: a rounded
/// panel of the reading canvas, inset from the window's edges, on the
/// sidebar's ground — with a soft shadow in light and a hairline in dark,
/// where a shadow cannot separate two dark surfaces.
///
/// Everything inside stays native: the transcript still scrolls under the
/// unified toolbar (the panel's top is under the toolbar too), the sidebar
/// collapse still animates the split view, and the panel simply follows the
/// detail column's frame.
struct DesktopContentPanel: ViewModifier {
    static let inset: CGFloat = 8
    static let radius: CGFloat = 14

    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        content
            .background(Color.junoCanvas)
            .clipShape(shape)
            .overlay {
                if colorScheme == .dark {
                    shape.strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
                }
            }
            .background {
                shape
                    .fill(Color.junoCanvas)
                    .shadow(color: .black.opacity(colorScheme == .dark ? 0.35 : 0.09), radius: 18, y: 2)
            }
            .padding(.top, Self.inset)
            .padding(.trailing, Self.inset)
            .padding(.bottom, Self.inset)
    }
}

extension View {
    /// The web's content panel around a detail column (``DesktopContentPanel``).
    func desktopContentPanel() -> some View {
        modifier(DesktopContentPanel())
    }
}
