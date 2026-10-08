import AppIntents
import Foundation
import JunoCodeCore
import JunoCodeUI

// "Start a Juno Code task" for Shortcuts and the Mac's automation
// (CODE_AGENT_SPEC §5.18 a, D-025). It opens an ordinary Code session in the
// named project and sends the task; every approval still waits for the reader
// in the app. The mode is capped by the reader's remote ceiling, since an
// automation runs with no one watching (`CodeTaskIntentRequest`). The
// headless `juno-code exec` is deferred.

struct StartJunoCodeTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Start an Alevr Code task"
    static let description = IntentDescription(
        "Opens an Alevr Code session in a project and gives it a task. Alevr asks you in the app before anything that needs your approval."
    )
    static let openAppWhenRun = true

    @Parameter(title: "Task", description: "What Alevr should do.")
    var prompt: String

    @Parameter(title: "Project", description: "The project's name in Alevr Code. Optional with only one project.")
    var project: String?

    @Parameter(title: "Goal", description: "Optional: a goal Alevr keeps working toward until it is met.")
    var goal: String?

    @Parameter(title: "Mode", default: .askBeforeEdits)
    var mode: JunoCodeIntentMode

    static var parameterSummary: some ParameterSummary {
        Summary("Start \(\.$prompt) in \(\.$project)") {
            \.$goal
            \.$mode
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let workbench = await DesktopWorkbenchRegistry.shared.awaitWorkbench() else {
            throw CodeTaskIntentError.cannotStart("Sign in to Alevr and open Alevr Code first.")
        }
        let request = CodeTaskIntentRequest(
            projectName: project,
            prompt: prompt,
            goal: goal,
            mode: mode.requestMode
        )
        let sessionID = try await workbench.startIntentTask(request)
        DesktopWorkbenchRegistry.shared.request(.openSession(sessionID))
        return .result(dialog: "Started in Alevr Code. Alevr will ask you in the app before anything that needs approval.")
    }
}

enum JunoCodeIntentMode: String, AppEnum {
    case plan
    case askBeforeEdits
    case autoEdit
    case fullAccess

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Mode"
    static let caseDisplayRepresentations: [JunoCodeIntentMode: DisplayRepresentation] = [
        .plan: "Plan",
        .askBeforeEdits: "Ask before edits",
        .autoEdit: "Auto-edit",
        .fullAccess: "Full access",
    ]

    var requestMode: CodeTaskIntentRequest.Mode {
        switch self {
        case .plan: .plan
        case .askBeforeEdits: .askBeforeEdits
        case .autoEdit: .autoEdit
        case .fullAccess: .fullAccess
        }
    }
}

struct JunoCodeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartJunoCodeTaskIntent(),
            phrases: ["Start a task in \(.applicationName)", "Start an Alevr Code task in \(.applicationName)"],
            shortTitle: "Start a Code task",
            systemImageName: "chevron.left.forwardslash.chevron.right"
        )
    }
}

extension DesktopWorkbenchRegistry {
    /// The workbench, waiting a moment for the window that builds it when the
    /// intent launched the app.
    func awaitWorkbench(timeout: Duration = .seconds(15)) async -> WorkbenchModel? {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if let workbench, workbench.hasLoaded { return workbench }
            try? await Task.sleep(for: .milliseconds(150))
        }
        return workbench
    }
}

/// Turns the Code package's open-session notification into the window
/// registry's own request.
@MainActor
enum JunoCodeOpenSessionRelay {
    private static var token: NSObjectProtocol?

    static func start() {
        guard token == nil else { return }
        token = NotificationCenter.default.addObserver(
            forName: .junoCodeOpenSession,
            object: nil,
            queue: .main
        ) { note in
            guard let id = note.object as? CodeSessionID else { return }
            MainActor.assumeIsolated {
                DesktopWorkbenchRegistry.shared.request(.openSession(id))
            }
        }
    }
}
