import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// The Runs list (CODE_AGENT_SPEC §5.1): every session with a run or a goal,
// grouped by what it needs from the reader, each row its title and one
// sentence, answered inline. No dots and no count badges: a group's heading
// carries its count in words. Owned by Lane E.

/// An answer given from a row.
public enum RunRowAnswer: Equatable, Sendable {
    case allowOnce
    case decline
    case reply(String)
    case keepGoing
    case resume
    case retry
}

/// One session in the Runs list.
public struct StudioRunRow: View {
    let entry: RunIndexEntry
    let answer: (RunRowAnswer) async -> RunActionResult

    @State private var reply = ""
    @State private var problem: String?
    @State private var isAnswering = false

    public init(entry: RunIndexEntry, answer: @escaping (RunRowAnswer) async -> RunActionResult) {
        self.entry = entry
        self.answer = answer
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline + 1) {
            Text(entry.title)
                .font(Studio.Font.label)
                .foregroundStyle(Studio.Ink.primary)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(Self.markdown(entry.sentence))
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if !entry.actions.isEmpty {
                actions
                    .padding(.top, JunoSpace.hairline)
                    // The quiet buttons' own inset, so their words line up
                    // with the sentence above.
                    .padding(.leading, -JunoSpace.snug)
            }
            if let problem {
                Text(problem)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, JunoSpace.hairline + 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(entry.title), \(entry.group.title): \(entry.sentence)")
    }

    @ViewBuilder
    private var actions: some View {
        if entry.actions.contains(.reply) {
            HStack(spacing: JunoSpace.tight) {
                TextField("Answer", text: $reply)
                    .textFieldStyle(.plain)
                    .font(Studio.Font.meta)
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(minHeight: 24)
                    .background(
                        RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                            .strokeBorder(Studio.Surface.hairline)
                    )
                    .onSubmit { give(.reply(reply)) }
                    .accessibilityLabel("Answer \(entry.title)")
                Button("Send") { give(.reply(reply)) }
                    .buttonStyle(StudioQuietButtonStyle(tint: Studio.Ink.primary))
                    .contentShape(.rect)
                    .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isAnswering)
            }
        } else {
            HStack(spacing: JunoSpace.tight) {
                ForEach(entry.actions, id: \.self) { action in
                    if let answer = Self.answer(for: action) {
                        Button(Self.title(for: action)) { give(answer) }
                            .buttonStyle(StudioQuietButtonStyle(
                                tint: action == .decline ? Studio.Ink.secondary : Studio.Ink.primary
                            ))
                            .contentShape(.rect)
                            .font(Studio.Font.meta)
                            .disabled(isAnswering)
                            .help(Self.help(for: action, entry: entry))
                    }
                }
            }
        }
    }

    private func give(_ choice: RunRowAnswer) {
        guard !isAnswering else { return }
        isAnswering = true
        problem = nil
        Task {
            let result = await answer(choice)
            isAnswering = false
            if case let .refused(reason) = result {
                problem = reason
            } else if case .reply = choice {
                reply = ""
            }
        }
    }

    static func answer(for action: RunRowAction) -> RunRowAnswer? {
        switch action {
        case .allowOnce: .allowOnce
        case .decline: .decline
        case .keepGoing: .keepGoing
        case .resume: .resume
        case .retry: .retry
        case .reply: nil
        }
    }

    static func title(for action: RunRowAction) -> String {
        switch action {
        case .allowOnce: "Allow once"
        case .decline: "Decline"
        case .reply: "Reply"
        case .keepGoing: "Keep going"
        case .resume: "Resume"
        case .retry: "Retry"
        }
    }

    static func help(for action: RunRowAction, entry: RunIndexEntry) -> String {
        switch action {
        case .allowOnce:
            "Allow \(entry.approval.map(RunIndex.approvalSubject) ?? "this") once. Always allow is in the session."
        case .decline: "Decline, and the run carries on without it"
        case .reply: "Answer the question"
        case .keepGoing: "Another block of steps, then carry on from where it stopped"
        case .resume: "Carry on from where it stopped when Juno quit"
        case .retry: "Try the last turn again"
        }
    }

    /// The sentence with its code spans drawn as code.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}

/// The Runs list on its own: the groups with their headings in words, for a
/// surface that is not a sidebar list (and for the snapshots).
public struct StudioRunsList: View {
    let sections: [RunIndexSection]
    let open: (CodeSessionID) -> Void
    let answer: (CodeSessionID, RunRowAnswer) async -> RunActionResult

    public init(
        sections: [RunIndexSection],
        open: @escaping (CodeSessionID) -> Void,
        answer: @escaping (CodeSessionID, RunRowAnswer) async -> RunActionResult
    ) {
        self.sections = sections
        self.open = open
        self.answer = answer
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if sections.isEmpty {
                Text("No runs yet")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            ForEach(sections) { section in
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    StudioRunsHeading(section: section)
                    ForEach(section.entries) { entry in
                        StudioRunRow(entry: entry) { choice in
                            await answer(entry.sessionID, choice)
                        }
                        .padding(.horizontal, JunoSpace.snug)
                        .background(
                            RoundedRectangle(cornerRadius: Studio.Radius.row, style: .continuous)
                                .fill(Color.clear)
                        )
                        .onTapGesture { open(entry.sessionID) }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Runs")
    }
}

/// A group's heading: its name and its count, in words.
public struct StudioRunsHeading: View {
    let section: RunIndexSection

    public init(section: RunIndexSection) {
        self.section = section
    }

    public var body: some View {
        Text(section.heading)
            .font(Studio.Font.caption)
            .foregroundStyle(Studio.Ink.tertiary)
            .accessibilityAddTraits(.isHeader)
    }
}

public extension WorkbenchModel {
    /// Answers a row of the Runs list, bound to what that row showed.
    ///
    /// Allow once and Decline answer the approval the reader saw on the row,
    /// with its digest, never whatever is pending by the time the click
    /// lands: if that approval was answered elsewhere and a different action
    /// is now waiting, the click is refused rather than carrying out an
    /// action the reader never read. The same goes for a question.
    func answer(_ choice: RunRowAnswer, shown entry: RunIndexEntry) async -> RunActionResult {
        let sessionID = entry.sessionID
        switch choice {
        case .allowOnce:
            guard let approval = entry.approval else { return .refused("Nothing is waiting for an approval.") }
            return await allowOnce(sessionID: sessionID, approvalID: approval.id, digest: approval.actionDigest)
        case .decline:
            guard let approval = entry.approval else { return .refused("Nothing is waiting for an approval.") }
            return await decline(sessionID: sessionID, approvalID: approval.id, digest: approval.actionDigest)
        case let .reply(text):
            guard let question = entry.question else { return .refused("Nothing is waiting for an answer.") }
            return await reply(sessionID: sessionID, questionID: question.id, text: text)
        case .keepGoing:
            return await keepGoing(sessionID: sessionID)
        case .resume:
            return await resume(sessionID: sessionID)
        case .retry:
            return await retry(sessionID: sessionID)
        }
    }
}
