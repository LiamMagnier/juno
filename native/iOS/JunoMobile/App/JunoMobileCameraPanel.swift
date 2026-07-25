import AVFoundation
import JunoDesignSystem
import SwiftUI
import UIKit

/// The camera panel's geometry.
///
/// A value type with no view in it, so the two properties that are easy to get
/// wrong by eye — that the visible margin is the *same* on all three open edges,
/// and that the corner is concentric with the one the phone is cut to — are
/// arithmetic that a test can check.
enum JunoScreenInsets {
    /// The home-indicator inset, read from the window.
    ///
    /// Not from a `GeometryProxy`: a proxy inside `.ignoresSafeArea()` reports
    /// **zero** insets, because the view it describes no longer has a safe area.
    /// Both panels were built on that assumption and both were wrong — a phone
    /// with a rounded display was being treated as a square-cornered one, so the
    /// corner came out at 18pt instead of 43 and the controls sat 22pt lower
    /// than intended.
    @MainActor
    static var bottom: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets.bottom ?? 0
    }
}

struct JunoFloatingPanelMetrics: Equatable, Sendable {
    /// The one visible outer margin. Leading, trailing and bottom are all this
    /// number, and there is deliberately no second token for any of them: three
    /// separate constants is how a panel ends up 16 from one edge and 8 from
    /// another, which reads as a mistake even to someone not looking for it.
    static let panelInset: CGFloat = 12
    /// Where the panel's top edge sits, as a fraction of the screen. The chat
    /// header and the top of the conversation stay above it.
    static let topFraction: CGFloat = 0.41
    /// The gap between the panel's edge and the chrome floating inside it.
    static let chromePadding: CGFloat = 14

    let size: CGSize
    let bottomSafeArea: CGFloat

    var inset: CGFloat { Self.panelInset }
    var width: CGFloat { max(size.width - inset * 2, 0) }
    /// The lower ~59% of the screen, less the bottom margin — so the top edge
    /// lands exactly on `topFraction` whatever the screen is.
    var height: CGFloat { max(size.height * (1 - Self.topFraction) - inset, 0) }

    /// The display's own corner radius.
    ///
    /// Not read from `_displayCornerRadius` — that is a private API, and an app
    /// that ships against it breaks on the OS release that renames it. Derived
    /// instead from what the layout can already see: a device that reserves
    /// space at the bottom of the screen has a rounded display and a home
    /// indicator; one that does not has square-ish corners and a button.
    ///
    /// 62 is the current generation's radius (it was 55 through the iPhone 15
    /// Pro). The number only has to be close, because what the eye checks is
    /// that the panel's corner and the screen's corner *curve together* — and
    /// erring large is the safer error: a panel slightly rounder than its screen
    /// reads as deliberate, while one slightly tighter reads as a rectangle that
    /// missed.
    var displayCornerRadius: CGFloat { bottomSafeArea > 0 ? 62 : 20 }

    /// Concentric with the display: inset by the margin, so the two curves stay
    /// parallel instead of one tightening inside the other.
    var cornerRadius: CGFloat { max(displayCornerRadius - inset, 18) }

    /// The radius a surface nested `padding` inside the panel needs to stay
    /// concentric with it.
    func nestedCornerRadius(padding: CGFloat) -> CGFloat { max(cornerRadius - padding, 6) }

    /// Lifts the controls clear of the home indicator without breaking the equal
    /// outer margin: the panel's bottom edge stays `inset` from the screen, and
    /// the *controls* move up instead.
    var controlBottomPadding: CGFloat { max(bottomSafeArea - inset, 0) + 18 }

    /// Where the panel's top edge actually lands. Exposed for tests.
    var resolvedTopFraction: CGFloat {
        guard size.height > 0 else { return 0 }
        return (size.height - inset - height) / size.height
    }
}

