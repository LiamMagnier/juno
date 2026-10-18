import JunoDesignSystem
import SwiftUI

/// The words an image card says, in the app's language. The strings live in
/// each app's shell table, not in this package, so the app fills them in.
public struct NativeImageGenerationCopy: Equatable, Sendable {
    /// "Auto picked Nano Banana 2.1" / "Made with GPT Image 2.5 Flare".
    public var caption: String?
    /// "Saved to your Library".
    public var saved: String
    /// "Couldn’t create the image".
    public var failedTitle: String
    /// The cause, one sentence; empty draws the title alone.
    public var failureSentence: String

    public init(caption: String?, saved: String, failedTitle: String, failureSentence: String) {
        self.caption = caption
        self.saved = saved
        self.failedTitle = failedTitle
        self.failureSentence = failureSentence
    }
}

/// One picture the model made mid-answer (G04), where the answer's media sit.
///
/// Generating, it is the transcript's existing generation surface
/// (``NativeMediaGenerationView``), so the wait moves exactly as a picture
/// from the composer does. Done, it is a caption under the pictures: the files
/// are the answer's own attachments and are drawn there, so the card draws a
/// picture only while the live stream has it and the answer does not yet.
/// Failed, it is a quiet card naming the cause — never an error banner: the
/// rest of the answer stands.
///
/// Generic over the picture view so each app keeps its own tiles (the Mac's
/// editable attachment grid, the phone's zooming viewer).
public struct NativeImageGenerationCard<Images: View>: View {
    private let generation: NativeImageGeneration
    private let liveImages: [NativeChatAttachment]
    private let copy: NativeImageGenerationCopy
    private let images: ([NativeChatAttachment]) -> Images

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        generation: NativeImageGeneration,
        answerAttachmentIDs: Set<String>,
        copy: NativeImageGenerationCopy,
        @ViewBuilder images: @escaping ([NativeChatAttachment]) -> Images
    ) {
        self.generation = generation
        self.liveImages = generation.liveImages(answerAttachmentIDs: answerAttachmentIDs)
        self.copy = copy
        self.images = images
    }

    public var body: some View {
        Group {
            switch generation.status {
            case .generating:
                NativeMediaGenerationView(progress: generation.mediaProgress)
            case .done:
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    if !liveImages.isEmpty {
                        images(liveImages)
                    }
                    caption
                }
            case .failed:
                failureCard
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
        // The state changes in place (same row, re-sent): a cross-fade, which
        // Reduce Motion keeps because nothing travels.
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: generation.status)
    }

    /// "Auto picked Nano Banana 2.1 · Saved to your Library", in the quiet ink
    /// of a caption: who made it and where it went.
    private var caption: some View {
        let line = [copy.caption, copy.saved].compactMap { $0 }.joined(separator: " · ")
        return HStack(spacing: JunoSpace.tight) {
            JunoIconView(.image, size: 12)
                .accessibilityHidden(true)
            Text(line)
                .junoType(.caption)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityElement(children: .combine)
    }

    private var cardShape: RoundedRectangle { RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous) }

    private var failureCard: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.imageOff, size: 14)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(copy.failedTitle)
                    .junoType(JunoType.label.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                if !copy.failureSentence.isEmpty {
                    Text(copy.failureSentence)
                        .junoType(.label)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: 440, alignment: .leading)
        .background(cardShape.fill(Color.junoCard))
        .overlay(cardShape.strokeBorder(Color.junoBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}
