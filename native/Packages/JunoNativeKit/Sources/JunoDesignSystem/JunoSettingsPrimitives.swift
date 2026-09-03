import SwiftUI

/// The three pieces every settings surface in the product is built from.
///
/// Settings had drifted into three different designs of the same screen: the
/// website's grid of labelled cards, a seven-tab macOS `Form` of full-width
/// bordered boxes, and an iPhone stack of hand-rolled tiles with its own
/// hard-coded type sizes. The controls agreed; nothing else did.
///
/// These are the shared vocabulary that ends that. The website is the reference
/// — it is the surface the account holder sees most — so the shapes here are its
/// shapes: a card with a quiet monospaced eyebrow instead of a repeated header,
/// and a selectable card instead of a dropdown wherever the whole choice fits on
/// screen at once.

// MARK: - Tile

/// One settings section: a card, an eyebrow, and whatever the section is.
///
/// The eyebrow replaces the header/label pair the macOS build had, where a
/// `Section("Default model")` sat forty points above a `Picker("Default model")`
/// and printed the same two words twice. The card names the section; the control
/// inside it does not need to introduce itself again.
///
/// Mirrors `Tile` in `src/app/(app)/settings/page.tsx` — same 20pt radius, same
/// internal padding, same `flex-col h-full` behaviour so tiles sharing a grid row
/// stretch to equal height and a footer can be pinned to the bottom.
public struct JunoSettingsTile<Content: View>: View {
    private let eyebrow: LocalizedStringKey
    private let content: Content

    public init(_ eyebrow: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.eyebrow = eyebrow
        self.content = content()
    }

    public var body: some View {
        #if os(iOS)
        // On iPhone and iPad, Settings reads as one native grouped document.
        // A card around every section created a second hierarchy on top of the
        // controls' own cards and fields; quiet separators preserve scanning
        // without turning the page into a dashboard.
        contentLayout
            .padding(.vertical, JunoSpace.roomy)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color.junoBorder.opacity(0.72))
                    .frame(height: 0.5)
            }
        #else
        contentLayout
            .padding(JunoSpace.roomy)
            .junoCard(cornerRadius: JunoSettingsMetrics.tileRadius)
        #endif
    }

    private var contentLayout: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text(eyebrow)
                .junoCodeSmall()
                .junoSecondaryInk()
                .textCase(nil)
                .accessibilityAddTraits(.isHeader)
            content
        }
        // `maxHeight: .infinity, alignment: .top` is what makes two tiles in one
        // grid row match heights without the shorter one centring its content.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// The measurements a settings screen shares across both platforms.
public enum JunoSettingsMetrics {
    /// 20 — the website's `rounded-[20px]`. Deliberately larger than
    /// ``JunoRadius/panel``: a settings tile is a bigger, calmer object than an
    /// inspector card, and the web's grid reads that way.
    public static let tileRadius: CGFloat = 20
    /// The reading width of the whole grid. The website clamps settings to
    /// `max-w-4xl`; this is that, in points.
    public static let readingWidth: CGFloat = 880
    /// Below this, the grid collapses to one column. Two columns of settings
    /// controls under ~640pt puts a segmented control and a dropdown in the same
    /// 300pt row, which is where the labels start truncating.
    public static let twoColumnThreshold: CGFloat = 640
}

// MARK: - Choice card

/// One option in a set small enough to show all at once.
///
/// **Why a card and not a menu.** A dropdown hides every option but one, which
/// is the right trade when a list is long (the model catalog, the twenty-two
/// interface locales) and the wrong one when it is six (response style, theme).
/// Six hidden options cost a click to discover and give the reader no way to
/// compare them; six visible cards cost one row of space and explain themselves.
/// This is the rule the website settles on, and these are its cards: an accent
/// border and ring plus a checkmark for the selected one.
public struct JunoChoiceCard<Trailing: View>: View {
    private let title: LocalizedStringKey
    private let detail: LocalizedStringKey?
    private let isSelected: Bool
    private let isEnabled: Bool
    private let trailing: Trailing
    private let select: () -> Void

    public init(
        title: LocalizedStringKey,
        detail: LocalizedStringKey? = nil,
        isSelected: Bool,
        isEnabled: Bool = true,
        @ViewBuilder trailing: () -> Trailing,
        select: @escaping () -> Void
    ) {
        self.title = title
        self.detail = detail
        self.isSelected = isSelected
        self.isEnabled = isEnabled
        self.trailing = trailing()
        self.select = select
    }

