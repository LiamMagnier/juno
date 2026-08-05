import JunoCodeUI
import JunoDesignSystem
import JunoSimulator
import SwiftUI

#if canImport(AppKit)
import AppKit
#endif

/// Docks the Simulator pane beside the Code session as a real sibling column.
///
/// **Not an inspector.** ``DesktopCodeWorkspace`` carries the bisected report:
/// an `.inspector` attached to the detail column of a `NavigationSplitView`
/// makes `NSHostingView` call `setNeedsUpdateConstraints:` from inside its own
/// `updateConstraints` and the process takes SIGTRAP. That window already spends
/// its one inspector on ``CodeSessionInspector``, attached to the split view.
/// So the simulator uses the other established shape in this app —
/// ``DesktopArtifactDock``'s: a trailing inset on the content, with the pane
/// drawn in the room it reserved. A SwiftUI overlay is a sibling in the same
/// layout pass, so the constraint machinery never hears about it.
///
/// The existing web `CodePreviewScene` is untouched: a web project keeps its
/// preview window, and this pane only ever appears for an Apple project.
struct DesktopSimulatorDock<Content: View>: View {
    let model: SimulatorPaneModel?
    let close: () -> Void
    private let content: Content

    init(
        model: SimulatorPaneModel?,
        close: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.model = model
        self.close = close
        self.content = content()
    }

    /// Same width model as the artifact canvas, so two docked columns in the
    /// same app cannot behave differently under the same drag.
    @AppStorage("juno.code.simulatorWidth") private var storedWidth: Double = 0
    @State private var containerWidth: CGFloat = 0
    @State private var dragOrigin: CGFloat?
    @State private var draggingWidth: CGFloat?
    @State private var showingResizeCursor = false

    private static var handleWidth: CGFloat { JunoSpace.snug }
    /// A simulator narrower than this shows a device too small to read.
    private static var minimumPane: CGFloat { 360 }
    private static var minimumTranscript: CGFloat { 380 }
    /// Below this the column cannot hold a conversation and a device at once.
    private static var sideBySideWidth: CGFloat { 940 }

    private var isCompact: Bool {
        containerWidth > 0 && containerWidth < Self.sideBySideWidth
    }

    private var transcriptIsCovered: Bool { model != nil && isCompact }

    private var reservedWidth: CGFloat {
        guard model != nil, !isCompact else { return 0 }
        return paneWidth + Self.handleWidth
    }

    private func bounds(in container: CGFloat) -> (minimum: CGFloat, maximum: CGFloat) {
        let minimum = min(Self.minimumPane, max(Self.minimumTranscript, container - Self.minimumTranscript))
        let maximum = max(minimum, min((container * 0.6).rounded(), container - Self.minimumTranscript))
        return (minimum, maximum)
    }

    private func clamp(_ width: CGFloat, in container: CGFloat) -> CGFloat {
        let range = bounds(in: container)
        return min(max(width, range.minimum), range.maximum)
    }

    private var paneWidth: CGFloat {
        guard containerWidth > 0 else { return Self.minimumPane }
        if let draggingWidth { return clamp(draggingWidth, in: containerWidth) }
        guard storedWidth > 0 else { return clamp((containerWidth * 0.42).rounded(), in: containerWidth) }
        return clamp(CGFloat(storedWidth), in: containerWidth)
    }

    /// The conversation is hidden, never removed — the same reason
    /// ``DesktopArtifactDock`` spells out at length: a SwiftUI view that leaves
    /// the hierarchy takes its `@State` with it, and that state is the user's
    /// half-typed message, their model choice, and a live voice dock.
    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(transcriptIsCovered ? 0 : 1)
            .allowsHitTesting(!transcriptIsCovered)
            .disabled(transcriptIsCovered)
            .accessibilityHidden(transcriptIsCovered)
            .padding(.trailing, reservedWidth)
            .overlay(alignment: .trailing) { paneColumn }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
    }

    @ViewBuilder
    private var paneColumn: some View {
        if let model {
            HStack(spacing: 0) {
                if !isCompact { resizeHandle }
                SimulatorPane(model: model, close: close)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .frame(width: isCompact ? nil : paneWidth)
            }
            .background {
                if isCompact { Color.junoCanvasWarm }
            }
            .transition(
                .asymmetric(
                    insertion: .offset(x: DesktopChatMotion.canvasSlide).combined(with: .opacity),
                    removal: .opacity
                )
            )
            // Closing the pane must stop the capture at once — a frame loop that
            // outlives the surface justifying it is a camera nobody asked for.
            .onDisappear { model.paneClosed() }
        }
    }

    private var resizeHandle: some View {
        Rectangle()
            .fill(Color.junoHairline)
            .frame(width: 1)
            .frame(width: Self.handleWidth)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let origin = dragOrigin ?? paneWidth
                        dragOrigin = origin
                        draggingWidth = origin - value.translation.width
                    }
                    .onEnded { _ in
                        if let draggingWidth, containerWidth > 0 {
                            storedWidth = Double(clamp(draggingWidth, in: containerWidth))
                        }
                        dragOrigin = nil
                        draggingWidth = nil
                    }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    guard !showingResizeCursor else { return }
                    showingResizeCursor = true
                    NSCursor.resizeLeftRight.push()
                case .ended:
                    guard showingResizeCursor else { return }
                    showingResizeCursor = false
                    NSCursor.pop()
                }
            }
            // A pushed cursor outlives the view that pushed it; `.ended` never
            // arrives if the handle goes away under the pointer.
            .onDisappear {
                guard showingResizeCursor else { return }
                showingResizeCursor = false
                NSCursor.pop()
            }
            .help("Drag to resize the Simulator pane.")
            .accessibilityHidden(true)
    }
}

/// Owns the simulator session for one workspace, and ends it when that
/// workspace, session or account goes away.
///
/// Keyed by workspace: switching projects tears the old session down (build,
/// logs, capture, and the app on the device) before a new one is created, so two
/// workspaces can never share a simulator or leak one into the background.
@MainActor
@Observable
final class DesktopSimulatorHost {
    private(set) var model: SimulatorPaneModel?
    private(set) var workspaceKey: String?
    /// Off until the user opens the pane, or a task asks for it. Discovery
    /// spawns `xcodebuild`, and that is not something to do speculatively for
    /// every Code session on every Mac.
    private(set) var isOpen = false

    func open(workspaceKey: String, workspaceRoot: URL) {
        if self.workspaceKey != workspaceKey { tearDown() }
        if model == nil {
            let container = FileManager.default
                .urls(for: .applicationSupportDirectory, in: .userDomainMask)
                .first?
                .appendingPathComponent("Juno", isDirectory: true)
                ?? FileManager.default.temporaryDirectory
            let session = SimulatorSessionService(
                configuration: .init(
                    workspaceKey: workspaceKey,
                    workspaceRoot: workspaceRoot,
                    containerDirectory: container
                )
            )
            model = SimulatorPaneModel(session: session)
            self.workspaceKey = workspaceKey
        }
        isOpen = true
    }

    /// Close the pane without cancelling the coding task. The session stays
    /// alive (a task may still be building) but the capture loop stops.
    func closePane() {
        isOpen = false
        model?.paneClosed()
    }

    /// End everything. Called on workspace change, session change, sign-out and
    /// quit — the four events that must never leave a build or a log stream
    /// running.
    func tearDown() {
        guard let model else {
            isOpen = false
            workspaceKey = nil
            return
        }
        self.model = nil
        workspaceKey = nil
        isOpen = false
        Task { await model.shutDown() }
    }
}
