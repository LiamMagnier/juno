import SwiftUI
import JunoCodeCore
import JunoDesignSystem
import JunoScreenControl

// Screen-control steps in the thread: one row per action (CODE_AGENT_SPEC
// §3.7): what was done, where, and a thumbnail of the after-frame with the
// point marked. Owned by Lane C.

/// One screen-control action, as the thread shows it.
struct StudioScreenStep: Equatable {
    /// The event the row stands at: the call's proposal.
    var eventID: String
    var toolCallID: String = ""
    /// "Clicked", "Typed", "Pressed".
    var verb: String
    /// "Clicking", while it runs.
    var running: String?
    /// The app it acted in: "TextEdit", or "the current app".
    var app: String
    /// The element, when known: "Save button".
    var element: String?
    /// Nil while the action runs.
    var succeeded: Bool?
    /// What the tool said when it finished: "Clicked the “Save” button in
    /// TextEdit." or the refusal's sentence.
    var outcome: String? = nil

    /// The tools drawn as step rows.
    static let tools: Set<String> = [ComputerUseToolName.computer, ComputerUseToolName.batch, ComputerUseToolName.menu]

    /// Every event of each screen call, mapped to its step. The builder draws
    /// the row at the proposal and leaves the call's other events out of the
    /// activity rows.
    static func steps(in events: [SessionEvent]) -> [String: StudioScreenStep] {
        var byCall: [String: StudioScreenStep] = [:]
        var eventsOfCall: [String: [String]] = [:]
        for event in events {
            switch event.payload {
            case let .toolProposed(proposed) where tools.contains(proposed.toolName):
                byCall[proposed.toolCallID] = step(for: proposed, eventID: event.id)
                eventsOfCall[proposed.toolCallID, default: []].append(event.id)
            case let .toolStarted(started) where byCall[started.toolCallID] != nil:
                eventsOfCall[started.toolCallID, default: []].append(event.id)
            case let .toolOutput(output) where byCall[output.toolCallID] != nil:
                eventsOfCall[output.toolCallID, default: []].append(event.id)
            case let .toolCompleted(completed) where byCall[completed.toolCallID] != nil:
                eventsOfCall[completed.toolCallID, default: []].append(event.id)
                byCall[completed.toolCallID]?.succeeded = completed.status == .succeeded
                byCall[completed.toolCallID]?.outcome = completed.resultSummary
            default:
                break
            }
        }
        var steps: [String: StudioScreenStep] = [:]
        for (call, ids) in eventsOfCall {
            guard let step = byCall[call] else { continue }
            for id in ids { steps[id] = step }
        }
        return steps
    }

    static func step(for proposed: ToolProposedEvent, eventID: String) -> StudioScreenStep {
        let input = proposed.input
        let app = input["app"]?.stringValue.map(appName) ?? "the current app"
        switch proposed.toolName {
        case ComputerUseToolName.batch:
            let count = input["actions"]?.arrayValue?.count ?? 0
            return StudioScreenStep(eventID: eventID, toolCallID: proposed.toolCallID, verb: "Ran \(count) screen actions", app: app)
        case ComputerUseToolName.menu:
            let path = input["path"]?.arrayValue?.compactMap(\.stringValue).joined(separator: " › ") ?? "a menu item"
            return StudioScreenStep(eventID: eventID, toolCallID: proposed.toolCallID, verb: "Chose", app: app, element: path)
        default:
            let kind = input["action"]?.stringValue.flatMap(ScreenActionKind.init(rawValue:))
            var element: String?
            if kind == .key { element = input["text"]?.stringValue }
            if kind == .type { element = input["text"]?.stringValue.map { "“\($0.count > 40 ? String($0.prefix(40)) + "…" : $0)”" } }
            return StudioScreenStep(
                eventID: eventID,
                toolCallID: proposed.toolCallID,
                verb: kind?.pastTense ?? "Used",
                running: kind?.progressive,
                app: app,
                element: element
            )
        }
    }

    /// `com.apple.TextEdit` → `TextEdit`; a name stays a name.
    static func appName(_ app: String) -> String {
        guard app.contains("."), !app.contains(" ") else { return app }
        return app.split(separator: ".").last.map(String.init) ?? app
    }
}

/// "Clicked the “Save” button in TextEdit", with the after-frame.
struct StudioScreenStepRow: View {
    let step: StudioScreenStep
    /// Injected in snapshots; otherwise read from the session's memory.
    var visual: ScreenStepVisual?

    private var shown: ScreenStepVisual? {
        visual ?? ScreenStepThumbnails.shared.visual(for: step.toolCallID)
    }

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            if let thumbnail = shown?.thumbnail {
                StudioScreenThumbnail(imageData: thumbnail, markedPoint: shown?.markedPoint, height: 30)
            }
            Text(Self.caption(for: step))
                .font(Studio.Font.meta)
                .foregroundStyle(step.succeeded == false ? Studio.Ink.danger : Studio.Ink.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 17)
        .accessibilityElement(children: .combine)
    }

    /// The tool's own sentence once it finished; "Clicking in TextEdit…"
    /// while it runs.
    static func caption(for step: StudioScreenStep) -> String {
        if let outcome = step.outcome, !outcome.isEmpty {
            return outcome
        }
        let target = step.element.map { " \($0) in \(step.app)" } ?? " in \(step.app)"
        switch step.succeeded {
        case nil: return (step.running ?? step.verb) + target + "…"
        case true?: return step.verb + target
        case false?: return step.verb + target + " — did not work"
        }
    }
}
