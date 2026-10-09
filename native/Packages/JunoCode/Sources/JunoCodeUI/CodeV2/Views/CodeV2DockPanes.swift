import AppKit
import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

// Dock › Terminal, Files and Preview for an env-server thread. Kept plain on
// purpose: the full visual pass restyles the dock as a whole.

// MARK: - Terminal

/// A shell in the thread's folder, run by the env server: the scrollback in
/// mono, a line field that sends with Return, and ⌃C / ⌃D / Tab as keys.
public struct CodeV2TerminalPane: View {
    let terminal: CodeV2EnvTerminal
    /// False in previews and snapshots: never start a shell.
    var autoOpen = true

    @State private var input = ""
    @FocusState private var focused: Bool

    public init(terminal: CodeV2EnvTerminal, autoOpen: Bool = true) {
        self.terminal = terminal
        self.autoOpen = autoOpen
    }

    /// Mono cell at the meta size, for cols × rows from the pane's size.
    private static let cell = CGSize(width: 7.2, height: 16)

    public var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView([.vertical]) {
                    Text(terminal.screen.text.isEmpty ? " " : terminal.screen.text)
                        .font(Studio.Font.mono)
                        .foregroundStyle(Studio.Ink.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(JunoSpace.cozy)
                    Color.clear.frame(height: 1).id("end")
                }
                .onChange(of: terminal.screen) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                let cols = Int((size.width - 2 * JunoSpace.cozy) / Self.cell.width)
                let rows = Int((size.height - 2 * JunoSpace.cozy) / Self.cell.height)
                Task { await terminal.resize(cols: cols, rows: rows) }
            }
            footer
        }
        .background(Studio.Surface.canvas)
        .task {
            guard autoOpen, terminal.phase == .idle else { return }
            await terminal.open()
            focused = true
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.code.v2.dock.terminal")
    }

    @ViewBuilder
    private var footer: some View {
        switch terminal.phase {
        case let .exited(code):
            HStack(spacing: JunoSpace.snug) {
                Text(code.map { "The shell exited with code \($0)." } ?? "The shell exited.")
                    .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                Spacer()
                Button("New shell") { Task { await terminal.restart() } }
                    .buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 40)
            .studioHairline(.top)
        case let .failed(message):
            HStack(spacing: JunoSpace.snug) {
                Text(message).font(Studio.Font.meta).foregroundStyle(Studio.Ink.danger).lineLimit(2)
                Spacer()
                Button("Try again") { Task { await terminal.restart() } }
                    .buttonStyle(StudioQuietButtonStyle()).contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 40)
            .studioHairline(.top)
        case .idle, .opening, .running:
            HStack(spacing: JunoSpace.snug) {
                Text("$").font(Studio.Font.mono).foregroundStyle(Studio.Ink.tertiary)
                TextField(terminal.isRunning ? "Type a command" : "Starting the shell", text: $input)
                    .textFieldStyle(.plain)
                    .font(Studio.Font.mono)
                    .focused($focused)
                    .disabled(!terminal.isRunning)
                    .onSubmit(submit)
                    .onKeyPress(.tab) {
                        Task { await terminal.write(input + CodeV2TerminalKey.tab.bytes) }
                        input = ""
                        return .handled
                    }
                    .onKeyPress(.upArrow) { send(.up) }
                    .onKeyPress(.downArrow) { send(.down) }
                    .accessibilityLabel("Terminal input")
                Button { Task { await terminal.send(control: .interrupt) } } label: {
                    CodeV2Keycap(keys: "⌃C")
                }
                .buttonStyle(.plain).contentShape(.rect)
                .keyboardShortcut("c", modifiers: [.control])
                .disabled(!terminal.isRunning)
                .help("Interrupt (⌃C)")
                .accessibilityLabel("Interrupt")
            }
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 40)
            .studioHairline(.top)
        }
    }

    private func send(_ key: CodeV2TerminalKey) -> KeyPress.Result {
        guard input.isEmpty, terminal.isRunning else { return .ignored }
        Task { await terminal.send(control: key) }
        return .handled
    }

    private func submit() {
        let line = input
        input = ""
        Task { await terminal.send(line: line) }
        focused = true
    }
}

// MARK: - Files

/// The thread's folder as a lazy tree; a file opens in the workspace's
/// document sheet, as Open File does.
struct CodeV2FilesPane: View {
    let controller: SessionController

    var body: some View {
        if controller.context == nil {
            Text("This thread's folder is not open on this Mac.")
                .font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            List {
                WorkspaceTreeRows(controller: controller, entries: controller.rootEntries) { entry in
                    guard !entry.isDirectory else { return }
                    Task { await controller.review.open(entry.path, using: controller) }
                }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("juno.code.v2.dock.files")
        }
    }
}

// MARK: - Workspace

/// What an env-server thread's dock borrows from the Studio session that
/// holds its place in the sidebar: the folder tree, and the preview lease.
@MainActor
public struct CodeV2DockWorkspace {
    let controller: SessionController
    let openPreviewWindow: (CodePreviewTarget) -> Void

    public init(controller: SessionController, openPreviewWindow: @escaping (CodePreviewTarget) -> Void) {
        self.controller = controller
        self.openPreviewWindow = openPreviewWindow
    }

    var previewTarget: CodePreviewTarget? {
        guard let root = controller.context?.access.rootURL else { return nil }
        return CodePreviewTarget(workspaceRoot: root, sessionID: controller.sessionID)
    }
}

// MARK: - Connected-agent approvals

/// The Studio approval card for a connected agent's request that no thread
/// on screen holds: computer use through the bridge, or a subscription
/// subagent's approval. One at a time, oldest first, over the window.
public struct CodeV2ConnectedApprovalCard: View {
    var approvals: CodeV2ConnectedApprovals

    public init(approvals: CodeV2ConnectedApprovals = .shared) {
        self.approvals = approvals
    }

    public var body: some View {
        let unclaimed = approvals.unclaimed
        Group {
            if let first = unclaimed.first {
                CodeV2ConnectedApprovalView(item: first, position: (1, unclaimed.count)) { decision in
                    approvals.respond(first.id, decision)
                }
                .frame(maxWidth: Studio.Metrics.measure)
                .background(
                    RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous).fill(Studio.Surface.raised)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Studio.Radius.menu, style: .continuous).strokeBorder(Studio.Surface.hairline)
                )
                .shadow(color: .black.opacity(0.16), radius: 20, y: 10)
                .padding(JunoSpace.regular)
                .transition(.opacity)
            }
        }
        .onAppear { approvals.attachPresenter() }
        .onDisappear { approvals.detachPresenter() }
        .accessibilityIdentifier("juno.code.v2.connected-approval")
    }
}

/// One connected-agent request as the composer takeover draws approvals,
/// with the target's crop when the bridge sent one.
struct CodeV2ConnectedApprovalView: View {
    let item: CodeV2ConnectedApprovals.Pending
    var position: (index: Int, count: Int) = (1, 1)
    let respond: (CodeV2.ApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let crop = item.crop, let image = NSImage(data: crop) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 160)
                    .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.field, style: .continuous))
                    .padding([.horizontal, .top], JunoSpace.regular)
                    .accessibilityLabel("Where it will act")
            }
            CodeV2ApprovalTakeover(request: item.request, position: position, respond: respond)
        }
    }
}
