import AppKit
import JunoCodeUI
import JunoDesignSystem
import SwiftUI

/// Hosts the web preview as a sibling of the Code canvas.
///
/// The native inspector is intentionally kept for changes, activity and
/// sub-agents. A webpage needs substantially more width than that rail can
/// offer, so this dock uses the same reserved-trailing-space pattern as the
/// Simulator pane. It also keeps the transcript alive underneath a compact
/// window: collapsing the dock never destroys a half-written prompt.
struct DesktopCodePreviewDock<Content: View>: View {
    let target: CodePreviewTarget?
    let close: () -> Void
    let openInWindow: () -> Void
    private let content: Content

    init(
        target: CodePreviewTarget?,
        close: @escaping () -> Void,
        openInWindow: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.target = target
        self.close = close
        self.openInWindow = openInWindow
        self.content = content()
    }

    @AppStorage("juno.code.previewWidth") private var storedWidth: Double = 0
    @State private var containerWidth: CGFloat = 0
    @State private var dragOrigin: CGFloat?
    @State private var draggingWidth: CGFloat?
    @State private var showingResizeCursor = false

    private static var handleWidth: CGFloat { JunoSpace.snug }
    private static var minimumPane: CGFloat { 380 }
    private static var minimumTranscript: CGFloat { 440 }
    private static var sideBySideWidth: CGFloat { 980 }

    private var isCompact: Bool {
        containerWidth > 0 && containerWidth < Self.sideBySideWidth
    }

    private var canvasIsCovered: Bool {
        target != nil && isCompact
    }

    private var reservedWidth: CGFloat {
        guard target != nil, !isCompact else { return 0 }
        return paneWidth + Self.handleWidth
    }

    private func bounds(in container: CGFloat) -> (minimum: CGFloat, maximum: CGFloat) {
        let minimum = min(
            Self.minimumPane,
            max(Self.minimumTranscript, container - Self.minimumTranscript)
        )
        let maximum = max(
            minimum,
            min((container * 0.62).rounded(), container - Self.minimumTranscript)
        )
        return (minimum, maximum)
    }

    private func clamp(_ width: CGFloat, in container: CGFloat) -> CGFloat {
        let range = bounds(in: container)
        return min(max(width, range.minimum), range.maximum)
    }

    private var paneWidth: CGFloat {
        guard containerWidth > 0 else { return Self.minimumPane }
        if let draggingWidth {
            return clamp(draggingWidth, in: containerWidth)
        }
        guard storedWidth > 0 else {
            return clamp((containerWidth * 0.44).rounded(), in: containerWidth)
        }
        return clamp(CGFloat(storedWidth), in: containerWidth)
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(canvasIsCovered ? 0 : 1)
            .allowsHitTesting(!canvasIsCovered)
            .disabled(canvasIsCovered)
            .accessibilityHidden(canvasIsCovered)
            .padding(.trailing, reservedWidth)
            .overlay(alignment: .trailing) {
                pane
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                containerWidth = $0
            }
    }

    @ViewBuilder
    private var pane: some View {
        if let target {
            HStack(spacing: 0) {
                if !isCompact {
                    resizeHandle
                }
                CodePreviewDock(
                    target: target,
                    close: close,
                    openInWindow: openInWindow
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .frame(width: isCompact ? nil : paneWidth)
            }
            .background {
                if isCompact {
                    Color.junoCanvasWarm
                }
            }
            .transition(
                .asymmetric(
                    insertion: .offset(x: DesktopChoreography.canvasSlide)
                        .combined(with: .opacity),
                    removal: .opacity
                )
            )
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
            .onDisappear {
                guard showingResizeCursor else { return }
                showingResizeCursor = false
                NSCursor.pop()
            }
            .help("Drag to resize the Preview pane.")
            .accessibilityHidden(true)
    }
}
