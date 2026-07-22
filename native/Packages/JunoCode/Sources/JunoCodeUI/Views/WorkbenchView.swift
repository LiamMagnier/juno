import JunoDesignSystem
import SwiftUI
import JunoCodeCore

/// The Juno Code three-zone workbench: sessions sidebar, agent canvas, and
/// the inspector pane.
public struct WorkbenchView<SidebarHeader: View>: View {
    @Bindable private var model: WorkbenchModel
    @State private var controller: SessionController?
    /// Scene-restored so it survives being unmounted — the host app can swap
    /// this whole view out for another product mode and back, and the reader
    /// should find the inspector as they left it.
    /// Starts **closed**. The rejected build opened it by default at a 360pt
    /// ideal width, so a fresh session gave a third of the window to the words
    /// "No changes yet". It is opened by the reader, or automatically once a
    /// session actually has something to inspect.
    @SceneStorage("juno.code.inspectorVisible") private var inspectorVisible = false
    @State private var showingNewSession = false
    private let sidebarHeader: SidebarHeader

    /// - Parameter sidebarHeader: pinned above the session list. The host app
    ///   uses it for its product switch; the standalone Code app passes nothing.
    public init(
        model: WorkbenchModel,
        @ViewBuilder sidebarHeader: () -> SidebarHeader
    ) {
        self.model = model
        self.sidebarHeader = sidebarHeader()
    }

    public var body: some View {
        NavigationSplitView {
            SidebarView(model: model, showingNewSession: $showingNewSession)
                // Outside the sidebar's own `.searchable`, so the host's switch
                // sits above the search field rather than between it and the
                // session list.
                .safeAreaInset(edge: .top, spacing: 0) { sidebarHeader }
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 400)
        } detail: {
            detailContent
                .inspector(isPresented: $inspectorVisible) {
                    inspectorContent
                        .inspectorColumnWidth(min: 260, ideal: 320, max: 520)
                }
        }
        .background(JunoCodeTheme.background)
        .task {
            await model.bootstrap()
        }
        .task(id: model.selectedSessionID) {
            if let previous = controller, previous.sessionID != model.selectedSessionID {
                await previous.detach()
            }
            guard let sessionID = model.selectedSessionID else {
                controller = nil
                return
            }
            controller = await model.controller(for: sessionID)
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet(model: model)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    inspectorVisible.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .help("Show or hide the inspector")
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        if let controller {
            AgentCanvasView(controller: controller, model: model)
        } else {
            EmptyCanvasView(model: model, showingNewSession: $showingNewSession)
        }
    }

    @ViewBuilder
    private var inspectorContent: some View {
        if let controller {
            InspectorView(controller: controller)
        } else {
            // Compact rather than a full-height `ContentUnavailableView`: with
            // no session there is nothing to inspect, and a large placeholder
            // panel is worse than a small one.
            VStack(spacing: JunoSpace.snug) {
                Text("No session selected")
                    .font(.system(.callout, weight: .medium))
                Text("Choose a session to see its changes, terminal and tests.")
                    .junoCaption()
                    .multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .padding(JunoSpace.regular)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }
}

/// Empty state shown when no session is selected.
///
/// Compact and useful rather than a giant centred glyph. The rejected build put
/// a 42pt symbol and a large-title wordmark in the middle of an otherwise empty
/// window, which spent the entire canvas saying the name of the screen the
/// reader is already looking at.
struct EmptyCanvasView: View {
    let model: WorkbenchModel
    @Binding var showingNewSession: Bool

    private var workspaceName: String {
        model.workspaces.first?.descriptor.displayName ?? "your workspace"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Start a session")
                    .junoEmptyTitle()
                Text("Juno Code works on \(workspaceName) with your approval on every change.")
                    .junoCaption()
            }

            VStack(spacing: 1) {
                ForEach(Self.suggestions, id: \.self) { suggestion in
                    Button {
                        showingNewSession = true
                    } label: {
                        HStack(spacing: JunoSpace.snug) {
                            Image(systemName: "sparkle")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.junoAccent)
                                .frame(width: 14)
                            Text(suggestion).junoRowLabel()
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.vertical, JunoSpace.snug + 1)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoBorder)
            )
        }
        .frame(maxWidth: 460, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .padding(JunoSpace.region)
    }

    /// Real starting prompts rather than decoration; each opens the new-session
    /// sheet where the workspace and permission mode are chosen.
    static let suggestions = [
        "Explain this codebase",
        "Find and fix a bug",
        "Add tests for recent changes",
        "Review my uncommitted work",
    ]
}

public extension WorkbenchView where SidebarHeader == EmptyView {
    /// The standalone Juno Code app has no product switch to host.
    init(model: WorkbenchModel) {
        self.init(model: model, sidebarHeader: { EmptyView() })
    }
}
