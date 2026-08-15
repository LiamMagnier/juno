import JunoDesignSystem
import SwiftUI

/// One run, as a row. The shape every list of runs in Juno Code draws.
///
/// It takes values rather than a model on purpose. The four transports each
/// have their own record type and none of them belongs in a view; a row that
/// took `CodeSession` could not draw a cloud task, and that is exactly how the
/// product ended up with a separate row builder per transport, each with its
/// own metrics.
///
/// Opaque by construction — the row paints no material of its own. In a source
/// list the platform draws the selection and the hover fill; on a page the
/// caller supplies the ground. Glass belongs to the chrome around this, never
/// to a thing you read.
public struct CodeSessionRow<Accessory: View>: View {
    private let title: String
    private let caption: String
    private let status: CodeRunStatus
    private let accessory: Accessory

    public init(
        title: String,
        caption: String,
        status: CodeRunStatus,
        @ViewBuilder accessory: () -> Accessory
    ) {
        self.title = title
        self.caption = caption
        self.status = status
        self.accessory = accessory()
    }

    public var body: some View {
        HStack(spacing: JunoSpace.tight) {
            CodeStatusGlyph(status)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .junoRowLabel()
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(caption)
                    .junoCaption()
                    .lineLimit(1)
                    // The head, not the tail: what distinguishes two runs in
                    // one repository is the end of the caption — the branch and
                    // how long ago it moved — not the repository name they
                    // share.
                    .truncationMode(.head)
            }

            Spacer(minLength: JunoSpace.hairline)

            accessory
        }
        .frame(minHeight: CodeRowMetrics.stackedHeight)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(caption), \(status.label)")
    }
}

public extension CodeSessionRow where Accessory == EmptyView {
    init(title: String, caption: String, status: CodeRunStatus) {
        self.init(title: title, caption: caption, status: status) { EmptyView() }
    }
}

/// The row's own placeholder, at the row's own geometry.
///
/// This is the difference a skeleton has to earn over a spinner: it occupies
/// `CodeRowMetrics` — the same mark column, the same two lines, the same 44pt —
/// so the list does not jump when the real rows arrive. A `ProgressView` in the
/// same slot claims nothing about what is coming and then contradicts itself.
///
/// It does not shimmer. A shimmer is a loop over something that is not
/// changing, and the arrival of the rows is the event worth animating.
public struct CodeSessionRowSkeleton: View {
    private let titleFraction: CGFloat
    private let captionFraction: CGFloat

    /// - Parameter seed: varies the two bar widths so a column of skeletons
    ///   reads as a list of different rows rather than as a striped pattern.
    public init(seed: Int = 0) {
        let titles: [CGFloat] = [0.72, 0.54, 0.83, 0.61]
        let captions: [CGFloat] = [0.44, 0.58, 0.36, 0.50]
        titleFraction = titles[abs(seed) % titles.count]
        captionFraction = captions[abs(seed) % captions.count]
    }

    public var body: some View {
        HStack(spacing: JunoSpace.tight) {
            Circle()
                .fill(Color.junoMuted)
                .frame(width: 11, height: 11)
                .frame(width: CodeRowMetrics.markColumn)

            GeometryReader { proxy in
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    bar(width: proxy.size.width * titleFraction, height: 9)
                    bar(width: proxy.size.width * captionFraction, height: 7)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }

            Spacer(minLength: JunoSpace.hairline)
        }
        .frame(height: CodeRowMetrics.stackedHeight)
        .accessibilityHidden(true)
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: height / 2, style: .continuous)
            .fill(Color.junoMuted)
            .frame(width: max(24, width), height: height)
    }
}
