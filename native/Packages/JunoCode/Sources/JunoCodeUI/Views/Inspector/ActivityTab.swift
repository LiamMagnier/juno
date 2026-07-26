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
    /// Selects a sub-agent's own session in the sidebar. Absent when the host has
    /// no selection to drive, in which case the row still expands in place and the
    /// control is not offered at all rather than offered and inert.
    var selectSession: ((CodeSessionID) -> Void)?

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

            subagentsSection

            // Consent, the two TCC grants, the captured display, the latest
            // capture and the action record — see `ComputerUsePane.swift` for
            // why the safety surface lives in this pane rather than its own.
            ComputerUseSections(controller: controller)
        }
        .listStyle(.inset)
        .computerUseWatch(controller)
    }

    // MARK: - Sub-agents

    /// Delegated tasks, and what each one's own session recorded.
    ///
    /// `CodeSession` has no parent link and the local runtime emits no live child
    /// status, so a row states the delegating call's state and loads the child's
    /// real transcript when it is opened. Nothing is estimated in between: there
    /// is no progress bar, because nothing reports progress. The section and its
    /// rows live in `SubagentInspector.swift`.
    private var subagentsSection: some View {
        SubagentSection(controller: controller, selectSession: selectSession)
    }

    private var elapsedLabel: String {
        guard let seconds = controller.elapsedSeconds else { return "—" }
        let whole = Int(seconds)
        return whole < 60
            ? "\(whole)s"
            : "\(whole / 60)m \(whole % 60)s"
    }
}
