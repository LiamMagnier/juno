import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// One toggle on the thread's title bar: a rail the reader can open or close.
///
/// The window owns the state — whether the review pane or the context rail is
/// up is scene state, not session state — so the header takes the value and
/// the action and draws a pressed glyph.
public struct CodeThreadRailToggle: Identifiable {
    public let id: String
    public let icon: JunoIcon
    public let label: String
    public let help: String
    public let isOn: Bool
    public let isEnabled: Bool
    public let toggle: () -> Void

    public init(
        id: String,
        icon: JunoIcon,
        label: String,
        help: String,
        isOn: Bool,
        isEnabled: Bool = true,
        toggle: @escaping () -> Void
    ) {
        self.id = id
        self.icon = icon
        self.label = label
        self.help = help
        self.isOn = isOn
        self.isEnabled = isEnabled
        self.toggle = toggle
    }
}

/// What a thread's title bar states: the title, where it runs, how it is
/// going. Values rather than a controller so the cloud and relay canvases
/// draw the same strip from their own records.
public struct CodeThreadContext: Equatable, Sendable {
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

/// The thread's title bar: which project, which thread, and the rails beside
/// it.
///
/// Left to right: the project's folder mark, the thread's title, and an
/// ellipsis menu of the thread's own actions; then, quietly, the run's status
/// and elapsed time and how full the context is; then Share and the rail
/// toggles on the right. The toolbar above owns window-level actions; this
/// strip owns the thread.
///
/// It takes values rather than a controller so the cloud and relay canvases,
/// which have no `SessionController`, draw the same strip from their own
/// records.
public struct CodeThreadHeader<ThreadMenu: View>: View {
    /// Kept so existing call sites that spell `CodeThreadHeader.Context` keep
    /// compiling; the type itself is ``CodeThreadContext`` so it is the same
    /// type under every menu.
    public typealias Context = CodeThreadContext

    private let context: Context
    private let stop: (() -> Void)?
    private let share: (() -> Void)?
    private let rails: [CodeThreadRailToggle]
    private let menu: ThreadMenu


    /// - Parameters:
    ///   - stop: stops the run; drawn only while one is in flight.
    ///   - share: the Share action, or nil where the transport offers none.
    ///   - rails: the panes beside the thread the reader can toggle.
    ///   - menu: the ellipsis menu's items — rename, delete, stop, reveal.
    public init(
        _ context: Context,
        stop: (() -> Void)? = nil,
        share: (() -> Void)? = nil,
        rails: [CodeThreadRailToggle] = [],
        @ViewBuilder menu: () -> ThreadMenu
    ) {
        self.context = context
        self.stop = stop
        self.share = share
        self.rails = rails
        self.menu = menu()
    }

    /// The same strip, read live off a local session.
    public init(
        controller: SessionController,
        stop: (() -> Void)? = nil,
        share: (() -> Void)? = nil,
        rails: [CodeThreadRailToggle] = [],
        @ViewBuilder menu: () -> ThreadMenu
    ) {
        self.init(
            Self.context(for: controller),
            stop: stop,
            share: share,
            rails: rails,
            menu: menu
        )
    }

    static func context(for controller: SessionController) -> Context {
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
        )
    }

    private var isRunning: Bool { context.status?.isActive == true }

    private var hasMenu: Bool { ThreadMenu.self != EmptyView.self }

    public var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            JunoIconView(.folderOpen, size: 14)
                .junoSecondaryInk()
                .accessibilityHidden(true)

            Text(context.title)
                .junoFont(size: 13, relativeTo: .subheadline, weight: .semibold)
                .junoInk()
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityAddTraits(.isHeader)
                .help(subtitle)

            if hasMenu {
                Menu {
                    menu
                } label: {
                    JunoIconView(.ellipsis, size: 14)
                        .junoSecondaryInk()
                        .frame(width: 24, height: 24)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Thread actions")
                .accessibilityLabel("Thread actions")
                .accessibilityIdentifier("juno.code.thread.menu")
            }

            Spacer(minLength: JunoSpace.regular)

            CodeContextMeter(
                used: context.contextTokens,
                window: context.contextWindowTokens
            )

            if let status = context.status {
                HStack(spacing: JunoSpace.tight) {
                    CodeStatusGlyph(status, size: 11)
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
                    JunoIconLabel(verbatim: "Stop", icon: .stop, size: 12)
                        .junoCaption()
                        .foregroundStyle(Color.junoDanger)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(".", modifiers: .command)
                .help("Stop the run (⌘.)")
                .accessibilityIdentifier("juno.code.stop")
            }

            if let share {
                Button(action: share) {
                    HStack(spacing: JunoSpace.hairline) {
                        JunoIconView(.share, size: 13)
                        Text("Share")
                    }
                    .junoCaption()
                    .junoInk()
                    .padding(.horizontal, JunoSpace.snug)
                    .frame(height: 26)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                            .fill(Color.junoMuted.opacity(0.7))
                    )
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
                .help("Share this thread")
                .accessibilityIdentifier("juno.code.thread.share")
            }

            ForEach(rails) { rail in
                Button(action: rail.toggle) {
                    JunoIconView(rail.icon, size: 14)
                        .foregroundStyle(rail.isOn ? Color.junoForeground : Color.junoMutedForeground)
                        .frame(width: 26, height: 26)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                                .fill(rail.isOn ? Color.junoMuted : Color.clear)
                        )
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.junoPress)
                .disabled(!rail.isEnabled)
                .help(rail.help)
                .accessibilityLabel(rail.label)
                .accessibilityValue(rail.isOn ? "Open" : "Closed")
                .accessibilityIdentifier("juno.code.thread.rail.\(rail.id)")
            }
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.snug)
        .frame(height: 44)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.context-strip")
    }

    /// "juno · main · Worktree" — the facts the title used to carry on a second
    /// line, now the title's tooltip. The rail beside the thread states them
    /// in full.
    private var subtitle: String {
        var parts: [String] = []
        if let project = context.project, !project.isEmpty { parts.append(project) }
        if let branch = context.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            parts.append(branch)
        }
        if let environment = context.environment, !environment.isEmpty { parts.append(environment) }
        return parts.joined(separator: " · ")
    }

    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

extension CodeThreadHeader where ThreadMenu == EmptyView {
    public init(
        _ context: Context,
        stop: (() -> Void)? = nil,
        share: (() -> Void)? = nil,
        rails: [CodeThreadRailToggle] = []
    ) {
        self.init(context, stop: stop, share: share, rails: rails) { EmptyView() }
    }

    public init(
        controller: SessionController,
        stop: (() -> Void)? = nil,
        share: (() -> Void)? = nil,
        rails: [CodeThreadRailToggle] = []
    ) {
        self.init(controller: controller, stop: stop, share: share, rails: rails) { EmptyView() }
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
