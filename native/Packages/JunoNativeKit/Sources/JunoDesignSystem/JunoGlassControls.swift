import SwiftUI

// MARK: - Liquid Glass controls (Mac round 3)
//
// The owner's rule for the Mac (2026-10-09): the buttons and selectors on
// every page are native Liquid Glass — not AppKit's white bezel slabs. This
// file owns every one of those controls, so a page never spells
// `.glassEffect` itself:
//
// - ``JunoGlassButtonStyle`` (`.junoGlass`): a secondary action, the system's
//   own `.glass` button style.
// - ``JunoProminentButtonStyle`` (`.junoProminent`, JunoButtonStyles.swift):
//   the surface's one primary action, `.glassProminent` in the accent.
// - ``View/junoGlassMenu(shape:)``: a `Menu` drawn as a glass button.
// - ``JunoGlassSegmentTrack``: the track ``JunoSegmented`` draws its
//   segments on.
//
// Liquid Glass is composited by the window server, so a view photographed
// offscreen (`cacheDisplay`) shows none of it. Under Reduce Transparency, and
// when the snapshot harness sets ``SwiftUI/EnvironmentValues/junoSnapshotOpaqueGlass``,
// each control draws its opaque stand-in instead: the popover fill, a
// hairline and the raised shadow, in the same capsule at the same metrics.

/// The capsule metrics the glass controls share, by control size: the
/// system's regular push button height on macOS 26, and its small one.
enum JunoGlassControlMetrics {
    static func height(_ size: ControlSize) -> CGFloat {
        switch size {
        case .mini: 20
        case .small: 24
        case .large, .extraLarge: 36
        default: 30
        }
    }

    static func horizontalPadding(_ size: ControlSize) -> CGFloat {
        switch size {
        case .mini, .small: 10
        case .large, .extraLarge: 16
        default: 14
        }
    }
}

// MARK: Secondary button

/// A secondary action in Liquid Glass: `.buttonStyle(.junoGlass)`.
///
/// The system's `.glass` underneath — its press flex, hover sheen, focus ring,
/// disabled and inactive-window states are all AppKit's. Use it everywhere a
/// page used to say `.bordered`.
public struct JunoGlassButtonStyle: PrimitiveButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        JunoGlassButton(configuration: configuration, prominent: false)
    }
}

public extension PrimitiveButtonStyle where Self == JunoGlassButtonStyle {
    /// `.buttonStyle(.junoGlass)` — a secondary action in Liquid Glass.
    static var junoGlass: JunoGlassButtonStyle { JunoGlassButtonStyle() }
}

/// One glass button, or its opaque stand-in.
struct JunoGlassButton: View {
    let configuration: PrimitiveButtonStyleConfiguration
    let prominent: Bool

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass

    var body: some View {
        #if os(iOS)
        // The phone keeps its opaque buttons; its chrome is its own.
        if prominent {
            Button(configuration).buttonStyle(.borderedProminent).tint(Color.junoAccent).contentShape(.rect)
        } else {
            Button(configuration).buttonStyle(.bordered).contentShape(.rect)
        }
        #else
        if reduceTransparency || snapshotOpaqueGlass {
            Button(configuration)
                .buttonStyle(JunoGlassStandInStyle(prominent: prominent))
                .contentShape(Capsule())
        } else if prominent {
            Button(configuration)
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(Color.junoAccent)
                .contentShape(Capsule())
        } else {
            Button(configuration)
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .contentShape(Capsule())
        }
        #endif
    }
}

/// The opaque capsule that stands in for a glass button: the popover fill (or
/// the accent, prominent), a hairline and the raised shadow.
struct JunoGlassStandInStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        StandIn(configuration: configuration, prominent: prominent)
    }

    private struct StandIn: View {
        let configuration: ButtonStyleConfiguration
        let prominent: Bool

        @Environment(\.controlSize) private var controlSize
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .junoType(JunoType.ui.weight(.medium))
                .labelStyle(JunoGlassLabelStyle())
                .foregroundStyle(prominent ? Color.junoOnAccent : Color.junoForeground)
                .lineLimit(1)
                .padding(.horizontal, JunoGlassControlMetrics.horizontalPadding(controlSize))
                .frame(minHeight: JunoGlassControlMetrics.height(controlSize))
                .background {
                    JunoGlassStandInShape(prominent: prominent, shape: Capsule(style: .continuous))
                }
                .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
                .contentShape(Capsule())
        }
    }
}

/// An icon and its words at the glass controls' gap.
struct JunoGlassLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon
            configuration.title
        }
    }
}

/// The stand-in's material: popover fill or accent, hairline, raised shadow.
struct JunoGlassStandInShape<S: Shape>: View {
    var prominent = false
    let shape: S

