import JunoDesignSystem
import SwiftUI

// The phone's shell, redesigned against the ChatGPT iOS app (Oct 2026).
//
// Three pieces live here because they are the frame every other screen sits
// in: the push drawer that holds the sidebar under the conversation, the two
// glyphs the top bar is made of (the sidebar mark and the private-chat mark),
// and the Chat | Code switch in the middle of the bar.
//
// What it replaced: a four-tab bar (Chat / Crew / Code / Search) with red count
// badges, a "runs in progress" capsule over it, and a conversation list that
// arrived as a sheet. Everything those reached is now in the drawer.

// MARK: - Push drawer

/// The sidebar under the conversation, revealed by pushing the conversation
/// to the right — the ChatGPT gesture.
///
/// **Interactive, not a toggle.** A drag from the leading edge (or anywhere on
/// the pushed conversation while open) moves the conversation with the finger;
/// letting go settles open or closed from where the finger was *heading*, not
/// only from where it stopped, so a short flick opens it and a short flick back
/// closes it. The settle is ``JunoMotion/drawerSettle``, an interactive spring
/// that carries the fling into the landing.
///
/// While open, the pushed conversation stays visible as a rounded card at the
/// trailing edge, dims slightly, and takes a tap anywhere as "close". Under
/// Reduce Motion the drawer still opens and closes — the travel becomes a short
/// cross-fade of the dim and the card snaps.
struct JunoMobilePushDrawer<Sidebar: View, Content: View>: View {
  @Binding var isOpen: Bool
  /// Off while a destination is pushed on the stack: the leading edge then
  /// belongs to the system's back swipe, exactly as it does in ChatGPT.
  var edgeSwipeEnabled: Bool = true
  @ViewBuilder var sidebar: () -> Sidebar
  @ViewBuilder var content: () -> Content

  @State private var drag: CGFloat = 0
  @State private var dragging = false
  @State private var openHaptic = JunoMobileHapticTrigger()
  /// The window's container insets (status bar, home indicator), measured
  /// outside the full-bleed frame and handed back to both columns as safe-area
  /// padding — so the pushed card can round the screen's own corners while the
  /// navigation bar and the composer still sit where the system puts them.
  @State private var insets = EdgeInsets()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme

  /// How far the conversation travels: most of the screen, so its edge stays
  /// in view as the "way back", and never wider than a comfortable column.
  private func width(in size: CGSize) -> CGFloat {
    min(size.width * 0.84, 360)
  }

  var body: some View {
    GeometryReader { proxy in
      let full = width(in: proxy.size)
      let resting: CGFloat = isOpen ? full : 0
      let offset = min(max(resting + drag, 0), full)
      let progress = full > 0 ? offset / full : 0

      ZStack(alignment: .leading) {
        sidebar()
          .safeAreaPadding(.top, insets.top)
          .safeAreaPadding(.bottom, insets.bottom)
          .frame(width: full)
          .frame(maxHeight: .infinity)
          // A short parallax: the sidebar starts a little behind and slides
          // the last quarter of the way as the conversation leaves.
          .offset(x: reduceMotion ? 0 : -full * 0.22 * (1 - progress))
          .opacity(reduceMotion ? (progress > 0.01 ? 1 : 0) : 1)
          .environment(\.junoMobileDrawerOpen, isOpen || dragging)
          .accessibilityHidden(!isOpen)
          .allowsHitTesting(isOpen && !dragging)

        content()
          .safeAreaPadding(.top, insets.top)
          .safeAreaPadding(.bottom, insets.bottom)
          .frame(width: proxy.size.width, height: proxy.size.height)
          .overlay {
            // The dim and the tap-to-close catcher, one layer.
            Color.black
              .opacity((colorScheme == .dark ? 0.32 : 0.05) * progress)
              .allowsHitTesting(isOpen)
              .contentShape(.rect)
              .onTapGesture { setOpen(false) }
              .accessibilityHidden(true)
          }
          .clipShape(.rect(cornerRadius: 34 * progress, style: .continuous))
          .shadow(
            color: .black.opacity((colorScheme == .dark ? 0 : 0.10) * progress),
            radius: 18, x: -2, y: 0
          )
          .offset(x: offset)
          .allowsHitTesting(!dragging)
      }
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
      // The leading edge strip: where a closed drawer is pulled open from.
      .overlay(alignment: .leading) {
        if !isOpen, edgeSwipeEnabled {
          // Below the bar, so the strip never sits over the sidebar
          // button's own glass and steals its taps.
          Color.clear
            .frame(width: 22)
            .contentShape(.rect)
            .gesture(dragGesture(full: full))
            .padding(.top, insets.top + 64)
            .accessibilityHidden(true)
        }
      }
      // While open, the whole conversation card is a handle to push it back.
      .simultaneousGesture(isOpen ? dragGesture(full: full) : nil)
    }
    // Full bleed, so the pushed card's rounded corners reach the screen's own;
    // every child still receives the safe area and the keyboard inset.
    .ignoresSafeArea(.container)
    .background {
      GeometryReader { measured in
        Color.clear
          .onAppear { insets = measured.safeAreaInsets }
          .onChange(of: measured.safeAreaInsets) { _, new in insets = new }
      }
      .ignoresSafeArea(.keyboard)
    }
    .junoHaptic(JunoMobileHaptic.selection, trigger: openHaptic)
    .onChange(of: isOpen) { _, _ in openHaptic.fire() }
  }

