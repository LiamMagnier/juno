import JunoDesignSystem
import SwiftUI

// The three states every list surface in Juno Code has to be able to draw, and
// the one place they are drawn.
//
// The rule they enforce: *loading*, *empty* and *broken* must be
// distinguishable. Before this they were not — every one of them was a bare
// `ProgressView()` or a single grey sentence, so "still fetching", "you have
// none of these" and "this failed and here is why" looked identical, and the
// only one of the three that a reader can act on was the one that never said so.

/// A list surface's placeholder while its rows are on the way.
///
/// The skeleton claims the real geometry — same mark column, same two lines,
/// same 44pt — so nothing moves when the rows land. `count` should be roughly
/// what the surface usually holds: a skeleton three times taller than the
/// content it announces is its own kind of lie.
public struct CodeLoadingList: View {
    private let count: Int
    private let label: String

    public init(count: Int = 5, label: String) {
        self.count = count
        self.label = label
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                CodeSessionRowSkeleton(seed: index)
                    // The list fades out down the column rather than ending on
                    // a hard edge, because the number of rows coming is not
                    // known and a skeleton that stops abruptly reads as a count.
                    .opacity(1 - (Double(index) / Double(max(count, 1))) * 0.7)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        // The one honest live signal: VoiceOver is told this updates, and
        // sighted readers get the arrival of the rows themselves.
        .accessibilityAddTraits(.updatesFrequently)
    }
}

// **There is no `CodeEmptyState` here, deliberately.** The design system
// already ships `JunoEmptyState`, it already takes a recovery action, and the
// whole diagnosis behind this rework is that the product keeps growing a second
// component beside a working one. The empty half of the triple is that type;
// what was genuinely missing was the loading half above and the broken half
// below, and only those are added.

/// A surface that failed, with the reason and a way to try again.
///
/// The reason is not optional and is never "Something went wrong." A reader who
/// is told only that something went wrong has been given a feeling instead of a
/// fact, and cannot tell a lapsed folder grant from a dropped network.
public struct CodeErrorState: View {
    private let title: String
    private let reason: String
    private let retryTitle: String
    private let retry: (() -> Void)?

    public init(
        title: String,
        reason: String,
        retryTitle: String = "Try Again",
        retry: (() -> Void)? = nil
    ) {
        self.title = title
        self.reason = reason
        self.retryTitle = retryTitle
        self.retry = retry
    }

    public var body: some View {
        VStack(spacing: JunoSpace.cozy) {
            JunoIconView(.error, size: 26)
                .foregroundStyle(Color.junoCaution)
            VStack(spacing: JunoSpace.tight) {
                Text(title).junoEmptyTitle()
                Text(reason)
                    .junoCaption()
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let retry {
                Button(retryTitle, action: retry)
                    .controlSize(.regular)
            }
        }
        .frame(maxWidth: 380)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(JunoSpace.region)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title). \(reason)")
    }
}
