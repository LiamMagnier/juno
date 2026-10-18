import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// MARK: - Status

/// The four things a session's status means to someone scanning a list.
///
/// The runtime has eleven states and the old surfaces drew nine mappings of
/// them, in three colours for "running" alone. A reader needs to know only
/// whether it is working, whether it is waiting for them, whether it broke, or
/// none of those.
public enum StudioStatus: Equatable, Sendable {
    case idle
    case working
    case needsYou
    case failed

    public init(_ status: SessionStatus, hasPendingApproval: Bool = false) {
        if hasPendingApproval || status == .waitingForApproval {
            self = .needsYou
            return
        }
        switch status {
        case .planning, .running, .waitingForProvider, .stopping, .degraded:
            self = .working
        case .failed:
            self = .failed
        case .idle, .completed, .cancelled, .waitingForApproval:
            self = .idle
        }
    }

    /// The four-state reading of a run from any transport — local, cloud,
    /// another computer.
    public init(_ run: CodeRunStatus) {
        if run.needsApproval {
            self = .needsYou
        } else if run.isActive {
            self = .working
        } else if run.state == .failed || run.state == .hostOffline {
            self = .failed
        } else {
            self = .idle
        }
    }

    public var label: String {
        switch self {
        case .idle: "Idle"
        case .working: "Working"
        case .needsYou: "Needs you"
        case .failed: "Failed"
        }
    }
}

/// A status mark sized for a list row — a mark, never a coloured dot (owner
/// directive, premium pass): a thin turning arc in secondary ink while
/// working, a raised hand in the accent when it needs you, a crossed circle
/// in the danger ink when it failed, nothing when idle.
public struct StudioStatusGlyph: View {
    let status: StudioStatus
    var size: CGFloat = 8

    public init(status: StudioStatus, size: CGFloat = 8) {
        self.status = status
        self.size = size
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public var body: some View {
        Group {
            switch status {
            case .idle:
                Color.clear
                    .frame(width: size, height: size)
            case .working:
                Group {
                    if reduceMotion {
                        Circle().stroke(Studio.Ink.secondary, lineWidth: 1.25)
                    } else {
                        StudioSpinner(color: Studio.Ink.secondary, lineWidth: 1.25)
                    }
                }
                .frame(width: size + 2, height: size + 2)
            case .needsYou:
                JunoIconView(.hand, size: size + 4)
                    .foregroundStyle(Studio.Ink.accent)
            case .failed:
                JunoIconView(.circleX, size: size + 4)
                    .foregroundStyle(Studio.Ink.danger)
            }
        }
        .accessibilityLabel(status.label)
    }
}

/// A thin turning arc. `TimelineView` rather than a repeating animation, so it
/// stops costing anything the moment it leaves the screen.
public struct StudioSpinner: View {
    var color: Color = Studio.Ink.secondary
    var lineWidth: CGFloat = 1.5

    public init(color: Color = Studio.Ink.secondary, lineWidth: CGFloat = 1.5) {
        self.color = color
        self.lineWidth = lineWidth
    }

    public var body: some View {
        TimelineView(.animation) { context in
            let turns = context.date.timeIntervalSinceReferenceDate / 0.9
            Circle()
                .trim(from: 0, to: 0.7)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(turns.truncatingRemainder(dividingBy: 1) * 360))
        }
    }
}

// MARK: - Buttons

/// The one filled action on a surface: Send, Allow, Commit. Solid ink, not
/// colour, the way the best tools in the category do it — colour is kept for
/// state.
public struct StudioPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Studio.Font.labelEmphasis)
            .foregroundStyle(isEnabled ? Studio.Surface.canvas : Studio.Ink.tertiary)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: Studio.Metrics.control)
            .background(
                Capsule().fill(isEnabled ? Studio.Ink.primary : Studio.Surface.muted)
            )
            .opacity(configuration.isPressed ? 0.82 : 1)
            .contentShape(Capsule())
            .animation(JunoMotion.press, value: configuration.isPressed)
    }
}

/// A secondary action beside a primary one: an outlined pill.
public struct StudioSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Studio.Font.label)
            .foregroundStyle(isEnabled ? Studio.Ink.primary : Studio.Ink.tertiary)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: Studio.Metrics.control)
            .background(
                Capsule().fill(
                    configuration.isPressed
                        ? Studio.Surface.selected
                        : (hovering ? Studio.Surface.hover : Color.clear)
                )
            )
            .overlay(Capsule().strokeBorder(Studio.Surface.hairline))
            .contentShape(Capsule())
            .onHover { hovering = $0 }
            .animation(JunoMotion.fast, value: hovering)
    }
}

