import JunoDesignSystem
import SwiftUI

// The small pieces the Phase 4 Stage B pages share (Memory, Skills,
// Assistants): one recipe each, so a note, a row's More button or a section
// heading looks the same on every page that draws one.

/// A page's announcement (the web's `Notice` in `memory-notices.tsx`, the
/// `DesktopTurnNote` recipe): opaque, radius 12, the muted fill under a 70%
/// hairline, a glyph, the words, and at most one thing to do about it.
struct DesktopNoteBand<Words: View, Action: View>: View {
    let icon: JunoIcon
    var tone: Color = Color.junoSecondaryInk
    @ViewBuilder let words: () -> Words
    @ViewBuilder let action: () -> Action

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.close) {
                JunoIconView(icon, size: 16)
                    .foregroundStyle(tone)
                    .accessibilityHidden(true)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                words()
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            action()
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoMuted)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(contrast == .increased ? 1 : 0.7), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }
}

extension DesktopNoteBand where Action == EmptyView {
    init(icon: JunoIcon, tone: Color = Color.junoSecondaryInk, @ViewBuilder words: @escaping () -> Words) {
        self.init(icon: icon, tone: tone, words: words, action: { EmptyView() })
    }
}

/// A row's or a header's overflow: the 28pt `ph.dotsthree` over a system
/// menu (`.menuStyle(.button)`), Title Case items, destructive last.
/// Call sites hand their items over in one `Section`: a single group draws no
/// separator, and it says in the source that these rows are AppKit's to lay
/// out, not ours (the targets gate reads it the same way).
struct DesktopRowMenuButton<Items: View>: View {
    let accessibilityLabel: String
    var help: String = "More"
    @ViewBuilder let items: () -> Items

    @State private var isHovering = false

    var body: some View {
        Menu {
            items()
        } label: {
            JunoIconView(.more, size: 16)
                .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(isHovering ? Color.junoHover : Color.clear)
                )
                .contentShape(.rect(cornerRadius: JunoRadius.control))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { isHovering = $0 }
        .help(help)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// A 28pt icon-only button in the page's quiet voice: the glyph in the
/// secondary ink, the hover wash, a tooltip and a spoken name.
struct DesktopQuietIconButton: View {
    let icon: JunoIcon
    let label: String
    var help: String? = nil
    var isOn = false
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: 15, isOn: isOn)
                .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(isHovering ? Color.junoHover : Color.clear)
                )
                .contentShape(.rect(cornerRadius: JunoRadius.control))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(help ?? label)
        .accessibilityLabel(label)
    }
}

/// A text button that reads as a link: the foreground ink, 13 medium,
/// underlined under the pointer (the memory footer's "Import · Export").
struct DesktopUnderlineLinkStyle: ButtonStyle {
    var ink: Color = Color.junoForeground

    func makeBody(configuration: Configuration) -> some View {
        Rendered(configuration: configuration, ink: ink)
    }

    private struct Rendered: View {
        let configuration: ButtonStyleConfiguration
        let ink: Color
        @State private var isHovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .junoType(JunoType.caption.weight(.medium))
                .foregroundStyle(isEnabled ? ink : Color.junoSecondaryInk)
                .underline(isHovering && isEnabled)
                .opacity(configuration.isPressed ? 0.7 : 1)
                .frame(minHeight: 28)
                .contentShape(.rect)
                .onHover { isHovering = $0 }
        }
    }
}

/// A section's heading on the `heading` rung, with its count beside it in the
/// secondary ink (the web's `h2` + tabular count).
struct DesktopSectionHeading: View {
    let title: String
    var count: Int? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Text(title)
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if let count {
                Text(count, format: .number)
                    .junoType(.body)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }
}

/// Rows inside one card, divided by the border at 70% (Phase 4 brief §2.2):
/// the card radius 16, a 1pt hairline, content opaque on the canvas.
struct DesktopListCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoCard)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }
}

/// The hairline between two rows of a ``DesktopListCard``.
struct DesktopRowDivider: View {
    var inset: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(Color.junoBorder.opacity(0.7))
            .frame(height: 1)
            .padding(.leading, inset)
            .accessibilityHidden(true)
    }
}

/// The web's `surface-inset` tile: a glyph on the secondary fill at the field
/// radius, stepping from the secondary ink to the foreground under the
/// pointer.
struct DesktopInsetTile: View {
    let icon: JunoIcon
    var side: CGFloat = 36
    var glyph: CGFloat = 16
    var isActive = false

    var body: some View {
        JunoIconView(icon, size: glyph)
            .foregroundStyle(isActive ? Color.junoForeground : Color.junoSecondaryInk)
            .frame(width: side, height: side)
            .background(
                RoundedRectangle(cornerRadius: side >= 36 ? JunoRadius.field : JunoRadius.control, style: .continuous)
                    .fill(Color.junoSecondary)
            )
            .accessibilityHidden(true)
    }
}

