import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Persisted child sessions stay inspectable after their run has finished.
struct StudioAgentsPane: View {
    @Bindable var controller: SessionController
    @State private var trace: [SessionEvent] = []
    @State private var message = ""
    @State private var deliveryError: String?
    @State private var sending = false

    private var selected: SubagentUpdateEvent? {
        controller.delegatedAgents.first { $0.agentID == controller.inspectedSubagentID }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let agent = selected {
                HStack {
                    Button("All agents") { controller.inspectedSubagentID = nil }
                        .buttonStyle(StudioQuietButtonStyle())
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                    Spacer()
                    Text(StudioSubagentFormat.label(agent.status))
                        .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                }
                .padding(JunoSpace.cozy)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
                        Text(agent.title).font(Studio.Font.labelEmphasis)
                        DisclosureGroup("Assignment") {
                            Text(agent.task).textSelection(.enabled)
                        }
                        ForEach(trace) { event in StudioAgentTraceRow(event: event) }
                        if trace.isEmpty {
                            Text(agent.error ?? agent.summary ?? "The agent's work will appear here.")
                                .foregroundStyle(Studio.Ink.secondary)
                        }
                        StudioSubagentControls(controller: controller, update: agent)
                    }
                    .font(Studio.Font.label)
                    .padding(JunoSpace.cozy)
                }
                if !agent.status.isTerminal, let childID = agent.childSessionID {
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        HStack(alignment: .bottom) {
                            TextField("Message this agent", text: $message, axis: .vertical)
                                .textFieldStyle(.plain).lineLimit(1...4)
                                .onSubmit { send(to: childID) }
                            Button("Send") { send(to: childID) }
                                .buttonStyle(StudioQuietButtonStyle())
                                .disabled(sending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(.rect)
                        }
                        if let deliveryError {
                            Text(deliveryError).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger)
                        }
                    }
                    .padding(JunoSpace.cozy).studioHairline(.top)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: JunoSpace.regular) {
                        group("Active", agents: controller.delegatedAgents.filter { !$0.status.isTerminal })
                        group("Done", agents: controller.delegatedAgents.filter { $0.status.isTerminal })
                    }
                    .padding(JunoSpace.cozy)
                }
            }
        }
        .task(id: selected?.childSessionID) {
            trace = []
            deliveryError = nil
            message = ""
            guard let childID = selected?.childSessionID else { return }
            repeat {
                let events = await controller.subAgentTranscript(childID)
                guard !Task.isCancelled else { return }
                trace = events
                if selected?.status.isTerminal == true { return }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            } while !Task.isCancelled
        }
        .onChange(of: selected?.status) { _, status in
            guard status?.isTerminal == true, let childID = selected?.childSessionID else { return }
            Task { trace = await controller.subAgentTranscript(childID) }
        }
        .accessibilityIdentifier("juno.code.panel.agents")
    }

    private func group(_ title: String, agents: [SubagentUpdateEvent]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("\(title) · \(agents.count)").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
            if agents.isEmpty {
                Text(title == "Active" ? "No active subagents" : "No completed subagents")
                    .font(Studio.Font.label).foregroundStyle(Studio.Ink.secondary)
            }
            ForEach(agents, id: \.agentID) { agent in
                Button { controller.inspectedSubagentID = agent.agentID } label: {
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(agent.title).font(Studio.Font.labelEmphasis)
                            Spacer()
                            if let start = agent.startedAt {
                                if let end = agent.completedAt {
                                    Text(StudioFormat.duration(end.timeIntervalSince(start))).font(Studio.Font.metaDigits)
                                } else {
                                    Text(start, style: .relative).font(Studio.Font.metaDigits)
                                }
                            }
                        }
                        Text(agent.error ?? agent.summary ?? agent.childSessionID.flatMap { controller.subagentActivity[$0] } ?? agent.currentActivity)
                            .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).lineLimit(2)
                    }
                    .foregroundStyle(agent.status.isTerminal ? Studio.Ink.primary : Studio.Ink.accent)
                    .padding(.vertical, JunoSpace.snug).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(agent.title), \(StudioSubagentFormat.label(agent.status)). Open full trace")
            }
        }
    }

    private func send(to childID: CodeSessionID) {
        guard !sending else { return }
        let text = message
        sending = true
        Task {
            let delivered = await controller.messageSubagent(childID, text: text)
            sending = false
            if delivered { message = ""; deliveryError = nil }
            else { deliveryError = "The agent could not take this message. Your words are still here." }
        }
    }
}

private struct StudioAgentTraceRow: View {
    let event: SessionEvent

    @ViewBuilder var body: some View {
        switch event.payload {
        case let .userPrompt(value):
            Text(value.text).textSelection(.enabled)
        case let .assistantMessage(value):
            JunoMarkdownText(value.text).textSelection(.enabled)
        case let .reasoningSummary(value):
            DisclosureGroup("Reasoning") { JunoMarkdownText(value.summary).textSelection(.enabled) }
        case let .toolProposed(value):
            DisclosureGroup(value.summary) { Text(encoded(value.input)).font(Studio.Font.mono).textSelection(.enabled) }
        case let .toolOutput(value):
            Text(value.text).font(Studio.Font.mono).textSelection(.enabled)
        case let .toolCompleted(value):
            Text(value.resultSummary).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary).textSelection(.enabled)
        case let .errorOccurred(value):
            Text(value.message).foregroundStyle(Studio.Ink.danger).textSelection(.enabled)
        default:
            DisclosureGroup("Recorded event · \(event.timestamp.formatted(date: .omitted, time: .standard))") {
                Text(encoded(event.payload)).font(Studio.Font.mono).textSelection(.enabled)
            }
            .foregroundStyle(Studio.Ink.secondary)
        }
    }

    private func encoded(_ value: some Encodable) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}