  private func dragGesture(full: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 8, coordinateSpace: .global)
      .onChanged { value in
        // Horizontal intent only; a vertical scroll on the open card must
        // not nudge the drawer.
        guard abs(value.translation.width) > abs(value.translation.height) || dragging else {
          return
        }
        dragging = true
        drag = value.translation.width
      }
      .onEnded { value in
        guard dragging else { return }
        let resting: CGFloat = isOpen ? full : 0
        let predicted = resting + value.predictedEndTranslation.width
        let shouldOpen = predicted > full / 2
        dragging = false
        withAnimation(JunoMotion.reduced(JunoMotion.drawerSettle, when: reduceMotion)) {
          drag = 0
          isOpen = shouldOpen
        }
      }
  }

  private func setOpen(_ open: Bool) {
    withAnimation(JunoMotion.reduced(JunoMotion.drawerSettle, when: reduceMotion)) {
      isOpen = open
    }
  }
}

// MARK: - Top bar glyphs

/// The sidebar mark: the website's own panel glyph (`AppIcons` /
/// `PanelLeft`), the one the web's collapse button and command palette draw.
struct JunoMobileSidebarGlyph: View {
  var body: some View {
    JunoIconView(.panelLeft, size: 20)
      .accessibilityHidden(true)
  }
}

/// The private-chat toggle's face: the website's ghost — outlined while off,
/// solid once the chat is private. The same control in both states, so
/// turning it on reads as the button changing rather than a new button.
struct JunoMobileTemporaryChatGlyph: View {
  let active: Bool

  var body: some View {
    JunoIconView(.privateChat, size: 20, isOn: active)
      .contentTransition(.opacity)
      .frame(width: 24, height: 24)
      .accessibilityHidden(true)
  }
}

// MARK: - Chat | Code

/// The two products, as the bar's centre: a system segmented control, which
/// the OS 26 toolbar draws as one Liquid Glass capsule with a lit segment — no
/// hand-built knob, no custom blur.
struct JunoMobileProductSwitch: View {
  @Binding var selection: JunoMobileSection
  @State private var haptic = JunoMobileHapticTrigger()

  var body: some View {
    Picker("Product", selection: productBinding) {
      Text("Chat").tag(JunoMobileSection.chat)
      Text("Code").tag(JunoMobileSection.code)
    }
    .pickerStyle(.segmented)
    .fixedSize()
    .junoHaptic(JunoMobileHaptic.selection, trigger: haptic)
    .accessibilityIdentifier("juno.mobile.product-switch")
  }

  private var productBinding: Binding<JunoMobileSection> {
    Binding(
      get: { selection == .code ? .code : .chat },
      set: { newValue in
        guard newValue != selection else { return }
        haptic.fire()
        selection = newValue
      }
    )
  }
}

/// The press every quiet tappable in the redesigned chrome shares: scale 0.97
/// and 85% opacity over the 120ms press rung; opacity only under Reduce Motion.
struct JunoMobileQuietPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    Pressed(pressed: configuration.isPressed, label: configuration.label)
  }

  private struct Pressed: View {
    let pressed: Bool
    let label: ButtonStyleConfiguration.Label
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      label
        .scaleEffect(pressed && !reduceMotion ? 0.97 : 1)
        .opacity(pressed ? 0.85 : 1)
        .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion, tier: .tint), value: pressed)
    }
  }
}

extension ButtonStyle where Self == JunoMobileQuietPressStyle {
  static var junoQuietPress: JunoMobileQuietPressStyle { JunoMobileQuietPressStyle() }
}

/// The drawer's ground: the canvas in light, one step up from the black canvas
/// in dark — so the pushed conversation still reads as a card against it.
struct JunoMobileDrawerGround: View {

  var body: some View {
    // One step off the canvas in both appearances — ChatGPT's #F9F9F9 under
    // its white card — so the pushed conversation reads as a sheet of paper
    // on the drawer, not as more of the same white.
    Color.junoSurface
  }
}
