import SwiftUI

/// What a glyph does under the pointer: the native projection of the web's
/// hover articulation (`juno-icons/icons.css`, "Hover articulation"), so a
/// row on the Mac and the same row in the browser answer the pointer with the
/// same small gesture.
///
/// One gesture per glyph, chosen by what the glyph *is* rather than where it
/// is drawn (``forIcon(_:)``): an arrow goes where it points, a plus turns
/// toward a close, a gear turns, a pencil or a lens is picked up and tilted, a
/// book or a sheet lifts off its surface, a mark you set pops. Most glyphs
/// have one; carets, spinners and status marks have none.
///
/// Played on ``JunoMotion/articulate`` (the web's 220ms on `--ease-out-back`,
/// a ~3% settle) and only while a fine pointer hovers: never on keyboard
/// focus, never under Reduce Motion, where the glyph holds its rest pose.
public enum JunoIconGesture: Equatable, Sendable {
    case none
    /// Picked up: a lens, a pencil, a pin, a key. Degrees, counter-clockwise negative.
    case tilt(Double)
    /// Lifted off the surface: a book, a sheet, a folder, a stack.
    case lift
    /// The action goes where the arrow points (x, y in points).
    case nudge(CGFloat, CGFloat)
    /// A plus turning toward a close, a gear turning. Degrees.
    case turn(Double)
    /// A mark you set: a star, a sparkle, a bell's attention.
    case pop

    /// The gesture the web gives the same drawing (drawings.ts `hover`), at
    /// the Mac's optical size.
    public static func forIcon(_ icon: JunoIcon) -> JunoIconGesture {
        switch icon {
        case .search, .fileSearch, .binoculars:
            return .tilt(-14)
        case .newChat, .compose, .edit, .pencil, .penTool, .writing:
            return .tilt(-10)
        case .pin, .key, .link, .mic, .attach, .paperclip, .thumbsUp, .thumbsDown, .tools:
            return .tilt(-12)
        case .library, .knowledge, .artifacts, .files, .file, .copy, .archive, .squareStack, .layers,
             .projects, .folderPlus, .delete, .trash, .box, .memory:
            return .lift
        case .plus, .new, .filePlus, .listPlus:
            return .turn(90)
        case .settings, .general, .sun:
            return .turn(60)
        case .refresh, .rotateCcw, .undo, .history:
            return .turn(-40)
        case .arrowRight, .chevronRight, .send, .externalLink, .external, .logOut:
            return .nudge(2, 0)
        case .arrowLeft, .chevronLeft:
            return .nudge(-2, 0)
        case .arrowUp, .upload:
            return .nudge(0, -2)
        case .arrowDown, .download:
            return .nudge(0, 2)
        case .star, .sparkles, .bell, .notifications, .play, .flag:
            return .pop
        case .sliders, .parameters, .personalization, .appearance:
            return .nudge(1.5, 0)
        default:
            return .none
        }
    }
}

private struct JunoIconGestureModifier: ViewModifier {
    let gesture: JunoIconGesture
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let on = active && !reduceMotion
        content
            .rotationEffect(.degrees(on ? rotation : 0))
            .offset(x: on ? offset.width : 0, y: on ? offset.height : 0)
            .scaleEffect(on ? scale : 1)
            .animation(reduceMotion ? nil : (on ? JunoMotion.articulate : JunoMotion.exit), value: on)
    }

    private var rotation: Double {
        switch gesture {
        case .tilt(let d), .turn(let d): return d
        case .lift: return -4
        default: return 0
        }
    }

    private var offset: CGSize {
        switch gesture {
        case .lift: return CGSize(width: 0, height: -1.5)
        case .nudge(let x, let y): return CGSize(width: x, height: y)
        default: return .zero
        }
    }

    private var scale: CGFloat {
        gesture == .pop ? 1.14 : 1
    }
}

public extension View {
    /// Plays `gesture` while `active` (the row or button around the glyph is
    /// hovered). See ``JunoIconGesture``.
    func junoIconGesture(_ gesture: JunoIconGesture, active: Bool) -> some View {
        modifier(JunoIconGestureModifier(gesture: gesture, active: active))
    }

    /// The glyph's own gesture, from ``JunoIconGesture/forIcon(_:)``.
    func junoIconGesture(for icon: JunoIcon, active: Bool) -> some View {
        modifier(JunoIconGestureModifier(gesture: .forIcon(icon), active: active))
    }
}

// MARK: - Hover reaches the glyph

private struct JunoIconHoverKey: EnvironmentKey {
    static let defaultValue = false
}

public extension EnvironmentValues {
    /// Whether the control around a glyph is under the pointer. Set by
    /// ``SwiftUI/View/junoIconHoverSource()`` (or by a style that already
    /// tracks hover, through ``SwiftUI/View/junoIconHover(_:)``); read by
    /// ``JunoIconView``, which then plays its own ``JunoIconGesture``.
    var junoIconHover: Bool {
        get { self[JunoIconHoverKey.self] }
        set { self[JunoIconHoverKey.self] = newValue }
    }
}

private struct JunoIconHoverSource: ViewModifier {
    @State private var hovered = false
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        content
            .environment(\.junoIconHover, hovered && isEnabled)
            .onHover { hovered = $0 }
    }
}

public extension View {
    /// Makes this control the trigger for every ``JunoIconView`` inside it: a
    /// fine pointer over it plays each glyph's hover gesture, as a hovered link
    /// or button does on the web.
    func junoIconHoverSource() -> some View {
        modifier(JunoIconHoverSource())
    }

    /// For a control that already tracks its own hover: hands that state to
    /// the glyphs inside it.
    func junoIconHover(_ hovered: Bool) -> some View {
        environment(\.junoIconHover, hovered)
    }
}
