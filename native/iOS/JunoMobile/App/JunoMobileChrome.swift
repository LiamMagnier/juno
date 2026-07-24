import JunoDesignSystem
import SwiftUI

/// The chrome atoms shared by every screen in the phone app — the glass
/// containers, the card, the section header, and the deliberately-quiet loading
/// placeholder.
///
/// They live in one file because they *are* one decision: Liquid Glass for
/// floating controls, an opaque card for content, and nothing at all while data
/// is on its way.

// MARK: - Loading

/// What a screen shows while its data is still arriving: **nothing**.
///
/// Every list in this app reads from the on-device database first, so the wait
/// is milliseconds in the normal case and only a first-run or a cold sync takes
/// longer. A centred spinner over "Loading projects…" turned that into a full
/// screen of chrome announcing a wait that had usually already ended — and on a
/// phone it read as the app being slow rather than the data being fresh. An
/// empty canvas that fills in is calmer and, at the speeds involved, honest.
///
/// This is not a way to hide failure: every screen still renders its real error
/// and empty states. It only covers the in-between.
struct JunoMobileQuietLoading: View {
    var body: some View {
        Color.junoCanvas
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)
    }
}

// MARK: - Containers

/// A circular Liquid Glass container (OS 26+) with a material fallback, used for
/// the round chrome buttons: sidebar search, profile, sheet close.
struct JunoGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

/// An accent-tinted Liquid Glass capsule (OS 26+) with an opaque accent fallback,
/// used for a screen's one primary action.
struct JunoAccentGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(
                    .regular.tint(Color.junoAccent.opacity(0.72)).interactive(), in: Capsule()
                )
        } else {
            content
                .background(Color.junoAccent.opacity(0.82), in: Capsule())
        }
    }
}

/// A neutral Liquid Glass capsule for a secondary control in a floating row.
struct JunoGlassCapsule: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}

/// A subtle pressed-state wash shared by sidebar and list rows.
struct JunoSidebarPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(configuration.isPressed ? Color.primary.opacity(0.06) : .clear)
            )
    }
}

/// A content card: opaque, one step off the canvas, hairline outlined.
///
/// Content surfaces stay opaque on purpose — glass behind running text is where
/// legibility goes, and the material is reserved for chrome that floats.
struct JunoCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            )
    }
}

/// A page's editorial heading — the serif, as on the web.
struct JunoPageTitle: View {
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .junoPageHeading(compact: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A quiet group label above a run of rows.
struct JunoGroupLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
    }
}

/// The recurring "this went wrong, here is the one thing to do about it" strip.
/// Always carries the server's own sentence — never a generic apology.
struct JunoInlineError: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.caption)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                .fill(Color.orange.opacity(0.10))
        )
        .accessibilityElement(children: .combine)
    }
}

/// A pill that states a live status in one word plus a colour: connected,
/// running, failed. The colour never carries the meaning alone.
struct JunoStatusPill: View {
    let text: String
    let tint: Color
    var filled = true

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(filled ? tint : Color.secondary)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(
                Capsule().fill(filled ? tint.opacity(0.14) : Color.primary.opacity(0.06))
            )
            .accessibilityLabel(text)
    }
}
