import JunoDesignSystem
import SwiftUI

// The Library and Projects pages' controls, in native Liquid Glass.
//
// The owner's rules for these pages (2026-10-10): every control is a capsule —
// a circle when it is only a glyph — drawn by the system's own glass, the way
// iOS Calendar draws its header. Content (tiles, rows, cards) stays opaque; only
// the things you press are glass.

// MARK: - Segmented

/// A two-to-four-way switch as one glass capsule with a sliding thumb: the
/// Library's All / Images / Documents, and its List / Grid.
///
/// Content-width rather than the stock segmented control's full-width slab, so
/// it can share a row with the sort and the view switch, and the thumb is one
/// view that *moves* between options (`matchedGeometryEffect`) rather than two
/// that cross-fade.
struct JunoMobileCapsuleSegmented<Value: Hashable>: View {
  struct Option: Identifiable {
    let value: Value
    let title: String
    var icon: JunoIcon?
    var count: Int?
    var id: Value { value }

    init(_ value: Value, _ title: String, icon: JunoIcon? = nil, count: Int? = nil) {
      self.value = value
      self.title = title
      self.icon = icon
      self.count = count
    }
  }

  let options: [Option]
  @Binding var selection: Value
  var accessibilityLabel: String
  /// Glyphs only (List / Grid): each option is a circle, its title spoken.
  var iconOnly = false

  @Namespace private var thumb
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GlassEffectContainer {
      HStack(spacing: 0) {
        ForEach(options) { option in
          segment(option)
        }
      }
      .padding(JunoSpace.hairline)
      .glassEffect(.regular.interactive(), in: Capsule())
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilityLabel)
  }

  private func segment(_ option: Option) -> some View {
    let selected = option.value == selection
    return Button {
      withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
        selection = option.value
      }
    } label: {
      HStack(spacing: JunoSpace.tight) {
        if let icon = option.icon {
          JunoIconView(icon, size: 16, isOn: selected)
        }
        if !iconOnly {
          Text(option.title)
            .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
            .lineLimit(1)
          if let count = option.count {
            Text(count, format: .number)
              .junoFont(size: 12, relativeTo: .caption, weight: .medium)
              .monospacedDigit()
              .foregroundStyle(Color.junoSecondaryInk)
          }
        }
      }
      .foregroundStyle(selected ? Color.junoForeground : Color.junoSecondaryInk)
      .padding(.horizontal, iconOnly ? 0 : JunoSpace.cozy)
      .frame(minWidth: JunoMobileCapsuleMetrics.segment, minHeight: JunoMobileCapsuleMetrics.segment)
      .background {
        if selected {
          Capsule(style: .continuous)
            .fill(Color.junoForeground.opacity(0.09))
            .matchedGeometryEffect(id: "thumb", in: thumb)
        }
      }
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(option.count.map { "\(option.title), \($0)" } ?? option.title)
    .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
  }
}

enum JunoMobileCapsuleMetrics {
  /// One segment: the track's hairline inset on each side brings the whole
  /// control to the 44pt touch target.
  static let segment: CGFloat = JunoLayout.touchTarget - JunoSpace.hairline * 2
}

// MARK: - Buttons

extension View {
  /// A secondary action as a glass capsule (Recently deleted, New folder…).
  func junoMobileCapsuleAction(_ size: ControlSize = .large) -> some View {
    buttonStyle(.glass)
      .buttonBorderShape(.capsule)
      .controlSize(size)
  }

  /// The surface's one primary action, accent-tinted glass (Upload, New chat,
  /// New project).
  func junoMobileCapsulePrimary() -> some View {
    buttonStyle(.glassProminent)
      .buttonBorderShape(.capsule)
      .tint(Color.junoAccent)
      .controlSize(.large)
  }

  /// A glyph-only control: a glass circle (sort, more).
  func junoMobileCircleAction() -> some View {
    buttonStyle(.glass)
      .buttonBorderShape(.circle)
      .controlSize(.large)
  }
}

/// A capsule's label: the website glyph and its words at the control gap.
struct JunoMobileCapsuleLabel: View {
  let title: String
  let icon: JunoIcon

  init(_ title: String, icon: JunoIcon) {
    self.title = title
    self.icon = icon
  }

  var body: some View {
    HStack(spacing: JunoLayout.Control.labelGap) {
      JunoIconView(icon, size: 16)
      Text(title)
        .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
        .lineLimit(1)
    }
    .contentShape(Capsule())
  }
}

/// A glass circle's glyph.
struct JunoMobileCircleGlyph: View {
  let icon: JunoIcon
  let label: String

  var body: some View {
    JunoIconView(icon, size: JunoLayout.Control.glyph)
      .frame(width: JunoLayout.Control.glyph, height: JunoLayout.Control.glyph)
      .contentShape(Circle())
      .accessibilityLabel(label)
  }
}

