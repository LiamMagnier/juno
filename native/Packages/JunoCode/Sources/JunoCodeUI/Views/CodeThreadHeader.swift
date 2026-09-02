import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The compact strip above a thread: what is running, where, and how it is
/// going.
///
/// One line of orientation and nothing else. The task's title, the project and
/// branch it is in, its status, how long it has been running, how full the
/// model's context is, and the way to stop it — the facts the audit found
/// scattered across a title strip, a goal strip, the transcript's provenance
/// rows and the inspector's header. The toolbar owns actions; this owns
/// orientation.
///
/// It takes values rather than a controller so the cloud and relay canvases,
/// which have no `SessionController`, draw the same strip from their own
/// records.
public struct CodeThreadHeader: View {
    public struct Context: Equatable, Sendable {
        public var title: String
        public var project: String?
        public var branch: String?
        public var environment: String?
        public var status: CodeRunStatus?
        public var startedAt: Date?
        public var contextTokens: Int?
        public var contextWindowTokens: Int?

        public init(
            title: String,
            project: String? = nil,
            branch: String? = nil,
            environment: String? = nil,
            status: CodeRunStatus? = nil,
            startedAt: Date? = nil,
            contextTokens: Int? = nil,
            contextWindowTokens: Int? = nil
        ) {
            self.title = title
            self.project = project
            self.branch = branch
            self.environment = environment
            self.status = status
            self.startedAt = startedAt
            self.contextTokens = contextTokens
            self.contextWindowTokens = contextWindowTokens
        }
    }

    private let context: Context
    private let stop: (() -> Void)?

    public init(_ context: Context, stop: (() -> Void)? = nil) {
        self.context = context
        self.stop = stop
    }

    /// The same strip, read live off a local session.
    public init(controller: SessionController, stop: (() -> Void)? = nil) {
        self.init(
            Context(
                title: controller.session.title,
                project: controller.workspaceDisplayName,
                branch: controller.gitStatus?.branch ?? controller.session.gitBranch,
                environment: controller.session.executionRootPath != nil ? "Worktree" : nil,
                status: CodeRunStatus(
                    controller.session.status,
                    hasPendingApproval: !controller.pendingApprovals.isEmpty
                ),
                startedAt: controller.runStartedAt,
                contextTokens: controller.contextTokens,
                contextWindowTokens: controller.contextWindowTokens
            ),
            stop: stop
        )
    }

    private var isRunning: Bool { context.status?.isActive == true }

    public var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: 2) {
                Text(context.title)
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                    .junoInk()
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityAddTraits(.isHeader)

                if !subtitleParts.isEmpty {
                    HStack(spacing: JunoSpace.tight) {
                        ForEach(Array(subtitleParts.enumerated()), id: \.offset) { index, part in
                            if index > 0 {
                                Text("·").junoMetaInk()
                            }
                            HStack(spacing: JunoSpace.hairline) {
                                JunoIconView(part.icon, size: 11)
                                    .junoMetaInk()
                                    .accessibilityHidden(true)
                                Text(part.text)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                    .junoFont(size: 11, relativeTo: .caption2)
                    .junoSecondaryInk()
                }
            }

            Spacer(minLength: JunoSpace.regular)

            CodeContextMeter(
                used: context.contextTokens,
                window: context.contextWindowTokens
            )

            if let status = context.status {
                HStack(spacing: JunoSpace.tight) {
                    CodeStatusGlyph(status, size: 12)
                    Text(status.label)
                        .junoCaption()
                        .contentTransition(.identity)
                    if isRunning, let startedAt = context.startedAt {
                        TimelineView(.periodic(from: startedAt, by: 1)) { timeline in
                            Text(Self.elapsed(from: startedAt, to: timeline.date))
                                .junoCaption()
                                .monospacedDigit()
                                .junoMetaInk()
                        }
                    }
                }
                .help(status.state.meaning)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Status: \(status.label)")
            }

            if isRunning, let stop {
                Button(action: stop) {
                    JunoIconLabel(verbatim: "Stop", icon: .stop, size: 13)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(Color.junoDanger)
                .keyboardShortcut(".", modifiers: .command)
                .help("Stop the run (⌘.)")
                .accessibilityIdentifier("juno.code.stop")
            }
        }
        .frame(maxWidth: JunoReadingMeasure.reading, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.snug)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.context-strip")
    }

    private struct SubtitlePart {
        let icon: JunoIcon
        let text: String
    }

    private var subtitleParts: [SubtitlePart] {
        var parts: [SubtitlePart] = []
        if let project = context.project, !project.isEmpty {
            parts.append(SubtitlePart(icon: .projects, text: project))
        }
        if let branch = context.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            parts.append(SubtitlePart(icon: .branch, text: branch))
        }
        if let environment = context.environment, !environment.isEmpty {
            parts.append(SubtitlePart(icon: .device, text: environment))
        }
        return parts
    }

    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

/// How full the model's context window is: a ring, and a percentage once it
/// matters.
///
/// Both numbers are the provider's own — the window from the manifest, the
/// fill from the `usage` reported on every turn — so the meter is absent until
/// there is a real measurement. A made-up count is worse than none, because it
/// invites the reader to plan around it.
public struct CodeContextMeter: View {
    let used: Int?
    let window: Int?

    public init(used: Int?, window: Int?) {
        self.used = used
        self.window = window
    }

    public var body: some View {
        if let used, let window, window > 0 {
            let fraction = min(Double(used) / Double(window), 1)
            let isTight = fraction >= 0.8
            HStack(spacing: JunoSpace.tight) {
                ZStack {
                    Circle()
                        .stroke(Color.junoHairline, lineWidth: 2)
                    Circle()
                        .trim(from: 0, to: fraction)
                        .stroke(
                            isTight ? Color.junoCaution : Color.junoMutedForeground,
                            style: StrokeStyle(lineWidth: 2, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 11, height: 11)
                .animation(JunoMotion.fast, value: fraction)

                Text("\(Int(fraction * 100))%")
                    .junoCaption()
                    .monospacedDigit()
                    .foregroundStyle(isTight ? Color.junoCaution : Color.junoMutedForeground)
            }
            .help(
                """
                \(JunoModelFormatting.contextWindow(used)) of \
                \(JunoModelFormatting.contextWindow(window)) context used. \
                Type /compact to fold older turns into a summary.
                """
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Context \(Int(fraction * 100)) percent full")
            .accessibilityIdentifier("juno.code.context-meter")
        }
    }
}
