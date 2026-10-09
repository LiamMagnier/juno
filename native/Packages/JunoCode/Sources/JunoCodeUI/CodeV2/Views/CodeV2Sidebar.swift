// Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
// (a sidebar that is a list of work: state by position, Settled folded at
// the end, project names as muted context on each row).
import SwiftUI
import JunoDesignSystem

/// One session in the Code sidebar (code-v4 TARGET §3).
public struct CodeSidebarSession: Identifiable, Hashable, Sendable {
    public enum State: Hashable, Sendable { case idle, working, needsYou, failed }

    public var id: String
    public var title: String
    /// Appended in muted ink: "Move totals to the server storefront".
    public var project: String?
    public var updatedAt: Date
    public var state: State
    public var isUnread: Bool

    public init(id: String, title: String, project: String?, updatedAt: Date, state: State, isUnread: Bool = false) {
        self.id = id
        self.title = title
        self.project = project
        self.updatedAt = updatedAt
        self.state = state
        self.isUnread = isUnread
    }

    /// Needs you, then working, then the rest by recency. No headers.
    public static func ordered(_ sessions: [CodeSidebarSession]) -> [CodeSidebarSession] {
        func rank(_ state: State) -> Int {
            switch state {
            case .needsYou: 0
            case .working: 1
            default: 2
            }
        }
        return sessions.sorted { a, b in
            rank(a.state) == rank(b.state) ? a.updatedAt > b.updatedAt : rank(a.state) < rank(b.state)
        }
    }

    /// "12m", "4h", "3d", "now".
    public static func age(_ date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3_600)h" }
        if seconds < 86_400 * 7 { return "\(seconds / 86_400)d" }
        return "\(seconds / (86_400 * 7))w"
    }
}

/// A session's row: the title in ink, the project after it in muted ink, and
/// one trailing slot: the age at rest, a spinner while it works, a raised
/// hand when it needs you, both in the signal coral. Hover trades the slot
/// for Archive.
public struct CodeSidebarSessionRow: View {
    let session: CodeSidebarSession
    var now: Date
    var archive: (() -> Void)?

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(session: CodeSidebarSession, now: Date = Date(), archive: (() -> Void)? = nil) {
        self.session = session
        self.now = now
        self.archive = archive
    }

    public var body: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("\(Text(session.title).foregroundStyle(Color.junoForeground).fontWeight(session.isUnread ? .medium : .regular))\(Text(session.project.map { "  " + $0 } ?? "").foregroundStyle(Studio.Ink.secondary))")
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: JunoSpace.tight)
            trailing
                .frame(minWidth: 20, alignment: .trailing)
        }
        .padding(.leading, 6)
        .contentShape(.rect)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var trailing: some View {
        if hovering, let archive {
            Button(action: archive) { JunoIconView(.archive, size: 13) }
                .buttonStyle(.plain)
                .foregroundStyle(Studio.Ink.secondary)
                .frame(width: 20, height: 20)
                .help("Archive")
                .accessibilityLabel("Archive")
        } else {
            switch session.state {
            case .working:
                Group {
                    if reduceMotion {
                        Circle().stroke(Studio.Signal.edge, lineWidth: 1.4)
                    } else {
                        StudioSpinner(color: Studio.Signal.edge, lineWidth: 1.4)
                    }
                }
                .frame(width: 11, height: 11)
                .frame(width: 20, height: 20)
            case .needsYou:
                JunoIconView(.hand, size: 13)
                    .foregroundStyle(Studio.Signal.edge)
                    .frame(width: 20, height: 20)
            case .failed:
                Text(CodeSidebarSession.age(session.updatedAt, now: now))
                    .studioType(.small).monospacedDigit()
                    .foregroundStyle(Studio.Ink.danger)
            case .idle:
                Text(CodeSidebarSession.age(session.updatedAt, now: now))
                    .studioType(.small).monospacedDigit()
                    .foregroundStyle(Studio.Ink.secondary)
            }
        }
    }

    private var accessibilityText: String {
        var parts = [session.title]
        if let project = session.project { parts.append(project) }
        switch session.state {
        case .working: parts.append("working")
        case .needsYou: parts.append("needs you")
        case .failed: parts.append("failed")
        case .idle: break
        }
        return parts.joined(separator: ", ")
    }
}

/// The two rows above the list (TARGET §3): Search with New at its right,
/// then the projects filter.
public struct CodeSidebarHeader<ProjectMenu: View>: View {
    let projectTitle: String
    let search: () -> Void
    let newSession: () -> Void
    @ViewBuilder let projectMenu: () -> ProjectMenu

    public init(
        projectTitle: String, search: @escaping () -> Void, newSession: @escaping () -> Void,
        @ViewBuilder projectMenu: @escaping () -> ProjectMenu
    ) {
        self.projectTitle = projectTitle
        self.search = search
        self.newSession = newSession
        self.projectMenu = projectMenu
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: JunoSpace.tight) {
                Button(action: search) {
                    HStack(spacing: JunoSpace.snug + 2) {
                        JunoIconView(.search, size: 15)
                        Text("Search")
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Color.junoSidebarInk)
                    .padding(.leading, JunoSpace.snug)
                    .frame(height: 30)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Search sessions and commands (⌘K)")
                .accessibilityIdentifier("juno.code.sidebar.search")
                Button(action: newSession) {
                    JunoIconView(.compose, size: 15)
                }
                .buttonStyle(StudioIconButtonStyle())
                .help("New session (⌘N)")
                .accessibilityLabel("New session")
                .accessibilityIdentifier("juno.code.new-conversation")
            }
            Menu {
                projectMenu()
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    Text(projectTitle)
                    JunoIconView(.chevronDown, size: 9)
                }
                .studioType(.small)
                .foregroundStyle(Studio.Ink.secondary)
                .padding(.leading, JunoSpace.snug)
                .frame(height: 28)
                .contentShape(.rect)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel("Projects")
            .accessibilityValue(projectTitle)
        }
    }
}

/// `Archived (12) ⌄`: the fold at the end of the list, a hairline running to
/// its chevron.
public struct CodeSidebarFold: View {
    let title: String
    let count: Int
    @Binding var isOpen: Bool

    public init(title: String, count: Int, isOpen: Binding<Bool>) {
        self.title = title
        self.count = count
        self._isOpen = isOpen
    }

    public var body: some View {
        Button { isOpen.toggle() } label: {
            HStack(spacing: JunoSpace.snug) {
                Text("\(title) (\(count))").studioType(.smallMedium).monospacedDigit()
                Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                JunoIconView(.chevronDown, size: 9)
                    .rotationEffect(.degrees(isOpen ? 180 : 0))
            }
            .foregroundStyle(Studio.Ink.secondary)
            .padding(.leading, 6)
            .frame(height: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityValue(isOpen ? "Shown" : "Hidden")
    }
}
