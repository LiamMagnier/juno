import SwiftUI

/// The SwiftUI side of reading-first follow (``JunoPinnedTurn``), shared by the
/// Mac and iOS transcripts.
///
/// A transcript names its content stack with ``JunoPinnedTurn/contentSpace``,
/// measures the stack's height, has the pinned question report its frame in
/// that space with ``SwiftUI/View/junoPinnedTurnFrame(isPinned:report:)``, and
/// adds ``JunoPinnedTurn/bedHeight`` to the stack's bottom padding.
extension JunoPinnedTurn {
    /// The coordinate space of a transcript's content stack.
    public static let contentSpace = "juno.transcript.content"
}

extension View {
    /// Reports this row's frame in ``JunoPinnedTurn/contentSpace`` while it is
    /// the pinned question. Inert on every other row.
    public func junoPinnedTurnFrame(isPinned: Bool, report: @escaping (CGRect) -> Void) -> some View {
        modifier(JunoPinnedTurnFrameReporter(isPinned: isPinned, report: report))
    }
}

private struct JunoPinnedTurnFrameReporter: ViewModifier {
    let isPinned: Bool
    let report: (CGRect) -> Void

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGRect?.self) { proxy in
            isPinned ? proxy.frame(in: .named(JunoPinnedTurn.contentSpace)) : nil
        } action: { frame in
            if let frame { report(frame) }
        }
    }
}

/// What a transcript needs from its scroll geometry, coarse enough that it
/// changes only at the edges that matter (an `onScrollGeometryChange` that
/// produced the raw offset would re-render the transcript on every frame of a
/// scroll).
public struct JunoTranscriptScrollState: Equatable, Sendable {
    /// The reader is at the end of the scroll range. With an answer bed, the
    /// end is the pinned question.
    public var atEnd: Bool
    /// Transcript content (not the bed) lies below the visible area: what
    /// Jump to Latest is for.
    public var contentBelow: Bool
    /// The height content can be read in: the scroll view less its insets
    /// (the bars and content margin above, the composer and keyboard below).
    public var viewportHeight: CGFloat

    public init(atEnd: Bool, contentBelow: Bool, viewportHeight: CGFloat) {
        self.atEnd = atEnd
        self.contentBelow = contentBelow
        self.viewportHeight = viewportHeight
    }

    public init(
        contentOffsetY: CGFloat,
        containerHeight: CGFloat,
        insetTop: CGFloat = 0,
        insetBottom: CGFloat,
        contentHeight: CGFloat,
        bedHeight: CGFloat,
        slop: CGFloat
    ) {
        let visibleBottom = contentOffsetY + containerHeight - insetBottom
        let gap = contentHeight - visibleBottom
        self.init(
            atEnd: gap <= slop,
            contentBelow: gap - bedHeight > slop,
            viewportHeight: (containerHeight - insetTop - insetBottom).rounded()
        )
    }

    public init(_ geometry: ScrollGeometry, bedHeight: CGFloat, slop: CGFloat) {
        self.init(
            contentOffsetY: geometry.contentOffset.y,
            containerHeight: geometry.containerSize.height,
            insetTop: geometry.contentInsets.top,
            insetBottom: geometry.contentInsets.bottom,
            contentHeight: geometry.contentSize.height,
            bedHeight: bedHeight,
            slop: slop
        )
    }
}
