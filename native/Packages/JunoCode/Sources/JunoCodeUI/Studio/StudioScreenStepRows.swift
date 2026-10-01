import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// Screen-control steps in the thread: one row per action.
//
// Owned by Lane C (computer use and Simulator tools). A placeholder from the
// seams commit (CODE_AGENT_SPEC §6.0), which Lane C replaces with the designed
// step rows (§3.7: verb, app and element, a thumbnail with the point marked).

/// One screen-control action, as the thread shows it.
struct StudioScreenStep: Equatable {
    /// The event the step was read from.
    var eventID: String
    /// "Clicked", "Typed", "Pressed".
    var verb: String
    /// The app it acted in: "TextEdit".
    var app: String
    /// The element, when known: "Save button".
    var element: String?
    /// Nil while the action runs.
    var succeeded: Bool?

    /// The events Lane C draws as step rows, by event id. Each is taken out of
    /// the activity row it would otherwise join.
    ///
    /// None yet: until Lane C lands, screen actions stay in activity rows as
    /// they are today.
    static func steps(in _: [SessionEvent]) -> [String: StudioScreenStep] {
        [:]
    }
}

/// "Clicked Save button in TextEdit".
struct StudioScreenStepRow: View {
    let step: StudioScreenStep

    var body: some View {
        Text(Self.caption(for: step))
            .font(Studio.Font.meta)
            .foregroundStyle(step.succeeded == false ? Studio.Ink.danger : Studio.Ink.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 17)
    }

    static func caption(for step: StudioScreenStep) -> String {
        let target = step.element.map { " \($0) in \(step.app)" } ?? " in \(step.app)"
        let outcome = step.succeeded == false ? " — did not work" : ""
        return step.verb + target + outcome
    }
}
