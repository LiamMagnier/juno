import JunoDesignSystem
import PhotosUI
import SwiftUI

/// The photo library as a floating panel over the lower part of the chat —
/// the same surface the camera uses, with Apple's own grid inside it.
///
/// **Why it is not a sheet.** A sheet is a page: it arrives with a header, a
/// grabber, a title, a confirm button and a set of margins that are not ours,
/// and it reads as leaving the conversation to go and do something else.
/// Choosing a photo is a step *in* composing a message, so it gets the shape
/// the camera gets — a panel inset equally from three edges, cut to the
/// phone's own corner, floating over the composer with the conversation still
/// visible above it.
///
/// **And the grid inside it is still Apple's.** `photosPickerStyle(.inline)` is
/// the picker's embeddable mode: the same component, given a size instead of
/// taking the screen. Nothing here draws a photo, decides what a thumbnail
/// looks like, or asks for photo-library permission — the picker returns only
/// what was chosen, which is why it needs none.
///
/// Its accessories are hidden on purpose. The bar, the staging tray and the
/// "Select Photos" button are what make it look like a page; without them the
/// grid runs edge to edge and the only control left is the one the design asks
/// for — All Photos, in the corner, in real glass.
struct JunoMobilePhotosPanel: View {
    let selectionLimit: Int
    /// Called as each photo is chosen, so a picked photo is on its way to the
    /// server before the panel is even closed.
    let onPick: ([PhotosPickerItem]) -> Void
    let close: () -> Void

    @State private var selection: [PhotosPickerItem] = []
    @State private var showingFullLibrary = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let metrics = JunoFloatingPanelMetrics(
                size: proxy.size, bottomSafeArea: JunoScreenInsets.bottom
            )
            ZStack(alignment: .bottom) {
                // Above the panel the conversation is still live to look at, and
                // a tap up there is how the panel goes away. Invisible rather
                // than dim: dimming the chat to choose a photo would make this a
                // heavier moment than it is.
                Color.black.opacity(0.001)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)
                    .accessibilityLabel("attachments.photos.close")
                    .accessibilityAddTraits(.isButton)

                panel(metrics)
                    .frame(width: metrics.width, height: metrics.height)
                    .padding(.bottom, metrics.inset)
            }
        }
        // Measured against the screen, not the chat's layout area: the margins
        // are screen-edge margins.
        .ignoresSafeArea()
        // The full library, handed off to the system's own presentation. This is
        // the one place a full-height picker is right — it is what "All Photos"
        // means.
        .photosPicker(
            isPresented: $showingFullLibrary,
            selection: $selection,
            maxSelectionCount: selectionLimit,
            selectionBehavior: .ordered,
            matching: .images,
            preferredItemEncoding: .current,
            photoLibrary: .shared()
        )
        .onChange(of: selection) { _, items in
            guard !items.isEmpty else { return }
            // Cleared immediately so choosing the same photo twice still
            // registers as a change.
            selection = []
            onPick(items)
        }
    }

    private func panel(_ metrics: JunoFloatingPanelMetrics) -> some View {
        let shape = RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous)
        return ZStack(alignment: .bottom) {
            grid
            controls(metrics)
        }
        .clipShape(shape)
        .containerShape(shape)
        .shadow(color: .black.opacity(0.26), radius: 26, y: 10)
    }

    /// Back on the leading edge where a thumb is, All Photos opposite it. Both
    /// sit on the same line and clear the home indicator by the same amount as
    /// the camera's controls, because they are the same row in the same panel.
    private func controls(_ metrics: JunoFloatingPanelMetrics) -> some View {
        JunoGlass(spacing: 20) {
            HStack(spacing: 0) {
                backButton
                Spacer(minLength: 12)
                allPhotosButton
            }
        }
        .padding(.horizontal, JunoFloatingPanelMetrics.chromePadding)
        .padding(.bottom, metrics.controlBottomPadding)
    }

    private var grid: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: selectionLimit,
            // Continuous: with no confirm button there is nothing to press to
            // finish, so each photo is attached as it is tapped — and the
            // picker's own checkmarks are what say so.
            selectionBehavior: .continuousAndOrdered,
            // Images only: the server's accepted set is images and documents, so
            // offering video would mean letting someone choose a file that can
            // only be rejected afterwards.
            matching: .images,
            // The original asset — HEIC included. The transcode happens on this
            // device, which is why the server never has to decode it.
            preferredItemEncoding: .current,
            photoLibrary: .shared()
        ) {
            // Never drawn: inline *is* the presentation.
            EmptyView()
        }
        .photosPickerStyle(.inline)
        .photosPickerAccessoryVisibility(.hidden, edges: .all)
        // What is left is a grid: no staging tray, no selection actions, no
        // album chrome and no search field — the panel is not a page.
        .photosPickerDisabledCapabilities([
            .stagingArea, .selectionActions, .collectionNavigation, .search,
        ])
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.junoSurface)
        .accessibilityIdentifier("juno.mobile.photos-grid")
    }

    /// Out, without choosing anything.
    private var backButton: some View {
        Button(action: close) {
            Image(systemName: "chevron.left")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 52, height: 52)
                .junoGlass(in: Circle(), interactive: true)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("attachments.photos.close")
        .accessibilityIdentifier("juno.mobile.photos-back")
    }

    /// The whole library, when the recents the grid opens on are not enough.
    ///
    /// Coral through glass rather than on top of it: the tint is half strength,
    /// so the photographs behind still come through and it reads as the one
    /// *lit* control on the panel rather than as a solid button dropped onto a
    /// picture. Full-strength accent here would be a third opaque rectangle in a
    /// grid of them.
    private var allPhotosButton: some View {
        Button {
            showingFullLibrary = true
        } label: {
            Text("attachments.photos.all")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 22)
                .frame(height: 52)
                .modifier(JunoPhotosAccentGlass())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.mobile.photos-all")
    }
}

/// Half-tinted Liquid Glass: enough coral to be Juno's, clear enough to still be
/// glass. Falls back to a translucent accent fill below OS 26.
private struct JunoPhotosAccentGlass: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                .regular.tint(Color.junoAccent.opacity(0.5)).interactive(), in: Capsule()
            )
        } else {
            content.background(Color.junoAccent.opacity(0.62), in: Capsule())
        }
    }
}