/// Text-only actions and row-level controls: no chrome until hovered.
public struct StudioQuietButtonStyle: ButtonStyle {
    var tint: Color = Studio.Ink.secondary
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    public init(tint: Color = Studio.Ink.secondary) {
        self.tint = tint
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Studio.Font.label)
            .foregroundStyle(isEnabled ? (hovering ? Studio.Ink.primary : tint) : Studio.Ink.tertiary)
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 24)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                    .fill(
                        configuration.isPressed
                            ? Studio.Surface.selected
                            : (hovering ? Studio.Surface.hover : Color.clear)
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
            .onHover { hovering = $0 }
            .animation(JunoMotion.fast, value: hovering)
    }
}

/// A square icon button for toolbars and control rows.
public struct StudioIconButtonStyle: ButtonStyle {
    var isOn = false
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    public init(isOn: Bool = false) {
        self.isOn = isOn
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(
                isEnabled
                    ? (isOn || hovering ? Studio.Ink.primary : Studio.Ink.secondary)
                    : Studio.Ink.tertiary
            )
            .frame(width: Studio.Metrics.control, height: Studio.Metrics.control)
            .background(
                RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                    .fill(
                        configuration.isPressed || isOn
                            ? Studio.Surface.selected
                            : (hovering ? Studio.Surface.hover : Color.clear)
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous))
            .onHover { hovering = $0 }
            .animation(JunoMotion.fast, value: hovering)
    }
}

// MARK: - Chips

/// A control-row chip that opens a menu: an optional mark, a label, and a
/// small chevron. Used for the mode, the model and the environment.
public struct StudioChipLabel: View {
    let title: String
    var icon: JunoIcon?
    var emphasis: Color?
    var showsChevron = true

    public init(title: String, icon: JunoIcon? = nil, emphasis: Color? = nil, showsChevron: Bool = true) {
        self.title = title
        self.icon = icon
        self.emphasis = emphasis
        self.showsChevron = showsChevron
    }

    public var body: some View {
        HStack(spacing: JunoSpace.hairline + 1) {
            if let icon {
                JunoIconView(icon, size: 13)
                    .foregroundStyle(emphasis ?? Studio.Ink.secondary)
            }
            Text(title)
                .font(Studio.Font.label)
                .foregroundStyle(emphasis ?? Studio.Ink.secondary)
                .lineLimit(1)
            if showsChevron {
                JunoIconView(.chevronDown, size: 10)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
        }
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: Studio.Metrics.control)
        .contentShape(Rectangle())
    }
}

/// `+12 −3`, green and red, in tabular digits.
public struct StudioDiffStat: View {
    let added: Int
    let removed: Int
    var font: Font = Studio.Font.metaDigits

    public init(added: Int, removed: Int, font: Font = Studio.Font.metaDigits) {
        self.added = added
        self.removed = removed
        self.font = font
    }

    public var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            Text("+\(added)").foregroundStyle(Studio.Ink.added)
            Text("−\(removed)").foregroundStyle(Studio.Ink.removed)
        }
        .font(font)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(added) lines added, \(removed) removed")
    }
}

/// Five cells that say a diff's shape at a glance: green for the added share,
/// red for the removed, the rest empty — the review bar every code host
/// draws beside a change. Tiny changes still light one cell of each side
/// they touch, so "+1 −0" never looks like nothing happened.
public struct StudioDiffBar: View {
    let added: Int
    let removed: Int

    public init(added: Int, removed: Int) {
        self.added = added
        self.removed = removed
    }

    static let cells = 5

    /// How many cells each side lights, out of ``cells``.
    static func split(added: Int, removed: Int) -> (added: Int, removed: Int) {
        let total = added + removed
        guard total > 0 else { return (0, 0) }
        var green = Int((Double(added) / Double(total) * Double(cells)).rounded())
        var red = cells - green
        if added > 0, green == 0 { green = 1; red = cells - 1 }
        if removed > 0, red == 0 { red = 1; green = cells - 1 }
        if added == 0 { green = 0 }
        if removed == 0 { red = 0 }
        return (green, red)
    }

