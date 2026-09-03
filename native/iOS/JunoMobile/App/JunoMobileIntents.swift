import AppIntents
import Foundation
import Observation

/// What the system can ask the app to do: from Siri, Shortcuts, Spotlight,
/// the Action button, a Home Screen quick action or a notification tap.
///
/// The intents do not perform the work themselves. Each records a request on
/// ``JunoMobileLaunchRequests`` and opens the app; the root view watches that
/// and navigates. That keeps the intents free of the models — which only exist
/// once the app is signed in — and means every entry point lands the same
/// way, whether it came from Siri or from a long press on the icon.
@MainActor
@Observable
final class JunoMobileLaunchRequests {
  static let shared = JunoMobileLaunchRequests()

  enum Request: Equatable, Sendable {
    case newChat
    case voice
    case dictate
    case code
    case ask(String)
    case openConversation(String)
    case openRemoteSession(deviceID: String, sessionID: String)
    case respondToRemoteApproval(deviceID: String, sessionID: String, requestID: String, approved: Bool)
  }

  /// The request waiting to be acted on. Cleared by whoever handles it.
  var pending: Request?

  private init() {}

  func request(_ request: Request) {
    pending = request
  }

  /// A `UIApplicationShortcutItem` from the Home Screen, by its type.
  func handle(shortcutType: String) {
    switch shortcutType {
    case "com.liammagnier.JunoMobile.new-chat": pending = .newChat
    case "com.liammagnier.JunoMobile.voice": pending = .voice
    case "com.liammagnier.JunoMobile.dictate": pending = .dictate
    case "com.liammagnier.JunoMobile.code": pending = .code
    default: break
    }
  }

  /// A tapped Code notification.
  func handle(remoteDeviceID deviceID: String?, sessionID: String?) {
    guard let deviceID, let sessionID else { return }
    pending = .openRemoteSession(deviceID: deviceID, sessionID: sessionID)
  }

  /// Parses a widget or Live Activity deep link back into a launch request.
  ///
  /// The routes are the exact, explicit set ``JunoMobileWidgetRoute`` builds.
  /// Parsing nothing else — including the OAuth callback that shares the
  /// scheme — keeps a malicious link from creating a Code command or deciding
  /// an approval that was never shown.
  static func request(for url: URL) -> Request? {
    guard url.scheme == JunoMobileWidgetRoute.scheme, url.host == JunoMobileWidgetRoute.host
    else { return nil }
    let path = url.pathComponents.filter { $0 != "/" }
    switch path {
    case ["chat"]: return .newChat
    case ["voice"]: return .voice
    case ["dictate"]: return .dictate
    case ["code"]: return .code
    case ["code", "approval"]:
      let values = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let value = { (name: String) in values.first(where: { $0.name == name })?.value }
      guard let deviceID = value("deviceID"), let sessionID = value("sessionID"),
        let requestID = value("requestID"), let approved = value("approved")
      else { return nil }
      return .respondToRemoteApproval(
        deviceID: deviceID, sessionID: sessionID, requestID: requestID, approved: approved == "true"
      )
    default:
      // The session route cannot be a case: an array literal in pattern
      // position is an expression pattern, and `let` bindings cannot ride
      // inside one.
      guard path.count == 4, path[0] == "code", path[1] == "session" else { return nil }
      return .openRemoteSession(deviceID: path[2], sessionID: path[3])
    }
  }
}

struct StartNewChatIntent: AppIntent {
  static let title: LocalizedStringResource = "Start a new chat"
  static let description = IntentDescription("Opens Juno on an empty chat.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    JunoMobileLaunchRequests.shared.request(.newChat)
    return .result()
  }
}

struct StartVoiceIntent: AppIntent {
  static let title: LocalizedStringResource = "Talk to Juno"
  static let description = IntentDescription("Starts a voice conversation.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    JunoMobileLaunchRequests.shared.request(.voice)
    return .result()
  }
}

/// Opens a new chat with Dictate ready. Kept separate from ``StartVoiceIntent``:
/// dictation produces a message draft, while Voice starts a realtime call.
struct StartDictationIntent: AppIntent {
  static let title: LocalizedStringResource = "Dictate to Juno"
  static let description = IntentDescription("Opens a new Juno chat and starts dictation.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    JunoMobileLaunchRequests.shared.request(.dictate)
    return .result()
  }
}

struct OpenCodeIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Juno Code"
  static let description = IntentDescription("Shows your Macs and their coding sessions.")
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    JunoMobileLaunchRequests.shared.request(.code)
    return .result()
  }
}

struct AskJunoIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Juno"
  static let description = IntentDescription("Sends a question to Juno in a new chat.")
  static let openAppWhenRun = true

  @Parameter(title: "Question", requestValueDialog: "What would you like to ask?")
  var prompt: String

  static var parameterSummary: some ParameterSummary {
    Summary("Ask Juno \(\.$prompt)")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    JunoMobileLaunchRequests.shared.request(.ask(prompt))
    return .result()
  }
}

struct JunoMobileShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartNewChatIntent(),
      phrases: [
        "New chat in \(.applicationName)",
        "Start a chat in \(.applicationName)",
      ],
      shortTitle: "New chat",
      systemImageName: "square.and.pencil"
    )
    AppShortcut(
      intent: StartVoiceIntent(),
      phrases: [
        "Talk to \(.applicationName)",
        "Start a voice chat in \(.applicationName)",
      ],
      shortTitle: "Voice",
      systemImageName: "waveform"
    )
    AppShortcut(
      intent: StartDictationIntent(),
      phrases: [
        "Dictate to \(.applicationName)",
        "Start dictation in \(.applicationName)",
      ],
      shortTitle: "Dictate",
      systemImageName: "mic"
    )
    AppShortcut(
      intent: AskJunoIntent(),
      phrases: [
        "Ask \(.applicationName)",
        "Ask \(.applicationName) a question",
      ],
      shortTitle: "Ask Juno",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: OpenCodeIntent(),
      phrases: [
        "Open \(.applicationName) Code",
        "Show my coding sessions in \(.applicationName)",
      ],
      shortTitle: "Juno Code",
      systemImageName: "chevron.left.forwardslash.chevron.right"
    )
  }
}