/// A repository owner's tile: the GitHub mark on the secondary fill. The web
/// loads the owner's GitHub picture and falls back to this mark; the Mac
/// draws the fallback, so no request leaves the app for a decoration
/// (register #76). The owner's name is always written beside it.
struct DesktopOwnerTile: View {
    let owner: String
    var side: CGFloat = 28

    var body: some View {
        JunoIconView(.github, size: side * 0.57)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(width: side, height: side)
            .background(
                RoundedRectangle(cornerRadius: side > 24 ? JunoRadius.control : JunoRadius.xs, style: .continuous)
                    .fill(Color.junoSecondary)
            )
            .accessibilityHidden(true)
    }
}

/// A keycap: the Skills search's `/`.
struct DesktopKeycap: View {
    let key: String

    var body: some View {
        Text(key)
            .junoType(.micro)
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.tight)
            .frame(minWidth: 20, minHeight: 20)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                    .fill(Color.junoCanvas)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
            .accessibilityHidden(true)
    }
}

/// A token under a row: a small capsule in the secondary fill ("Thesis",
/// "Health"), or the warning wash for the one that changes what a row means.
struct DesktopRowToken: View {
    let text: String
    var icon: JunoIcon? = nil
    var isWarning = false

    var body: some View {
        HStack(spacing: JunoSpace.micro * 2) {
            if let icon {
                JunoIconView(icon, size: 11)
                    .accessibilityHidden(true)
            }
            Text(text)
                .lineLimit(1)
        }
        .junoType(JunoType.caption.weight(.medium))
        .foregroundStyle(isWarning ? Color.junoWarningInk : Color.junoSecondaryInk)
        .padding(.horizontal, JunoSpace.tight)
        .padding(.vertical, 1)
        .background(
            Capsule(style: .continuous)
                .fill(isWarning ? Color.junoWarning.opacity(0.15) : Color.junoSecondary)
        )
    }
}

/// Rows rising into place once, on the list's first load: the workhorse
/// entrance, 45ms apart, capped at ten (Phase 4 brief §2.2). Switching views
/// does not replay it; under Reduce Motion everything is simply there.
struct DesktopDealIn: ViewModifier {
    let index: Int
    let isDealt: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.desktopDealsRowsIn) private var dealsRowsIn
    @State private var hasArrived = false

    private var settled: Bool { isDealt || hasArrived || reduceMotion || !dealsRowsIn }

    func body(content: Content) -> some View {
        content
            .opacity(settled ? 1 : 0)
            .offset(y: settled ? 0 : JunoMotion.riseDistance)
            .onAppear {
                guard !settled else { return }
                let delay = Double(min(index, 10)) * 0.045
                withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)?.delay(delay)) {
                    hasArrived = true
                }
            }
    }
}

extension EnvironmentValues {
    /// Whether rows rise in on a list's first load. Off in the snapshots,
    /// which photograph the settled page rather than a frame of the deal.
    @Entry var desktopDealsRowsIn = true
}

extension View {
    /// Deals this row in once (``DesktopDealIn``).
    func desktopDealIn(_ index: Int, dealt: Bool) -> some View {
        modifier(DesktopDealIn(index: index, isDealt: dealt))
    }
}

/// A pull-down that is the page's one primary action (Skills' "Add ▾"):
/// drawn as the system's prominent button in the Juno accent — the fill, the
/// on-accent ink, the regular control's height and corner — because a `Menu`
/// takes no `PrimitiveButtonStyle`, so `.junoProminent` cannot reach it.
struct DesktopProminentMenuLabel: View {
    let title: String
    var icon: JunoIcon? = nil

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if let icon {
                JunoIconView(icon, size: 12)
            }
            Text(title)
            JunoIconView(.chevronDown, size: 10)
                .opacity(0.8)
        }
        .junoType(JunoType.ui.weight(.medium))
        .foregroundStyle(Color.junoOnAccent)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.xs, style: .continuous)
                .fill(Color.junoAccent)
                .brightness(isHovering ? -0.04 : 0)
        )
        .opacity(isEnabled ? 1 : 0.5)
        .frame(minHeight: 28)
        .contentShape(.rect)
        .onHover { isHovering = $0 }
    }
}

/// A note's two voices in one run of text: the lead in medium weight, in the
/// ink the note gives it, and the rest in the secondary ink.
func desktopLeadSentence(_ lead: String, _ rest: String) -> Text {
    Text("\(Text(lead).fontWeight(.medium)) \(Text(rest).foregroundStyle(Color.junoSecondaryInk))")
}

/// A skill's slash command in the small mono face: in the foreground ink when
/// it is the thing to type, or in its sentence's own ink when it is not.
func desktopSlugText(_ slug: String, emphasised: Bool = true) -> Text {
    let command = Text(verbatim: "/\(slug)").font(JunoType.monoSmall.font())
    return emphasised ? command.foregroundStyle(Color.junoForeground) : command
}