    public var body: some View {
        let split = Self.split(added: added, removed: removed)
        HStack(spacing: 2) {
            ForEach(0..<Self.cells, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(
                        index < split.added
                            ? Studio.Ink.added
                            : index < split.added + split.removed ? Studio.Ink.removed : Studio.Surface.hairline
                    )
                    .frame(width: 7, height: 7)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A key or chord, drawn as the menus draw it.
struct StudioKeycap: View {
    let keys: String

    var body: some View {
        Text(keys)
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.tertiary)
    }
}

/// A list section's heading: small, secondary, sentence case.
struct StudioSectionHeader: View {
    let title: String
    var trailing: String?

    var body: some View {
        HStack {
            Text(title)
                .font(Studio.Font.caption)
                .foregroundStyle(Studio.Ink.tertiary)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Studio.Font.caption)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
        }
    }
}

// MARK: - Formatting

public enum StudioFormat {
    /// `8s`, `2m 14s`, `1h 3m`.
    public static func duration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        if total < 3_600 {
            let minutes = total / 60, remainder = total % 60
            return remainder == 0 ? "\(minutes)m" : "\(minutes)m \(remainder)s"
        }
        let hours = total / 3_600, minutes = (total % 3_600) / 60
        return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m"
    }

    /// `now`, `4m`, `2h`, `3d`, then a short date.
    public static func age(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    public static func plural(_ count: Int, _ noun: String, _ plural: String? = nil) -> String {
        "\(count) \(count == 1 ? noun : (plural ?? noun + "s"))"
    }

    /// `12.4K` for a token count.
    public static func tokens(_ count: Int) -> String {
        if count < 1_000 { return "\(count)" }
        if count < 1_000_000 {
            let value = Double(count) / 1_000
            return value < 10 ? String(format: "%.1fK", value) : "\(Int(value))K"
        }
        return String(format: "%.1fM", Double(count) / 1_000_000)
    }
}

// MARK: - Bounded minimum height

/// Keeps a column's fixed region from asking for an unbounded height when
/// the window measures its minimum size.
///
/// AppKit asks a hosting view for its minimum size by proposing a width of
/// zero. A wrapping `Text` with `.fixedSize(horizontal: false, vertical: true)`
/// answers that with every character on a line of its own: the screen grant
/// card under the composer reported about 3,900 points, the split view grew to
/// fit it, and the window drew both columns centred far outside itself —
/// a blank Code window with only the toolbar left (1.11.0). Below `floor`,
/// this measures its content at `floor` instead, so the height it reports is
/// one a real column could need. At any real width it is a pass-through.
public struct StudioBoundedMinimumHeight: Layout {
    /// The narrowest width the content is measured at.
    public var floor: CGFloat = StudioBoundedMinimumHeight.defaultFloor

    public static let defaultFloor: CGFloat = 320

    public init(floor: CGFloat = StudioBoundedMinimumHeight.defaultFloor) {
        self.floor = floor
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        guard let width = proposal.width, width < floor else {
            return child.sizeThatFits(proposal)
        }
        let narrow = child.sizeThatFits(proposal)
        let measured = child.sizeThatFits(ProposedViewSize(width: floor, height: proposal.height))
        return CGSize(width: narrow.width, height: min(narrow.height, measured.height))
    }

    public func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        for child in subviews {
            child.place(
                at: bounds.origin,
                anchor: .topLeading,
                proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
            )
        }
    }
}

public extension View {
    /// See ``StudioBoundedMinimumHeight``: for the composer and anything that
    /// takes its place, which sit outside the thread's scroll view, and for
    /// the window's inspector panes.
    func studioBoundedMinimumHeight(floor: CGFloat = StudioBoundedMinimumHeight.defaultFloor) -> some View {
        StudioBoundedMinimumHeight(floor: floor) { self }
    }
}

// MARK: - Yielding width

/// Lets a split view column shrink to the width the window gives it.
///
/// A column's minimum width is whatever its content says it needs at a
/// proposed width of zero. The Code composer's control row, the preview's
/// toolbar and a page rendered at a fixed width all answer with hundreds of
/// points, and with the side panel open their sum passed the window's width:
/// the split view laid the columns out wider than the window, so the sidebar
/// was cut off on the left and the panel on the right. This reports the width
/// it is proposed (nothing at zero) and places its content at that width,
/// clipped, so the window decides the columns and never the other way round.
public struct StudioYieldingWidth: Layout {
    public init() {}

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        guard let width = proposal.width, width.isFinite else { return child.sizeThatFits(proposal) }
        // A column takes the height it is offered. Measuring the content here
        // would lay the whole thread out again for every frame of a drag on
        // the panel's edge (AppKit asks for the minimum at a width of zero,
        // where a transcript is thousands of points tall), which is what made
        // resizing stutter.
        if let height = proposal.height, height.isFinite { return CGSize(width: width, height: height) }
        return CGSize(width: width, height: child.sizeThatFits(proposal).height)
    }

    public func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        for child in subviews {
            child.place(
                at: bounds.origin,
                anchor: .topLeading,
                proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
            )
        }
    }
}

public extension View {
    /// See ``StudioYieldingWidth``: for a split view column or the window's
    /// inspector, whose content must never set the window's width.
    func studioYieldingWidth() -> some View {
        StudioYieldingWidth { self }.clipped()
    }
}
