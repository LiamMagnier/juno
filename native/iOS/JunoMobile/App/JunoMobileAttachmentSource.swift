import JunoDesignSystem
import SwiftUI

/// Which attachment surface the chat is showing.
///
/// One optional value, not a set of booleans. The booleans are what this
/// replaces: `presented`, `pending`, `active`, `showingFullPicker` and a review
/// flag each lived on a different view and could all be true at once, which is
/// how the composer ended up asking for a panel over a picker over a cover —
/// SwiftUI honours the first presentation and silently drops the rest. With one
/// value the invalid states are unrepresentable.
enum JunoAttachmentSurface: String, Identifiable, Hashable, CaseIterable, Sendable {
    case camera
    case photos
    case files

    var id: String { rawValue }

    /// Whether choosing this surface should put the keyboard away first.
    ///
    /// Camera and Photos take the lower half of the screen, so the keyboard has
    /// to go before they arrive or the two fight over the same space for a
    /// frame. The file importer is a system sheet that dismisses it anyway.
    var dismissesKeyboard: Bool {
        switch self {
        case .camera, .photos: true
        case .files: false
        }
    }

    /// Whether this surface is one of Juno's own floating panels — inset from
    /// three edges, over the composer — rather than a system presentation.
    var isFloatingPanel: Bool {
        switch self {
        case .camera, .photos: true
        case .files: false
        }
    }
}

/// The camera panel's own motion. Short, and with almost no bounce: this is a
/// large surface arriving over the reader's conversation, and a spring with
/// character on something that size reads as the app being pleased with itself.
enum JunoCameraMotion {
    static let entry = Animation.snappy(duration: 0.34, extraBounce: 0.02)
    static let exit = Animation.snappy(duration: 0.26)
    /// How long the exit takes, for the one place that must wait for it: handing
    /// off from the camera to the Photos picker.
    static let exitDuration = Duration.milliseconds(260)
}

/// Owns which attachment surface is up, for one chat screen.
///
/// Everything that presents an attachment surface goes through here, which is
/// what makes two of them impossible at once — including the case that used to
/// produce a dropped presentation: a second surface requested while the first
/// is still dismissing.
@MainActor
@Observable
final class JunoMobileAttachmentCoordinator {
    private(set) var surface: JunoAttachmentSurface?
    /// The one line explaining that something chosen could not be read. Shown by
    /// the composer beside the upload model's own errors, because a photo the
    /// picker accepted and the app then dropped in silence is indistinguishable
    /// from a bug.
    private(set) var importError: String?
    /// Set while the camera is animating out and the Photos picker is waiting
    /// its turn, so a tap in that window cannot start a third presentation.
    private var handingOff = false

    var isShowingCamera: Bool { surface == .camera }
    var isShowingPhotos: Bool { surface == .photos }

    /// Whether a floating panel is up. Both panels cover the composer, so both
    /// have to make what is underneath unreachable.
    var isShowingPanel: Bool { surface == .camera || surface == .photos }

    /// `.fileImporter` is an `isPresented:` modifier, so it needs a two-way
    /// `Bool`. Writing `false` is the system telling us the user dismissed it —
    /// which must clear the surface, or the flag goes stale and the next tap on
    /// the same row does nothing.
    var isShowingFiles: Bool {
        get { surface == .files }
        set { newValue ? present(.files, reduceMotion: true) : dismiss(.files) }
    }

    /// Shows `surface`, unless one is already up.
    ///
    /// The guard is the defence against a double tap on a menu row: the second
    /// tap arrives while the first surface is presenting, and without this it
    /// would queue a second presentation of the same picker.
    func present(_ surface: JunoAttachmentSurface, reduceMotion: Bool) {
        guard self.surface == nil, !handingOff else { return }
        guard surface.isFloatingPanel else {
            self.surface = surface
            return
        }
        withAnimation(JunoMotion.reduced(JunoCameraMotion.entry, when: reduceMotion)) {
            self.surface = surface
        }
    }

    /// Dismisses `surface` if it is the one showing. Passing the surface rather
    /// than clearing unconditionally means a late `false` from a picker that has
    /// already been replaced cannot close its successor.
    func dismiss(_ surface: JunoAttachmentSurface) {
        guard self.surface == surface else { return }
        guard surface == .camera else {
            self.surface = nil
            return
        }
        self.surface = nil
    }

    /// Closes a floating panel, animating it out rather than cutting it.
    func dismissPanel(_ panel: JunoAttachmentSurface, reduceMotion: Bool) {
        guard surface == panel, panel.isFloatingPanel else { return }
        withAnimation(JunoMotion.reduced(JunoCameraMotion.exit, when: reduceMotion)) {
            surface = nil
        }
    }

    func dismissCamera(reduceMotion: Bool) {
        dismissPanel(.camera, reduceMotion: reduceMotion)
    }

    /// Some of what the picker returned could not be read — most often an
    /// iCloud asset that has not finished downloading.
    func reportPhotoImportFailure() {
        importError = String(localized: "attachments.photos.load-failed")
    }

    func clearImportError() {
        importError = nil
    }

    /// The camera's library button: put the camera away, *then* present the
    /// system picker.
    ///
    /// Sequential rather than simultaneous. A presentation requested while
    /// another surface is still on screen is the exact failure this coordinator
    /// exists to prevent, so the picker waits for the panel's exit to finish.
    func showPhotosFromCamera(reduceMotion: Bool) {
        guard surface == .camera, !handingOff else { return }
        handingOff = true
        dismissCamera(reduceMotion: reduceMotion)
        Task { @MainActor in
            if !reduceMotion { try? await Task.sleep(for: JunoCameraMotion.exitDuration) }
            handingOff = false
            present(.photos, reduceMotion: reduceMotion)
        }
    }
}