/// Juno's camera: a floating panel over the lower half of the chat, not a
/// full-screen modal.
///
/// **Why it is a panel.** The conversation is the context for the photo. A
/// full-screen camera takes that away for the duration and gives the reader a
/// second app to get out of; a panel keeps the header and the transcript above
/// it and reads as one step in composing a message. It covers the composer while
/// it is open, and it is a sibling *above* it in the stack rather than something
/// drawn inside it — a camera that a text field can lie on top of is a bug
/// waiting for a long message.
struct JunoMobileCameraPanel: View {
    /// False once the message is holding the maximum number of attachments.
    var canAttach: Bool = true
    let onCapture: (JunoPickedFile) -> Void
    let openPhotos: () -> Void
    let close: () -> Void

    @State private var camera = JunoCameraPanelModel()
    /// Follows the finger during a downward drag. Only ever ≥ 0.
    @State private var dragTranslation: CGFloat = 0
    @State private var flashing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let metrics = JunoFloatingPanelMetrics(
                size: proxy.size, bottomSafeArea: JunoScreenInsets.bottom
            )
            panel(metrics)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, metrics.inset)
                .offset(y: dragTranslation)
        }
        // The panel is measured against the screen, not against the chat's
        // layout area: its margins are screen-edge margins, and the keyboard
        // must not be able to move it while it is on its way out.
        .ignoresSafeArea()
        // Deliberately no identifier on the panel itself. An
        // `accessibilityIdentifier` on a container is inherited by every
        // element inside it, so one here renamed the shutter, the preview and
        // the close button to "juno.mobile.camera-panel" — the panel became
        // findable and everything in it stopped being. The close control is
        // always present, so it is what a test waits for.
        .task { await camera.start() }
        // The session is stopped only once this view is actually gone, so the
        // exit animation plays over a live preview rather than a frozen frame.
        .onDisappear { camera.stop() }
    }

    // MARK: Panel

    private func panel(_ metrics: JunoFloatingPanelMetrics) -> some View {
        let shape = RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous)
        return ZStack {
            surface(metrics)
            if flashing {
                Color.white.clipShape(ContainerRelativeShape())
            }
            chrome(metrics)
        }
        .frame(width: metrics.width, height: metrics.height)
        .clipShape(shape)
        // Everything nested inside can now ask for the panel's own curve rather
        // than repeating a number that would drift the moment this one is tuned.
        .containerShape(shape)
        .shadow(color: .black.opacity(0.26), radius: 26, y: 10)
    }

    /// The live preview, or the calm surface that stands in for it when there is
    /// no camera to show.
    @ViewBuilder
    private func surface(_ metrics: JunoFloatingPanelMetrics) -> some View {
        if camera.unavailability == nil {
            ZStack {
                // Behind the preview, so the first frames fade in over something
                // rather than over the transcript.
                Color.black
                JunoCameraPreview(session: camera.session)
                    .opacity(camera.isRunning ? 1 : 0)
                    .animation(
                        JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
                        value: camera.isRunning
                    )
                    .accessibilityIdentifier("juno.mobile.camera-preview")
                    .accessibilityLabel("attachments.camera")
            }
            .clipShape(ContainerRelativeShape())
            .contentShape(ContainerRelativeShape())
            // The drag lives on the preview, not on the panel: a drag that
            // started on the shutter or the library button would otherwise move
            // the whole surface out from under the control being pressed.
            .gesture(dismissDrag(metrics))
        } else {
            Color.junoSurface.clipShape(ContainerRelativeShape())
        }
    }

    @ViewBuilder
    private func chrome(_ metrics: JunoFloatingPanelMetrics) -> some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: 0)
            if let reason = camera.unavailability {
                unavailable(reason, metrics)
                Spacer(minLength: 0)
            } else {
                controls(metrics)
            }
        }
    }

    /// One control: close. Flash and the camera swap live under the ellipsis,
    /// where they are reachable without putting three glyphs across the top of
    /// the picture.
    private var topBar: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    // White over the picture, ink over the surface that stands
                    // in for it: a white glyph on the unavailable card is a
                    // close button nobody can see.
                    .foregroundStyle(camera.unavailability == nil ? AnyShapeStyle(.white)
                        : AnyShapeStyle(.primary))
                    .frame(width: 38, height: 38)
                    .junoGlass(in: Circle(), interactive: true)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("attachments.camera.close")
            .accessibilityIdentifier("juno.mobile.camera-close")
        }
        .padding(JunoFloatingPanelMetrics.chromePadding)
    }

    // MARK: Controls

    /// Library · shutter · more.
    ///
    /// The shutter is centred in the panel rather than between its two
    /// neighbours — and because the panel's leading and trailing margins are the
    /// same number, the panel's centre *is* the screen's centre. Sizing it
    /// between the side controls instead would put it wherever their widths
    /// happened to leave it.
    private func controls(_ metrics: JunoFloatingPanelMetrics) -> some View {
        JunoGlass(spacing: 24) {
            ZStack {
                HStack(spacing: 0) {
                    libraryButton
                    Spacer(minLength: 0)
                    moreButton
                }
                shutter
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, metrics.controlBottomPadding)
    }

    private var libraryButton: some View {
        Button(action: openPhotos) {
            Group {
                if let image = camera.lastCapture {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: Self.sideControlSize, height: Self.sideControlSize)
                        .clipShape(Circle())
                } else {
                    Image(systemName: "photo.on.rectangle")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: Self.sideControlSize, height: Self.sideControlSize)
                }
            }
            .junoGlass(in: Circle(), interactive: true)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: camera.lastCapture
        )
        .accessibilityLabel("attachments.photos")
        .accessibilityIdentifier("juno.mobile.camera-library")
    }

    /// The camera's other controls — flash and the front/back swap. Both already
    /// existed on the camera this panel replaces; nothing has been invented to
    /// fill the button, and it is disabled outright on hardware that offers
    /// neither.
    private var moreButton: some View {
        Menu {
            if camera.capabilities.hasFlash {
                Picker(selection: flashBinding) {
                    ForEach(JunoCameraFlashMode.allCases, id: \.self) { mode in
                        Label {
                            Text(mode.label)
                        } icon: {
                            Image(systemName: mode.symbolName)
                        }
                        .tag(mode)
                    }
                } label: {
                    Label("attachments.camera.flash", systemImage: camera.flashMode.symbolName)
                }
            }
            if camera.capabilities.canFlip {
                Button {
                    Task { await camera.flip() }
                } label: {
                    Label("attachments.camera.flip", systemImage: "arrow.triangle.2.circlepath")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: Self.sideControlSize, height: Self.sideControlSize)
                .junoGlass(in: Circle(), interactive: true)
                .contentShape(Circle())
        }
        .menuOrder(.fixed)
        .disabled(!hasMoreControls)
        .opacity(hasMoreControls ? 1 : 0.4)
        .accessibilityLabel("attachments.camera.more")
        .accessibilityIdentifier("juno.mobile.camera-more")
    }

    private var shutter: some View {
        Button(action: capture) {
            Circle()
                .fill(.clear)
                .frame(width: 76, height: 76)
                .junoGlass(in: Circle(), interactive: true)
                .overlay {
                    Circle()
                        .fill(.white)
                        // The hairline is what keeps the disc a disc. Over a
                        // dark scene the glass ring around it renders pale, and
                        // without this the two whites merge into one blob.
                        .overlay(Circle().strokeBorder(.black.opacity(0.16), lineWidth: 1))
                        .frame(width: 62, height: 62)
                }
                .contentShape(Circle())
        }
        .buttonStyle(JunoShutterPressStyle())
        .disabled(!camera.isRunning || camera.isCapturing || !canAttach)
        .accessibilityLabel("attachments.camera.shutter")
        .accessibilityIdentifier("juno.mobile.camera-shutter")
    }

    private static let sideControlSize: CGFloat = 52

    private var hasMoreControls: Bool {
        camera.capabilities.hasFlash || camera.capabilities.canFlip
    }

    private var flashBinding: Binding<JunoCameraFlashMode> {
        Binding(get: { camera.flashMode }, set: { camera.flashMode = $0 })
    }

    // MARK: Unavailable

    private func unavailable(
        _ reason: JunoCameraUnavailability, _ metrics: JunoFloatingPanelMetrics
    ) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill")
                .font(.system(size: 30))
                .foregroundStyle(.secondary)
            Text(reason.message)
                .font(.callout)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                if reason.isRecoverableInSettings,
                    let url = URL(string: UIApplication.openSettingsURLString) {
                    Link(destination: url) {
                        Text("attachments.camera.open-settings")
                            .font(.system(size: 16, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                }
                Button("attachments.camera.close", action: close)
                    .buttonStyle(.bordered)
            }
            .tint(Color.junoAccent)
        }
        .padding(26)
        .frame(maxWidth: .infinity)
        // Concentric with the panel it sits in: inner radius = outer radius less
        // the gap between them. A card with its own unrelated corner inside a
        // panel is the thing that makes nested surfaces look pasted on.
        .background(
            RoundedRectangle(
                cornerRadius: metrics.nestedCornerRadius(
                    padding: JunoFloatingPanelMetrics.chromePadding
                ),
                style: .continuous
            )
            .fill(Color.junoCanvas)
        )
        .padding(.horizontal, JunoFloatingPanelMetrics.chromePadding)
        .accessibilityIdentifier("juno.mobile.camera-unavailable")
    }

    // MARK: Actions

    private func capture() {
        guard canAttach else { return }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        // Opacity, not movement, so it stays truthful under Reduce Motion: a
        // capture with no acknowledgement reads as a control that did nothing,
        // on the one control where that doubt makes people press twice.
        withAnimation(.easeOut(duration: 0.06)) { flashing = true }
        Task {
            let file = await camera.capture()
            withAnimation(.easeIn(duration: 0.16)) { flashing = false }
            guard let file else { return }
            onCapture(file)
        }
    }

    /// Downward drag to dismiss: the panel follows the finger, and goes only if
    /// it was thrown or taken far enough. Anything less springs back, so a
    /// mis-swipe while framing a shot never costs the session.
    private func dismissDrag(_ metrics: JunoFloatingPanelMetrics) -> some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { value in
                dragTranslation = max(0, value.translation.height)
            }
            .onEnded { value in
                let travelled = max(0, value.translation.height)
                let velocity = value.predictedEndTranslation.height - value.translation.height
                if travelled > metrics.height * 0.22 || velocity > 260 {
                    close()
                } else {
                    withAnimation(JunoMotion.reduced(JunoMotion.spring, when: reduceMotion)) {
                        dragTranslation = 0
                    }
                }
            }
    }
}

/// The shutter's press feedback — a small inward scale, nothing more. A ripple
/// or a colour change on the one white control over a live preview would read as
/// the preview changing.
struct JunoShutterPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.snappy(duration: 0.12), value: configuration.isPressed)
    }
}

/// The panel's arrival and departure: up from just below its resting place, from
/// a hair under full size, fading in. Restrained on purpose — a large surface
/// that bounces reads as theatre.
struct JunoFloatingPanelTransition: ViewModifier {
    var offset: CGFloat
    var scale: CGFloat
    var opacity: Double

    func body(content: Content) -> some View {
        content
            .scaleEffect(scale, anchor: .bottom)
            .offset(y: offset)
            .opacity(opacity)
    }
}

extension AnyTransition {
    /// Under Reduce Motion this collapses to a crossfade: no travel, no scale.
    static func junoFloatingPanel(reduceMotion: Bool) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .modifier(
            active: JunoFloatingPanelTransition(offset: 26, scale: 0.96, opacity: 0),
            identity: JunoFloatingPanelTransition(offset: 0, scale: 1, opacity: 1)
        )
    }
}