    public var body: some View {
        Button(action: select) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                    if let detail {
                        Text(detail)
                            .junoCaption()
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing
                // The checkmark carries the selection for anyone who cannot see
                // the border — a tinted edge alone fails on a monochrome display
                // and under Increase Contrast.
                if isSelected {
                    JunoIconView(.check)
                        .junoFont(size: 11, relativeTo: .caption, weight: .bold)
                        .foregroundStyle(Color.junoAccent)
                        .transition(.junoInline)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.snug + 2)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(isSelected ? Color.junoAccent.opacity(0.06) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(
                        isSelected ? Color.junoAccent : Color.junoBorder,
                        lineWidth: isSelected ? 1.5 : 1
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous))
        }
        .buttonStyle(.junoPress)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        // One radio button to VoiceOver, not "button, Concise, Answer first…":
        // the whole group is a single choice and reads as one.
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

public extension JunoChoiceCard where Trailing == EmptyView {
    init(
        title: LocalizedStringKey,
        detail: LocalizedStringKey? = nil,
        isSelected: Bool,
        isEnabled: Bool = true,
        select: @escaping () -> Void
    ) {
        self.init(
            title: title,
            detail: detail,
            isSelected: isSelected,
            isEnabled: isEnabled,
            trailing: { EmptyView() },
            select: select
        )
    }
}

// MARK: - Response style

/// The six answer styles, with the copy the website uses.
///
/// This table existed twice: once on macOS with the labels and explanations
/// transcribed from `src/lib/personalities.ts`, and once on iOS as a bare array
/// of ids rendered with `.capitalized` — so the phone offered "Socratic" with no
/// hint of what it does, and the two platforms could drift apart silently. One
/// table, both platforms, copy matching the web verbatim.
///
/// `systemPrompt` deliberately does not live here: the server owns what each
/// style means. The client only ever sends the id.
/// The copy is stored as `String`, not `LocalizedStringKey`, and that is not a
/// downgrade: `LocalizedStringKey` is not `Sendable`, so a table that held one
/// could not be `Sendable` — and this table is read from views on two platforms
/// and compared for identity in a `ForEach`. `localizedLabel`/`localizedDetail`
/// re-wrap on the way to a `Text`, which is where localization is actually
/// resolved, so the iPhone still reads the catalog and the Mac (which ships no
/// catalog) still renders the English literal.
public struct JunoResponseStyle: Identifiable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let detail: String

    public var localizedLabel: LocalizedStringKey { LocalizedStringKey(label) }
    public var localizedDetail: LocalizedStringKey { LocalizedStringKey(detail) }

    public init(id: String, label: String, detail: String) {
        self.id = id
        self.label = label
        self.detail = detail
    }

    public static let all: [JunoResponseStyle] = [
        JunoResponseStyle(
            id: "default",
            label: "Default",
            detail: "Juno's natural voice — warm, clear, and adapts to the question."
        ),
        JunoResponseStyle(
            id: "concise",
            label: "Concise",
            detail: "Answer first, no preamble. Expands only when the topic needs it."
        ),
        JunoResponseStyle(
            id: "encouraging",
            label: "Encouraging",
            detail: "Supportive and motivating, without sugar-coating the truth."
        ),
        JunoResponseStyle(
            id: "socratic",
            label: "Socratic",
            detail: "Leads with questions so you reach the answer yourself."
        ),
        JunoResponseStyle(
            id: "formal",
            label: "Formal",
            detail: "Professional register suited to work and formal writing."
        ),
        JunoResponseStyle(
            id: "nerdy",
            label: "Nerdy",
            detail: "Precise and detail-loving, with the mechanism behind the answer."
        ),
    ]

    /// The style with this id, or nil for one this build does not ship.
    ///
    /// Nil rather than a silent fall back to Default: an account set to a style
    /// added by a newer build must keep it, and a picker that quietly renamed it
    /// would write the demotion back on the next layout pass.
    public static func named(_ id: String) -> JunoResponseStyle? {
        all.first { $0.id == id }
    }
}

// MARK: - Preview

#Preview("Settings primitives") {
    ScrollView {
        VStack(spacing: JunoSpace.regular) {
            JunoSettingsTile("Response style") {
                VStack(spacing: JunoSpace.snug) {
                    ForEach(JunoResponseStyle.all) { style in
                        JunoChoiceCard(
                            title: style.localizedLabel,
                            detail: style.localizedDetail,
                            isSelected: style.id == "concise",
                            select: {}
                        )
                    }
                }
            }
            JunoSettingsTile("Memory") {
                Text("A shorter tile, to show the equal-height behaviour.")
                    .junoCaption()
            }
        }
        .frame(maxWidth: JunoSettingsMetrics.readingWidth)
        .padding(JunoSpace.section)
    }
    .background(Color.junoCanvas)
}
