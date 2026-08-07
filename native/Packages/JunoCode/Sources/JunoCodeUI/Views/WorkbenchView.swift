import JunoDesignSystem
import JunoCodeKit
import SwiftUI
import JunoCodeCore

private enum WorkbenchPreviewMetrics {
    static let minimumWidth: CGFloat = 380
    static let transcriptMinimumWidth: CGFloat = 440
    static let compactBreakpoint: CGFloat = 980
    static let handleWidth: CGFloat = 8
}

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
    @SceneStorage("juno.code.reviewVisible") private var reviewVisible = false
    @SceneStorage("juno.code.consoleVisible") private var consoleVisible = false
    @State private var showingNewSession = false
    /// The preview is a sibling of the transcript, not an inspector tab. A
    /// webpage needs real width and a long-lived server, so keeping its target
    /// here lets the dock survive inspector changes while still shutting down
    /// when the reader closes it or changes workspaces.
    @State private var previewTarget: CodePreviewTarget?
    @AppStorage("juno.code.previewWidth") private var storedPreviewWidth: Double = 440
    @State private var previewDragOrigin: CGFloat?
    @State private var draggingPreviewWidth: CGFloat?
    @State private var showingRemoteTasks = false
    @Environment(\.openWindow) private var openWindow
    /// Account-scoped Cloud/Remote task history. It is optional so the
    /// standalone Juno Code app and the inert preview harness keep their
    /// local-only composition without a fake remote backend.
    private let remoteTaskModel: NativeCodeModel?
    private let sidebarHeader: SidebarHeader

    /// - Parameter sidebarHeader: pinned above the session list. The host app
    ///   uses it for its product switch; the standalone Code app passes nothing.
    public init(
        model: WorkbenchModel,
        remoteTaskModel: NativeCodeModel? = nil,
        @ViewBuilder sidebarHeader: () -> SidebarHeader
    ) {
        self.model = model
        self.remoteTaskModel = remoteTaskModel
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
            detailWithPreview
        }
        // Keep the inspector on the split view rather than on its detail
        // column. AppKit backs both the inspector and NavigationSplitView with
        // NSSplitViewItems; attaching them to the detail hosting view can
        // schedule a constraint update from inside its own update pass when
        // switching between Chat and Code. The Desktop shell uses this same
        // placement, which keeps the mode switch stable on current macOS.
        .inspector(isPresented: $inspectorVisible) {
            inspectorContent
                .inspectorColumnWidth(min: 260, ideal: 320, max: 520)
        }
        .background(Color.junoCanvasWarm)
        .task {
            await model.bootstrap()
        }
        #if DEBUG
        // Responsive QA has to be able to screenshot both inspector states, and
        // `@SceneStorage` is restored by AppKit before any of our code runs.
        .onAppear {
            if CommandLine.arguments.contains("--juno-preview-inspector") {
                inspectorVisible = true
            }
        }
        #endif
        .task(id: model.selectedSessionID) {
            if let previous = controller, previous.sessionID != model.selectedSessionID {
                // Never leave a server for the old workspace alive while the
                // reader is looking at another repository.
                previewTarget = nil
                await previous.detach()
            }
            guard let sessionID = model.selectedSessionID else {
                previewTarget = nil
                controller = nil
                return
            }
            controller = await model.controller(for: sessionID)
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet(
                model: model,
                onRemoteTaskStarted: { remoteTaskModel?.refreshSoon() }
            )
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    if previewTarget == nil {
                        openPreviewForCurrentSession()
                    } else {
                        closePreview()
                    }
                } label: {
                    Label(
                        previewTarget == nil ? "Preview" : "Hide preview",
                        systemImage: previewTarget == nil
                            ? "rectangle.on.rectangle"
                            : "rectangle.on.rectangle.slash"
                    )
                }
                .help(
                    previewTarget == nil
                        ? "Open the live workspace preview"
                        : "Hide the live workspace preview"
                )
                .disabled(controller?.context == nil)
                .keyboardShortcut("p", modifiers: [.command, .option])
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    inspectorVisible.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .help("Show or hide the inspector")
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingRemoteTasks = true
                } label: {
                    Label(remoteTaskLabel, systemImage: "bolt.horizontal.circle")
                }
                .help("Follow Cloud and Remote tasks")
                .disabled(remoteTaskModel == nil)
            }
        }
        .sheet(isPresented: $showingRemoteTasks) {
            if let remoteTaskModel {
                CodeRemoteTaskMonitorView(model: remoteTaskModel)
            } else {
                ContentUnavailableView(
                    "Remote tasks unavailable",
                    systemImage: "bolt.horizontal.circle",
                    description: Text("Sign in to follow Cloud and Remote runs.")
                )
            }
        }
    }

    private var remoteTaskLabel: String {
        guard let remoteTaskModel else { return "Remote tasks" }
        let count = remoteTaskModel.tasks.filter(\.status.isActive).count
        return count == 0 ? "Remote tasks" : "Remote tasks (\(count))"
    }

    /// The live workspace preview belongs beside the reading canvas. On a
    /// narrow window it temporarily covers the canvas instead of squeezing the
    /// transcript into an unusable column; the dock's close button returns the
    /// reader to the session immediately.
    private var detailWithPreview: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < WorkbenchPreviewMetrics.compactBreakpoint
            let hasPreview = previewTarget != nil
            let paneWidth = activePreviewWidth(in: geometry.size.width)

            ZStack(alignment: .trailing) {
                detailContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(
                        .trailing,
                        hasPreview && !compact
                            ? paneWidth + WorkbenchPreviewMetrics.handleWidth
                            : 0
                    )
                    .opacity(hasPreview && compact ? 0 : 1)
                    .allowsHitTesting(!(hasPreview && compact))
                    .accessibilityHidden(hasPreview && compact)

                if let target = previewTarget {
                    HStack(spacing: 0) {
                        if !compact {
                            previewResizeHandle(
                                availableWidth: geometry.size.width
                            )
                        }
                        CodePreviewDock(
                            target: target,
                            close: closePreview,
                            openInWindow: { openPreviewWindow(target) }
                        )
                        .frame(width: compact ? geometry.size.width : paneWidth)
                        .frame(maxHeight: .infinity)
                    }
                    .background(compact ? Color.junoCanvasWarm : .clear)
                    .transition(
                        .asymmetric(
                            insertion: .move(edge: .trailing).combined(with: .opacity),
                            removal: .opacity
                        )
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(JunoMotion.fast, value: previewTarget != nil)
    }

    private func activePreviewWidth(in availableWidth: CGFloat) -> CGFloat {
        let base = draggingPreviewWidth ?? CGFloat(storedPreviewWidth)
        let maximum = max(
            WorkbenchPreviewMetrics.minimumWidth,
            availableWidth - WorkbenchPreviewMetrics.transcriptMinimumWidth
        )
        return min(max(base, WorkbenchPreviewMetrics.minimumWidth), maximum)
    }

    private func previewResizeHandle(availableWidth: CGFloat) -> some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1)
            .frame(width: WorkbenchPreviewMetrics.handleWidth)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let origin =
                            previewDragOrigin
                            ?? activePreviewWidth(in: availableWidth)
                        previewDragOrigin = origin
                        let candidate = origin - value.translation.width
                        let maximum = max(
                            WorkbenchPreviewMetrics.minimumWidth,
                            availableWidth - WorkbenchPreviewMetrics.transcriptMinimumWidth
                        )
                        draggingPreviewWidth = min(
                            max(candidate, WorkbenchPreviewMetrics.minimumWidth),
                            maximum
                        )
                    }
                    .onEnded { _ in
                        if let draggingPreviewWidth {
                            storedPreviewWidth = Double(draggingPreviewWidth)
                        }
                        previewDragOrigin = nil
                        draggingPreviewWidth = nil
                    }
            )
            .help("Drag to resize the Preview pane")
            .accessibilityHidden(true)
    }

    private func openPreviewForCurrentSession() {
        guard let root = controller?.context?.access.rootURL else { return }
        previewTarget = CodePreviewTarget(
            workspaceRoot: root,
            sessionID: controller?.sessionID
        )
    }

    private func closePreview() {
        previewTarget = nil
    }

    private func openPreviewWindow(_ target: CodePreviewTarget) {
        openWindow(id: CodePreviewScene.windowID, value: target)
    }

    @ViewBuilder
    private var detailContent: some View {
        if let controller {
            CodeSessionCanvas(
                controller: controller,
                model: model,
                showsReview: $reviewVisible,
                showsConsole: $consoleVisible
            )
        } else {
            EmptyCanvasView(model: model, showingNewSession: $showingNewSession)
        }
    }

    @ViewBuilder
    private var inspectorContent: some View {
        if let controller {
            CodeSessionInspector(
                controller: controller,
                openPreview: { openPreviewForCurrentSession() }
            )
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
