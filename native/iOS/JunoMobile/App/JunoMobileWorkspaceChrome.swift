import JunoDesignSystem
import SwiftUI
import UIKit

/// The pieces the artifact and project screens are rebuilt on.
///
/// Both screens were the last two in the app still made of stock SwiftUI: a
/// `.segmented` `Picker`, an accent-tinted text `Button` standing in for a link,
/// and an `.insetGrouped` `List` whose grouped metrics read like a Settings page.
/// Every other screen composes from `JunoCard` / `JunoGroupLabel` and the web's
/// own proportions, and these are the atoms that let these two do the same.

// MARK: - Segmented control

/// A two-or-three-way switch: a quiet track with one raised thumb.
///
/// Replaces `Picker(...).pickerStyle(.segmented)`, whose iOS chrome is the wrong
/// weight for a control that sits inside content — a full-width slab with hard
/// dividers, announcing itself louder than the artifact it is switching. This is
/// the website's toggle: content-width, one moving thumb, no dividers.
struct JunoMobileSegmented<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        var id: Value { value }

        init(_ value: Value, _ title: String) {
            self.value = value
            self.title = title
        }
    }

    let options: [Option]
    @Binding var selection: Value
    var accessibilityLabel: String

    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                        selection = option.value
                    }
                } label: {
                    Text(option.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(selected ? Color.primary : Color.junoMutedForeground)
                        // A switch that wraps is not a switch. This one is now
                        // used inside the Code composer, where three options,
                        // a repository chip and Send share one line on a small
                        // phone — so the labels give up a little size under
                        // pressure rather than breaking onto a second row.
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .padding(.horizontal, 14)
                        .frame(height: 28)
                        .background {
                            if selected {
                                Capsule(style: .continuous)
                                    .fill(Color.junoSurface)
                                    .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
                                    // The thumb is one view that MOVES between
                                    // slots rather than two that cross-fade, so
                                    // the switch reads as a physical throw.
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(2)
        .background(Capsule(style: .continuous).fill(Color.junoMuted))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

// MARK: - Meta chip

/// A compact, quiet chip carrying one piece of metadata or one small action.
///
/// The artifact header used a bare tinted `Button` for "go to the conversation
/// this came from", which is coral prose floating over content — the accent spent
/// on navigation, and no indication it was a control at all. A chip says
/// "tappable" by its shape.
struct JunoMobileMetaChip: View {
    let title: String
    var systemImage: String?
    var action: (() -> Void)?

    var body: some View {
        if let action {
            Button(action: action) { label }
                .buttonStyle(.plain)
        } else {
            label.accessibilityElement(children: .combine)
        }
    }

    private var label: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .semibold))
            }
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(Color.junoMutedForeground)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(Capsule(style: .continuous).fill(Color.junoMuted))
        .contentShape(Capsule())
    }
}

// MARK: - Long-form disclosure

/// A block of long text that starts clamped, with the full length one tap away.
///
/// Project instructions are the case this exists for. They are usually a long
/// prompt — `<role>…</role>`, `<about_me>…</about_me>`, forty lines of it — and
/// the screen opened with all of it as the first and only thing on it, so the
/// project's own name, its conversations and its files were all below the fold.
/// A clamped preview keeps the *shape* of the screen legible while leaving the
/// text completely reachable.
///
/// Monospaced on purpose: this is a prompt, not prose. Angle brackets and
/// indentation are load-bearing, and a proportional face hides both.
struct JunoMobileClampedText: View {
    let text: String
    var lineLimit: Int = 8
    var monospaced: Bool = true

