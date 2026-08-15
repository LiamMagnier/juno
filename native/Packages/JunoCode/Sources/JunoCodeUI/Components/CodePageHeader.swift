import JunoDesignSystem
import SwiftUI

/// The strip above a Code page: what you are looking at, and the actions that
/// belong to it.
///
/// One component because the two headers it replaces were the *same* header —
/// they occupied the same strip above the same composer and differed only in
/// what they had to say — and had already drifted into the app's only pair of
/// 19pt glyphs, a monospaced path, and two different trailing button
/// treatments.
///
/// **Opaque, on the canvas.** The header is content: it names the thing below
/// it. The window's glass is the sidebar and the toolbar above it, and a third
/// pane of material here would put two layers of glass in one vertical inch.
public struct CodePageHeader<Trailing: View>: View {
    private let icon: JunoIcon
    private let title: String
    private let subtitle: String?
    /// A path renders in the code face; a sentence never does. Monospace is for
    /// code, paths and terminal output — nothing else in this product's UI.
    private let subtitleIsPath: Bool
    private let badge: String?
    private let trailing: Trailing

    public init(
        icon: JunoIcon,
        title: String,
        subtitle: String? = nil,
        subtitleIsPath: Bool = false,
        badge: String? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.subtitleIsPath = subtitleIsPath
        self.badge = badge
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            CodePageHeaderMark(icon: icon)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let subtitle {
                    subtitleText(subtitle)
                }
            }

            Spacer(minLength: JunoSpace.cozy)

            if let badge {
                Text(badge)
                    .junoCaption()
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.vertical, JunoSpace.hairline)
                    .background(Capsule(style: .continuous).fill(Color.junoMuted))
                    .accessibilityLabel(badge)
            }

            trailing
        }
        .controlSize(.small)
        .padding(.horizontal, JunoSpace.cozy)
        .frame(minHeight: 52)
        .background(Color.junoCanvas)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func subtitleText(_ text: String) -> some View {
        if subtitleIsPath {
            Text(text)
                .junoCodeSmall()
                .junoSecondaryInk()
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        } else {
            Text(text)
                .junoCaption()
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }
}

public extension CodePageHeader where Trailing == EmptyView {
    init(
        icon: JunoIcon,
        title: String,
        subtitle: String? = nil,
        subtitleIsPath: Bool = false,
        badge: String? = nil
    ) {
        self.init(
            icon: icon,
            title: title,
            subtitle: subtitle,
            subtitleIsPath: subtitleIsPath,
            badge: badge
        ) { EmptyView() }
    }
}

/// The mark a page header opens with.
///
/// A quiet tile with the glyph at roughly half its size — the website's own row
/// idiom — rather than a large outline glyph floating in whitespace, which is
/// what made the two headers this replaces read as unfinished placeholders
/// beside a 13pt title.
public struct CodePageHeaderMark: View {
    private let icon: JunoIcon

    public init(icon: JunoIcon) {
        self.icon = icon
    }

    public var body: some View {
        JunoIconView(icon, size: 14)
            .junoSecondaryInk()
            .frame(width: 28, height: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(Color.junoMuted)
            )
            .accessibilityHidden(true)
    }
}