    var body: some View {
        shape
            .fill(prominent ? Color.junoAccent : Color.junoPopover)
            .overlay {
                shape.stroke(
                    prominent ? Color.white.opacity(0.18) : Color.junoBorder.opacity(0.9),
                    lineWidth: 0.5
                )
            }
            .shadow(color: Color.junoRaisedShadow, radius: 3, y: 1)
    }
}

// MARK: Menus

/// The shape a glass menu trigger takes.
public enum JunoGlassMenuShape: Sendable {
    /// Words (and a chevron): a capsule.
    case capsule
    /// One glyph: a circle.
    case circle
}

public extension View {
    /// A `Menu` drawn as a Liquid Glass button: a page's sort, its More, its
    /// New ▾. The menu itself is the system's.
    func junoGlassMenu(_ shape: JunoGlassMenuShape = .capsule, prominent: Bool = false) -> some View {
        modifier(JunoGlassMenuModifier(shape: shape, prominent: prominent))
    }
}

private struct JunoGlassMenuModifier: ViewModifier {
    let shape: JunoGlassMenuShape
    let prominent: Bool

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.controlSize) private var controlSize

    func body(content: Content) -> some View {
        if reduceTransparency || snapshotOpaqueGlass {
            // A menu takes no ButtonStyle of ours on the Mac, so the stand-in
            // is drawn around the plain trigger.
            let height = JunoGlassControlMetrics.height(controlSize)
            content
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .foregroundStyle(prominent ? Color.junoOnAccent : Color.junoForeground)
                .padding(.horizontal, shape == .circle ? 0 : JunoGlassControlMetrics.horizontalPadding(controlSize))
                .frame(width: shape == .circle ? height : nil, height: height)
                .background {
                    switch shape {
                    case .capsule: JunoGlassStandInShape(prominent: prominent, shape: Capsule(style: .continuous))
                    case .circle: JunoGlassStandInShape(prominent: prominent, shape: Circle())
                    }
                }
                .fixedSize()
        } else if prominent {
            content
                .menuStyle(.button)
                .buttonStyle(.glassProminent)
                .tint(Color.junoAccent)
                .menuIndicator(.hidden)
                .buttonBorderShape(shape == .circle ? .circle : .capsule)
                .fixedSize()
        } else {
            content
                .menuStyle(.button)
                .buttonStyle(.glass)
                .menuIndicator(.hidden)
                .buttonBorderShape(shape == .circle ? .circle : .capsule)
                .fixedSize()
        }
    }
}

// MARK: Icon button

public extension View {
    /// A one-glyph action in a glass circle: Pin, More, Close on a page.
    func junoGlassIconButton() -> some View {
        modifier(JunoGlassIconButtonModifier())
    }
}

private struct JunoGlassIconButtonModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.controlSize) private var controlSize

    func body(content: Content) -> some View {
        if reduceTransparency || snapshotOpaqueGlass {
            let side = JunoGlassControlMetrics.height(controlSize)
            content
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoForeground)
                .frame(width: side, height: side)
                .background { JunoGlassStandInShape(shape: Circle()) }
                .contentShape(Circle())
        } else {
            content
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .contentShape(Circle())
        }
    }
}

// MARK: Segment track

/// The track a glass segmented control sits in: one capsule of Liquid Glass
/// (interactive, so it flexes under the pointer), or its opaque stand-in.
struct JunoGlassSegmentTrack: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass

    func body(content: Content) -> some View {
        if reduceTransparency || snapshotOpaqueGlass {
            content.background { JunoGlassStandInShape(shape: Capsule(style: .continuous)) }
        } else {
            GlassEffectContainer {
                content.glassEffect(.regular.interactive(), in: .capsule)
            }
        }
    }
}

// MARK: Menu picker

public extension View {
    /// A `Picker` offered as a glass menu: the current choice and the up-down
    /// chevrons on a glass capsule, the choices as the system menu's inline
    /// checkmark rows. Apply it to the picker in place of
    /// `.pickerStyle(.menu)` — AppKit's pop-up bezel is the white slab the
    /// owner retired on the Mac (round 3).
    func junoGlassMenuPicker(current: String) -> some View {
        Menu {
            self.pickerStyle(.inline)
        } label: {
            HStack(spacing: 6) {
                Text(current)
                    .junoType(JunoType.ui.weight(.medium))
                    .lineLimit(1)
                JunoIconView(.chevronsUpDown, size: 12)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(Color.junoForeground)
            .contentShape(Capsule())
        }
        .junoGlassMenu()
        .accessibilityValue(current)
    }
}
