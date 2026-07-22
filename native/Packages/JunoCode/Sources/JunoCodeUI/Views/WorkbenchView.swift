import SwiftUI
import JunoCodeCore

/// The Juno Code three-zone workbench: sessions sidebar, agent canvas, and
/// the inspector pane.
public struct WorkbenchView: View {
    @Bindable private var model: WorkbenchModel
    @State private var controller: SessionController?
    @State private var inspectorVisible = true
    @State private var showingNewSession = false

    public init(model: WorkbenchModel) {
        self.model = model
    }

    public var body: some View {
        NavigationSplitView {
            SidebarView(model: model, showingNewSession: $showingNewSession)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 400)
        } detail: {
            detailContent
                .inspector(isPresented: $inspectorVisible) {
                    inspectorContent
                        .inspectorColumnWidth(min: 280, ideal: 360, max: 560)
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
            ContentUnavailableView(
                "No session",
                systemImage: "square.on.square.dashed",
                description: Text("Select or create a code session to inspect its changes.")
            )
        }
    }
}

/// Empty state shown when no session is selected.
struct EmptyCanvasView: View {
    let model: WorkbenchModel
    @Binding var showingNewSession: Bool

    var body: some View {
        VStack(spacing: JunoCodeTheme.Spacing.content) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(.secondary)
            Text("Juno Code")
                .font(.largeTitle.weight(.semibold))
            Text("Open a workspace and start a session to work on your code with the agent.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button {
                showingNewSession = true
            } label: {
                Label("New Code Session", systemImage: "plus")
                    .padding(.horizontal, JunoCodeTheme.Spacing.compact)
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)
            .tint(JunoCodeTheme.accent)
            .keyboardShortcut("n", modifiers: .command)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JunoCodeTheme.background)
    }
}
