import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The shape of the run: what is happening now, and what the session has
/// actually been allowed to do to the machine.
///
/// Nothing here is inferred. There are no token or cost figures because the
/// local runtime does not report `Usage`, and no progress bars because no tool
/// reports progress.
struct ActivityTab: View {
    @Bindable var controller: SessionController

    private var currentTool: (name: String, summary: String)? {
        var completed: Set<String> = []
        for event in controller.events.reversed() {
            switch event.payload {
            case let .toolCompleted(finished):
                completed.insert(finished.toolCallID)
            case let .toolProposed(proposed) where !completed.contains(proposed.toolCallID):
                return (proposed.toolName, proposed.summary)
            default:
                continue
            }
        }
        return nil
    }

    var body: some View {
        // The Computer Use stop sits outside the list, so it cannot scroll away
        // while the agent is driving the pointer. It renders nothing at all
        // unless the coordinator reports capture as live.
        VStack(spacing: 0) {
            ComputerUseStopBar(controller: controller)
            list
        }
    }

    private var list: some View {
        List {
            Section("Run") {
                if let currentTool {
                    LabeledContent("Running") {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(currentTool.name).junoCode()
                            Text(currentTool.summary)
                                .junoCaption()
                                .lineLimit(2)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                } else {
                    // The session's own status belongs to the toolbar and the
                    // transcript; this pane answers the narrower question of what
                    // tool is running right now.
                    LabeledContent("Running", value: "No tool")
                }
                if controller.isRunning, controller.runStartedAt != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Elapsed", value: elapsedLabel)
                    }
                }
                // Read from the checkpoint store, not counted off the transcript:
                // a checkpoint is one file's content from before one change, and
                // there is no run-level snapshot for a session to rewind to.
                LabeledContent(
                    "Restorable file versions",
                    value: "\(controller.checkpointCount)"
                )
            }

            delegationSummary

            // Consent, the two TCC grants, the captured display, the latest
            // capture and the action record — see `ComputerUsePane.swift` for
            // why the safety surface lives in this pane rather than its own.
            ComputerUseSections(controller: controller)
        }
        .listStyle(.inset)
        .computerUseWatch(controller)
    }

    // MARK: - Sub-agents

    /// How much of this run is happening in parallel, and nothing more.
    ///
    /// The agents themselves moved to their own pane. What belongs here is the
    /// same question this pane already answers about tools — *what is the run
    /// doing right now* — for which the count of live agents is the answer and a
    /// second list of them would be a duplicate. It is drawn only while a
    /// delegation exists, so a session that never delegated carries no row about
    /// delegation.
    @ViewBuilder
    private var delegationSummary: some View {
        let runs = controller.subagents
        let active = runs.filter(\.isActive).count
        if !runs.isEmpty {
            Section("Delegation") {
                LabeledContent(
                    "Sub-agents",
                    value: active > 0
                        ? "\(active) of \(runs.count) running"
                        : "\(runs.count) finished"
                )
                .help("Open the Sub-agents pane to read each one")
            }
        }
    }

    private var elapsedLabel: String {
        guard let seconds = controller.elapsedSeconds else { return "—" }
        let whole = Int(seconds)
        return whole < 60
            ? "\(whole)s"
            : "\(whole / 60)m \(whole % 60)s"
    }
}
