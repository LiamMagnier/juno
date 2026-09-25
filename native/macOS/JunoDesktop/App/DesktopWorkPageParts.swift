import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The pieces the Automations and Permissions pages share (Phase 4 Stage C):
/// a list of rows in one card, a row's hover fill and its More button, the
/// deal on first load, a status pill, a tag, a section heading and an inline
/// note. The web draws these from `components/work/shell/*` and
/// `work-vocabulary.tsx`; these are the same shapes on the Mac's recipes —
/// opaque on the canvas, card radius 16, `--border` at 70% between rows.

// MARK: - A list of rows

/// Rows in one card, divided by `--border` at 70% — never a hairline under
/// every row of a free list. Each row receives its index for the deal.
struct DesktopWorkRowList<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder let row: (Item, Int) -> Row

    @State private var dealt = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(0.7))
                        .frame(height: 1)
                        .padding(.horizontal, JunoSpace.cozy)
                        .accessibilityHidden(true)
                }
                row(item, index)
                    .modifier(DesktopWorkDeal(index: index, dealt: dealt || reduceMotion))
            }
        }
        .padding(JunoSpace.tight)
        .junoCard(cornerRadius: JunoRadius.card)
        .onAppear {
            // Dealt once, when the rows first land; a later change to the
            // list (a new automation, a refresh) appears in place.
            guard !dealt else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)) {
                dealt = true
            }
        }
    }
}

/// The rise-in, 45ms apart and capped at the tenth row (Phase 4 §2.2).
struct DesktopWorkDeal: ViewModifier {
    let index: Int
    let dealt: Bool

    func body(content: Content) -> some View {
        content
            .opacity(dealt ? 1 : 0)
            .offset(y: dealt ? 0 : JunoMotion.riseDistance)
            .animation(
                JunoMotion.riseIn.delay(Double(min(index, 10)) * 0.045),
                value: dealt
            )
    }
}

/// A row's tonal fill under the pointer, at the control radius inside the
/// card. Nothing lifts.
struct DesktopWorkRowSurface: ViewModifier {
    let isHovering: Bool

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.clear)
            )
    }
}

/// A row's actions behind `ph.dotsthree`: a 28pt borderless icon over a
/// system menu, revealed with the row's hover and kept while the menu is
/// open (the menu holds the pointer, so the row never sees it leave).
struct DesktopWorkMoreButton<Items: View>: View {
    let label: String
    let isVisible: Bool
    @ViewBuilder let items: () -> Items

    var body: some View {
        Menu {
            items()
        } label: {
            JunoIconView(.more, size: 16)
                .foregroundStyle(Color.junoMutedForeground)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28, height: 28)
        .opacity(isVisible ? 1 : 0)
        .help("More")
        .accessibilityLabel(label)
    }
}

// MARK: - Words beside a name

/// A neutral word beside a name ("Paused", "Work off", "Default"): the web's
/// `WorkTag` and secondary `Badge`, SF at the label rung — never mono, never
/// coloured.
struct DesktopWorkTag: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .junoType(.caption)
            .foregroundStyle(Color.junoSecondaryInk)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, JunoSpace.tight)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.junoSecondary))
            .overlay(Capsule().strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 1))
    }
}

/// A run's status as a word in a quiet pill (`WorkStatusPill`). Only a live
/// run carries the dot; every other status is its word, in its ink.
struct DesktopRunStatusPill: View {
    let status: String

    private var tone: NativeWorkScheduleCopy.StatusTone { NativeWorkScheduleCopy.statusTone(status) }

    private var ink: Color {
        switch tone {
        case .live: Color.junoForeground
        case .attention: Color.junoWarningInk
        case .good: Color.junoSuccessInk
        case .bad: Color.junoDestructiveInk
        case .neutral: Color.junoSecondaryInk
        }
    }

    private var fill: Color {
        switch tone {
        case .live: Color.junoSecondary
        case .attention: Color.junoWarning.opacity(0.12)
        case .good: Color.junoSuccess.opacity(0.1)
        case .bad: Color.junoDestructive.opacity(0.1)
        case .neutral: Color.junoSecondary
        }
    }

    var body: some View {
        HStack(spacing: JunoSpace.tight) {
            if tone == .live {
                Circle()
                    .fill(Color.junoAccent)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
            Text(NativeWorkScheduleCopy.statusLabel(status))
        }
        .junoType(JunoType.label)
        .foregroundStyle(ink)
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, 3)
        .background(Capsule().fill(fill))
    }
}

// MARK: - Headings and notes

/// A section heading on the `heading` rung, marked as a header.
struct DesktopWorkSectionHeading: View {
    let title: String
    var lede: String?

    init(_ title: String, lede: String? = nil) {
        self.title = title
        self.lede = lede
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(title)
                .junoType(.heading)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if let lede {
                Text(lede)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A standing sentence in the page's flow (`WorkStateNote`): opaque, a tint of
/// its tone, the glyph carrying the status and the words in the foreground.
struct DesktopWorkNote<Action: View>: View {
    enum Tone {
        case info, warning, error, blocked
    }

    let tone: Tone
    let text: String
    @ViewBuilder let action: () -> Action

    init(_ tone: Tone, _ text: String, @ViewBuilder action: @escaping () -> Action) {
        self.tone = tone
        self.text = text
        self.action = action
    }

    private var icon: JunoIcon {
        switch tone {
        case .info: .info
        case .warning: .warning
        case .error: .error
        case .blocked: .shieldOff
        }
    }

    private var ink: Color {
        switch tone {
        case .info: Color.junoSecondaryInk
        case .warning: Color.junoWarningInk
        case .error, .blocked: Color.junoDestructiveInk
        }
    }

    private var fill: Color {
        switch tone {
        case .info: Color.junoSecondary
        case .warning: Color.junoWarning.opacity(0.1)
        case .error, .blocked: Color.junoDestructive.opacity(0.08)
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(icon, size: 14)
                .foregroundStyle(ink)
                .accessibilityHidden(true)
            Text(text)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            action()
        }
        .padding(.horizontal, JunoSpace.comfy)
        .padding(.vertical, JunoSpace.close)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(fill)
        )
        .accessibilityElement(children: .combine)
    }
}

extension DesktopWorkNote where Action == EmptyView {
    init(_ tone: Tone, _ text: String) {
        self.init(tone, text) { EmptyView() }
    }
}

// MARK: - Loading

/// Rows shaped like the final ones — a name, a sentence, a meta line —
/// breathing on `JunoMotion` (`WorkRowSkeletons`).
struct DesktopWorkSkeletonRows: View {
    var count = 3

    private static let widths: [(CGFloat, CGFloat, CGFloat)] = [
        (200, 440, 150), (160, 380, 190), (240, 460, 120),
    ]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                let widths = Self.widths[index % Self.widths.count]
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    JunoSkeleton(height: 14, width: widths.0)
                    JunoSkeleton(height: 12, width: widths.1)
                    JunoSkeleton(height: 10, width: widths.2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, JunoSpace.comfy)
                .padding(.vertical, JunoSpace.cozy)
            }
        }
        .padding(JunoSpace.tight)
        .junoCard(cornerRadius: JunoRadius.card)
        .accessibilityElement()
        .accessibilityLabel("Loading")
    }
}
