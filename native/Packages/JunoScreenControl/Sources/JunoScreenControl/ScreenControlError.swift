import Foundation

/// Every refusal screen control gives, as a sentence the model can act on
/// (CU-16). The old errors reached the model as enum names —
/// `notActive`, `coordinatesOutOfBounds` — which say what broke and nothing
/// about what to do next.
public enum ScreenControlError: Error, Hashable, Sendable, LocalizedError {
    /// Screen control is not on for this session.
    case notRunning
    /// The reader pressed Stop or Esc. The turn should end.
    case stoppedByReader
    /// The reader took over the Mac. Wait for Resume.
    case readerTookOver
    /// Another session or task holds the screen.
    case lockHeld(holder: String)
    /// No app is targeted yet.
    case noTargetApp
    case appNotGranted(app: String)
    /// The action is beyond the app's tier: the sentence says which.
    case tierTooLow(String)
    case appRefused(app: String, reason: String)
    case junoWindow
    case secureField
    case systemPromptInFront(app: String)
    /// The target region changed since the frame the action is about.
    case screenChanged
    case windowGone(app: String)
    case coordinateOutOfFrame(x: Double, y: Double, frame: PixelSize)
    case noFrameYet
    case unknownElement(String)
    case invalidInput(String)
    case overwriteRefused
    case typedTextMismatch(expected: Int, found: Int)
    case unsupported(String)
    case permissionMissing(String)
    case driverFailed(String)
    /// A batch stopped at an earlier failure. The exact text is Anthropic's.
    case notExecuted

    public static let notExecutedText = "Not executed: an earlier computer action in this turn failed."

    public var errorDescription: String? {
        switch self {
        case .notRunning:
            "Screen control is not running in this session. Ask the reader to choose Let Juno Use Apps in the session's More menu."
        case .stoppedByReader:
            "The reader stopped screen control. Do not retry; say what you still need."
        case .readerTookOver:
            "The reader took over the Mac. Wait until they press Resume, then take a new screenshot."
        case let .lockHeld(holder):
            "\(holder). Only one session can use apps at a time; wait for it to finish or ask the reader."
        case .noTargetApp:
            "No app is chosen yet. Open a granted app with computer_apps open, or ask the reader to grant one with computer_apps request."
        case let .appNotGranted(app):
            "\(app) is not granted for this session. Ask the reader to grant it with computer_apps request."
        case let .tierTooLow(sentence):
            sentence
        case let .appRefused(app, reason):
            "Juno never controls \(app): \(reason). Ask the reader to do this part."
        case .junoWindow:
            "That point is on one of Juno's own windows, which screen control never touches."
        case .secureField:
            "That is a password field. Juno never types credentials; ask the reader to enter it."
        case let .systemPromptInFront(app):
            "A system or password prompt (\(app)) is in front. Stop and ask the reader to answer it."
        case .screenChanged:
            "The screen changed; take a new screenshot."
        case let .windowGone(app):
            "\(app) has no window to capture. Open it with computer_apps open, then take a screenshot."
        case let .coordinateOutOfFrame(x, y, frame):
            "(\(Int(x)), \(Int(y))) is outside the \(frame) frame of the latest screenshot. Use coordinates from that screenshot."
        case .noFrameYet:
            "Take a screenshot of the app first; coordinates are in the frame of the latest screenshot."
        case let .unknownElement(id):
            "Element \(id) is not in the latest accessibility snapshot. Run computer_ax snapshot again."
        case let .invalidInput(message):
            message
        case .overwriteRefused:
            "That field already has text. Use mode replace to overwrite it, or insert to add at the caret."
        case let .typedTextMismatch(expected, found):
            "Typed \(expected) characters but the field now holds \(found) of them. Take a screenshot to see what landed."
        case let .unsupported(message):
            message
        case let .permissionMissing(grant):
            "macOS has not given Juno \(grant). Ask the reader to allow it in System Settings › Privacy & Security."
        case let .driverFailed(message):
            "The action could not be sent: \(message)"
        case .notExecuted:
            Self.notExecutedText
        }
    }

    /// Whether the turn should end here rather than let the model retry.
    public var endsTurn: Bool {
        self == .stoppedByReader
    }
}
