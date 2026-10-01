import Foundation

/// The canonical screen actions: the 17 members of Anthropic's
/// `computer_toolset_20260801` (CODE_AGENT_SPEC §3.4), by the names the
/// toolset uses. Every route speaks this vocabulary; only the wire differs.
public enum ScreenActionKind: String, CaseIterable, Hashable, Codable, Sendable {
    case screenshot
    case zoom
    case leftClick = "left_click"
    case rightClick = "right_click"
    case middleClick = "middle_click"
    case doubleClick = "double_click"
    case tripleClick = "triple_click"
    case leftClickDrag = "left_click_drag"
    case mouseMove = "mouse_move"
    case leftMouseDown = "left_mouse_down"
    case leftMouseUp = "left_mouse_up"
    case cursorPosition = "cursor_position"
    case scroll
    case type
    case key
    case holdKey = "hold_key"
    case wait

    /// Looking, not touching. These never ask and never change the app.
    public var isObservation: Bool {
        switch self {
        case .screenshot, .zoom, .cursorPosition, .wait: true
        default: false
        }
    }

    /// Actions that take a point, from `coordinate` or `element`.
    public var takesPoint: Bool {
        switch self {
        case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick,
             .leftClickDrag, .mouseMove, .leftMouseDown, .leftMouseUp, .scroll:
            true
        default:
            false
        }
    }

    /// Past-tense verb for a step row: "Clicked", "Typed".
    public var pastTense: String {
        switch self {
        case .screenshot: "Looked at"
        case .zoom: "Zoomed into"
        case .leftClick: "Clicked"
        case .rightClick: "Right-clicked"
        case .middleClick: "Middle-clicked"
        case .doubleClick: "Double-clicked"
        case .tripleClick: "Triple-clicked"
        case .leftClickDrag: "Dragged"
        case .mouseMove: "Pointed at"
        case .leftMouseDown: "Pressed the mouse"
        case .leftMouseUp: "Released the mouse"
        case .cursorPosition: "Checked the pointer"
        case .scroll: "Scrolled"
        case .type: "Typed"
        case .key: "Pressed"
        case .holdKey: "Held"
        case .wait: "Waited"
        }
    }

    /// Present participle, while it runs: "Clicking".
    public var progressive: String {
        switch self {
        case .screenshot: "Looking at"
        case .zoom: "Zooming into"
        case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick: "Clicking"
        case .leftClickDrag: "Dragging"
        case .mouseMove: "Pointing"
        case .leftMouseDown, .leftMouseUp: "Using the mouse"
        case .cursorPosition: "Checking the pointer"
        case .scroll: "Scrolling"
        case .type: "Typing"
        case .key, .holdKey: "Pressing keys"
        case .wait: "Waiting"
        }
    }
}

/// How far an action reaches, which is what an app's tier is measured
/// against (CODE_AGENT_SPEC §3.3).
public enum ScreenActionClass: String, CaseIterable, Hashable, Codable, Sendable, Comparable {
    /// Looking: screenshots, zoom, the accessibility tree.
    case view
    /// Plain clicks, scrolls and pointer moves, with no modifier keys held.
    case click
    /// Typing, key presses, right-click (its menu has Paste), drags,
    /// modifier-clicks, menus, held keys.
    case full

    private var rank: Int {
        switch self {
        case .view: 0
        case .click: 1
        case .full: 2
        }
    }

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rank < rhs.rank }
}

/// One requested action, as the model wrote it.
///
/// Coordinates are in the frame of the latest screenshot of the target app,
/// in the route's coordinate convention. `element` names an id from the
/// latest accessibility snapshot and replaces the coordinate.
public struct ScreenAction: Hashable, Codable, Sendable {
    public enum TypeMode: String, Hashable, Codable, Sendable {
        /// At the caret.
        case insert
        /// Replacing the field's value.
        case replace
    }

    public enum ScrollDirection: String, Hashable, Codable, Sendable, CaseIterable {
        case up, down, left, right
    }

    public var kind: ScreenActionKind
    /// Bundle id or name of the app. Nil means the session's current app.
    public var app: String?
    public var coordinate: [Double]?
    public var startCoordinate: [Double]?
    public var element: String?
    public var region: [Double]?
    /// What to type, the key chord, or modifiers held during a click.
    public var text: String?
    public var repeatCount: Int?
    public var duration: Double?
    public var scrollDirection: ScrollDirection?
    public var scrollAmount: Int?
    public var mode: TypeMode?

    public init(
        kind: ScreenActionKind,
        app: String? = nil,
        coordinate: [Double]? = nil,
        startCoordinate: [Double]? = nil,
        element: String? = nil,
        region: [Double]? = nil,
        text: String? = nil,
        repeatCount: Int? = nil,
        duration: Double? = nil,
        scrollDirection: ScrollDirection? = nil,
        scrollAmount: Int? = nil,
        mode: TypeMode? = nil
    ) {
        self.kind = kind
        self.app = app
        self.coordinate = coordinate
        self.startCoordinate = startCoordinate
        self.element = element
        self.region = region
        self.text = text
        self.repeatCount = repeatCount
        self.duration = duration
        self.scrollDirection = scrollDirection
        self.scrollAmount = scrollAmount
        self.mode = mode
    }

    /// The longest `hold_key` or `wait` Juno runs. Anthropic allows 300 s;
    /// a screen held for five minutes is a screen nobody is watching.
    public static let maximumDurationSeconds = 30.0

    /// Modifier keys held during a click or scroll, from `text`.
    public var heldModifiers: KeyModifiers {
        guard kind.takesPoint, let text, !text.isEmpty else { return [] }
        return KeyChord.modifiers(in: text)
    }

    /// The reach of this action, for the tier check.
    public var actionClass: ScreenActionClass {
        switch kind {
        case .screenshot, .zoom, .cursorPosition, .wait:
            return .view
        case .leftClick, .doubleClick, .tripleClick, .scroll, .mouseMove:
            return heldModifiers.isEmpty ? .click : .full
        case .rightClick, .middleClick, .leftClickDrag, .leftMouseDown, .leftMouseUp,
             .type, .key, .holdKey:
            return .full
        }
    }
}