// MARK: - Page heading

/// A page's name in the website's display serif, with one line under it.
///
/// The navigation bar keeps the same title inline — it is what the back button
/// and VoiceOver's screen change read — but shows it only once this heading
/// has scrolled away (``View/junoMobileSerifTitle(_:revealed:)``), so the page
/// opens on the serif and never on two titles at once.
struct JunoMobileSerifHeading: View {
  let caption: String?
  let title: String
  let lede: String?

  init(_ title: String, caption: String? = nil, lede: String? = nil) {
    self.title = title
    self.caption = caption
    self.lede = lede
  }

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.tight) {
      if let caption {
        Text(caption)
          .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          .foregroundStyle(Color.junoSecondaryInk)
      }
      Text(title)
        .junoMobileDisplay(34)
        .lineLimit(3)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      if let lede {
        Text(lede)
          .junoFont(size: 15, relativeTo: .subheadline)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension View {
  /// The bar's inline title, shown only once the serif heading has scrolled
  /// out (`revealed`). See ``JunoMobileSerifHeading``.
  func junoMobileSerifTitle(_ title: String, revealed: Bool) -> some View {
    modifier(JunoMobileSerifTitle(title: title, revealed: revealed))
  }

  /// Reports whether the page has scrolled past its heading block.
  func junoMobileTracksHeading(_ revealed: Binding<Bool>, threshold: CGFloat = JunoSpace.vast * 2) -> some View {
    onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > threshold
    } action: { _, past in
      if revealed.wrappedValue != past { revealed.wrappedValue = past }
    }
  }
}

private struct JunoMobileSerifTitle: ViewModifier {
  let title: String
  let revealed: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          Text(title)
            .font(JunoSerif.font(size: 17, relativeTo: .headline, face: .medium))
            .foregroundStyle(Color.junoForeground)
            .lineLimit(1)
            .opacity(revealed ? 1 : 0)
            .offset(y: revealed || reduceMotion ? 0 : JunoSpace.hairline)
            .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: revealed)
            .accessibilityHidden(!revealed)
        }
      }
  }
}

// MARK: - Section heading

/// A section's heading on these pages: the name, a quiet count, and at most one
/// trailing capsule.
struct JunoMobilePageSectionHeader<Trailing: View>: View {
  let title: String
  var count: Int?
  var identifier: String?
  @ViewBuilder var trailing: () -> Trailing

  init(
    _ title: String,
    count: Int? = nil,
    identifier: String? = nil,
    @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }
  ) {
    self.title = title
    self.count = count
    self.identifier = identifier
    self.trailing = trailing
  }

  var body: some View {
    HStack(alignment: .center, spacing: JunoSpace.snug) {
      HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
        Text(title)
          .junoFont(size: 19, relativeTo: .title3, weight: .semibold)
          .foregroundStyle(Color.junoForeground)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier(identifier ?? "")
        if let count, count > 0 {
          Text(count, format: .number)
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .monospacedDigit()
            .foregroundStyle(Color.junoSecondaryInk)
        }
      }
      Spacer(minLength: 0)
      trailing()
    }
    .frame(minHeight: JunoLayout.touchTarget)
  }
}

// MARK: - Empty states

/// "Nothing here yet", composed: the website's empty mark drawn on, a serif
/// line, one sentence, and the way on. Used where a whole page or a whole
/// section is empty — never a bare line of grey text.
struct JunoMobileComposedEmpty<Actions: View>: View {
  let title: String
  let message: String
  var mark: JunoEmptyMark.Size = .page
  @ViewBuilder var actions: () -> Actions

  init(
    _ title: String,
    message: String,
    mark: JunoEmptyMark.Size = .page,
    @ViewBuilder actions: @escaping () -> Actions = { EmptyView() }
  ) {
    self.title = title
    self.message = message
    self.mark = mark
    self.actions = actions
  }

  var body: some View {
    VStack(spacing: JunoLayout.Empty.markGap) {
      JunoEmptyMark(size: mark)
      VStack(spacing: JunoLayout.Empty.textGap) {
        Text(title)
          .font(JunoSerif.font(size: mark == .page ? 24 : 20, relativeTo: .title2, face: .regular))
          .foregroundStyle(Color.junoForeground)
          .multilineTextAlignment(.center)
        Text(message)
          .junoFont(size: 15, relativeTo: .subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: JunoLayout.Empty.measure)
      HStack(spacing: JunoSpace.snug) {
        actions()
      }
      .padding(.top, JunoSpace.hairline)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, mark == .page ? JunoSpace.expanse : JunoSpace.section)
    .padding(.horizontal, JunoSpace.regular)
    .accessibilityElement(children: .contain)
  }
}
