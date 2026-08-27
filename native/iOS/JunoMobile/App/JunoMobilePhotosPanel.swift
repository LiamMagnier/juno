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
    /// Called once when the reader confirms the staged selection.
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
                    .onTapGesture(perform: dismiss)
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
        JunoGlass(spacing: JunoSpace.roomy) {
            HStack(spacing: 0) {
                backButton
                Spacer(minLength: 12)
                if selection.isEmpty {
                    allPhotosButton
                } else {
                    confirmButton
                }
            }
        }
        .padding(.horizontal, JunoFloatingPanelMetrics.chromePadding)
        .padding(.bottom, metrics.controlBottomPadding)
    }

    private var grid: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: selectionLimit,
            // Keep the picker in multi-select mode; Juno commits the bound
            // selection explicitly with the glass checkmark below.
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
    ///
    /// `.primary`, not `.white`, and this is one of the few places the *system*
    /// style is right: the glyph sits on untinted `.regular` glass, which
    /// rebalances its own luminosity against whatever photograph is behind it,
    /// and `.primary` is the vibrant label colour that moves with it. A hard
    /// white disappears the moment a pale photograph scrolls under the control.
    /// Juno's absolute inks are for the warm canvas, not for glass.
    private var backButton: some View {
        Button(action: dismiss) {
            JunoIconView(.chevronRight, size: 19)
                .rotationEffect(.degrees(180))
                .foregroundStyle(.primary)
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
    /// The one tinted control on the panel — the back and confirm circles either
    /// side of it are neutral glass, which is what makes this one read as the
    /// primary.
    ///
    /// It used to tint the glass with `Color.junoAccent.opacity(0.5)` and set a
    /// `.white` label, on the reasoning that a half-strength coral let the
    /// photographs behind come through. That reasoning is the bug: `Glass.tint`
    /// honours alpha, so half strength does not soften the coral, it stops the
    /// tint establishing any predictable luminance under the label at all — and
    /// this control floats over an arbitrary grid of photographs, which is the
    /// worst possible backdrop to leave a white label's contrast to. At full
    /// strength `.regular` glass adjusts the background's luminosity to protect
    /// the label, which is the whole reason `.regular` exists.
    private var allPhotosButton: some View {
        Button {
            showingFullLibrary = true
        } label: {
            Text("attachments.photos.all").fontWeight(.semibold)
        }
        .junoProminentAction()
        .controlSize(.large)
        .accessibilityIdentifier("juno.mobile.photos-all")
        .contentShape(.rect)
    }

    /// Confirm the staged selection and return to the composer. The selected
    /// assets are handed to the attachment coordinator only at this point.
    private var confirmButton: some View {
        Button(action: confirmSelection) {
            JunoIconView(.check, size: 19)
                .foregroundStyle(.primary)
                .frame(width: 52, height: 52)
                .junoGlass(in: Circle(), interactive: true)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Confirm photo selection")
        .accessibilityIdentifier("juno.mobile.photos-confirm")
    }

    private func dismiss() {
        selection = []
        showingFullLibrary = false
        close()
    }

    private func confirmSelection() {
        guard !selection.isEmpty else { return }
        let selected = selection
        onPick(selected)
        dismiss()
    }
}

// `JunoPhotosAccentGlass` used to live here — a `.tint(Color.junoAccent.opacity(0.5))`
// capsule, the third of three accent-tinted glass treatments this app carried at
// three different dilutions (0.72 in the chrome, 0.5 here, 0.95/0.32 on the
// composer's send). All three are gone: the primary action on a surface is the
// system's `.glassProminent` at full tint, reached through `junoProminentAction()`.