    @State private var expanded = false
    @State private var width: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether the clamp is actually hiding anything.
    ///
    /// **Typeset, not guessed and not measured through SwiftUI.** Two earlier
    /// attempts both silently reported "nothing hidden": a `ViewThatFits`
    /// comparison that measured the clamped text against its own clamped box, and
    /// a pair of hidden `Text` copies whose heights were read back with
    /// `onGeometryChange` — state written from inside a `background` during layout,
    /// which is exactly the kind of feedback SwiftUI is entitled to coalesce away.
    ///
    /// Text Kit answers the same question directly and deterministically: lay the
    /// string out at the known width and compare against the height `lineLimit`
    /// lines would occupy. The font is a fixed 13pt (not a Dynamic Type style), so
    /// its metrics are exact rather than an approximation.
    private var isTruncated: Bool {
        guard width > 0 else { return false }
        return typesetHeight > clampHeight + 1
    }

    private static let lineSpacing: CGFloat = 3

    private var uiFont: UIFont {
        monospaced
            ? .monospacedSystemFont(ofSize: 13, weight: .regular)
            : .systemFont(ofSize: 13)
    }

    /// The height `lineLimit` lines occupy. The trailing gap is dropped: n lines
    /// have n−1 gaps between them.
    private var clampHeight: CGFloat {
        CGFloat(lineLimit) * uiFont.lineHeight
            + CGFloat(lineLimit - 1) * Self.lineSpacing
    }

    private var typesetHeight: CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = Self.lineSpacing
        let measured = NSAttributedString(
            string: text,
            attributes: [.font: uiFont, .paragraphStyle: paragraph]
        )
        .boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        return ceil(measured.height)
    }

    private var font: Font {
        .system(size: 13, design: monospaced ? .monospaced : .default)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(text)
                .font(font)
                .lineSpacing(3)
                .foregroundStyle(Color.primary.opacity(0.82))
                .textSelection(.enabled)
                .lineLimit(expanded ? nil : lineLimit)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }


            if isTruncated {
                Button {
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(expanded ? "Show less" : "Show all")
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.junoMutedForeground)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.clamped-toggle")
            }
        }
    }

}

// MARK: - Section

/// A titled group with an optional trailing action, above a card.
///
/// The pattern the rest of the app uses — a quiet label, then the content — as a
/// single view, so a screen with four sections does not repeat the header
/// geometry four times and drift.
struct JunoMobileWorkspaceSection<Content: View>: View {
    let title: String
    var actionTitle: String?
    var actionImage: String?
    var action: (() -> Void)?
    var footnote: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if let action, let actionTitle {
                    Button(action: action) {
                        HStack(spacing: 4) {
                            if let actionImage {
                                Image(systemName: actionImage)
                                    .font(.system(size: 11, weight: .semibold))
                            }
                            Text(actionTitle)
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(Color.junoAccent)
                    }
                    .buttonStyle(.plain)
                }
            }

            content

            if let footnote {
                Text(footnote)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.junoMutedForeground.opacity(0.8))
            }
        }
    }
}

/// The "nothing here yet" line inside a card — one sentence, never a full
/// `ContentUnavailableView`, which is a whole-screen component and reads as an
/// error when it appears inside a section.
struct JunoMobileEmptyLine: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(Color.junoMutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#if DEBUG
#Preview("Workspace chrome") {
    ScrollView {
        VStack(alignment: .leading, spacing: 24) {
            JunoMobileSegmented(
                options: [.init(0, "Preview"), .init(1, "Source")],
                selection: .constant(0),
                accessibilityLabel: "View"
            )
            HStack {
                JunoMobileMetaChip(title: "Merging two prompts", systemImage: "bubble.left.and.text.bubble.right") {}
                JunoMobileMetaChip(title: "v3", systemImage: "clock.arrow.circlepath")
            }
            JunoMobileWorkspaceSection(
                title: "Instructions",
                actionTitle: "Edit",
                actionImage: "pencil",
                action: {},
                footnote: "Included in every conversation linked to this project."
            ) {
                JunoCard {
                    JunoMobileClampedText(
                        text: (0..<20).map { "<line index=\"\($0)\">content</line>" }
                            .joined(separator: "\n")
                    )
                }
            }
        }
        .padding(16)
    }
    .background(Color.junoCanvas)
}
#endif
