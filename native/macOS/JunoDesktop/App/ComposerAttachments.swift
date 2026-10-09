import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The composer's attachments, as the web draws them (§5.6,
/// `composer-shell.tsx`): a picture is a 64pt thumbnail, anything else a 224×64
/// card with its name and size, and everything wraps rather than scrolling
/// sideways.
///
/// It replaced a horizontal strip of filename pills. A pill asks the reader to
/// recognise a screenshot by the name the system gave it, and a strip that
/// scrolls sideways hides the tenth file behind the ninth — both of which the
/// web stopped doing long ago.
///
/// **Opaque.** These sit inside the glass shell, but they are content: the
/// card fill and a hairline, never a second material on the first.
struct ComposerAttachmentTiles: View {
    let attachments: [NativeComposerAttachment]
    let remove: (UUID) -> Void
    let retry: (UUID) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var previews = NativeFilePreviewLoader()

    var body: some View {
        JunoChipFlow(spacing: JunoSpace.snug, lineSpacing: JunoSpace.snug) {
            ForEach(attachments) { attachment in
                ComposerAttachmentTile(
                    attachment: attachment,
                    thumbnail: previews.state(for: attachment.id.uuidString),
                    remove: { remove(attachment.id) },
                    retry: { retry(attachment.id) }
                )
                .task(id: attachment.previewData?.count) {
                    guard attachment.isImage, let data = attachment.previewData else { return }
                    await previews.load(
                        NativeFilePreviewRequest(
                            id: attachment.id.uuidString,
                            fileName: attachment.fileName,
                            isImage: true,
                            byteSize: attachment.byteCount
                        ),
                        using: { .downloaded(data) }
                    )
                }
                .transition(
                    .scale(scale: JunoMotion.scaleFrom(0.9, reduceMotion: reduceMotion))
                        .combined(with: .opacity)
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(
            JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
            value: attachments.map(\.id)
        )
    }
}

/// One attachment: a thumbnail for a picture, a card for anything else.
private struct ComposerAttachmentTile: View {
    let attachment: NativeComposerAttachment
    let thumbnail: NativeFilePreviewLoader.State
    let remove: () -> Void
    let retry: () -> Void

    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A picture is drawn as itself only while its bytes are here to draw.
    /// A Library clone of an image has none — it was never on this Mac — so it
    /// takes the card, which can at least say what it is.
    private var isPicture: Bool {
        attachment.isImage && attachment.previewData != nil
    }

    private var failure: (message: String, retryable: Bool)? {
        guard case .failed(let message, let retryable) = attachment.state else { return nil }
        return (message, retryable)
    }

    /// The shell's radius less the 12pt inset, floored at the control rung —
    /// `.rect(corners: .concentric(minimum: 10))`.
    private var shape: ConcentricRectangle { JunoRadius.concentric() }

    var body: some View {
        Group {
            if isPicture {
                picture
            } else {
                card
            }
        }
        // A card's hairline, or the destructive one when an upload failed. A
        // thumbnail already draws its own hairline, so it gets a line here only
        // when there is bad news to carry. `stroke` rather than `strokeBorder`:
        // a concentric shape is not insettable, and the half-point outside the
        // tile lands on glass, not on a neighbour.
        .overlay {
            if !isPicture || failure != nil {
                shape.stroke(
                    failure == nil ? Color.junoBorder : Color.junoDestructive,
                    lineWidth: 1
                )
            }
        }
        .overlay(alignment: .topTrailing) {
            removeButton
                .opacity(hovered ? 1 : 0)
                .offset(x: 9, y: -9)
        }
        .onHover { hovered = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
        .help(failure?.message ?? attachment.fileName)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: Picture

    private var picture: some View {
        NativeFilePreviewTile(
            file: NativeFilePreviewRequest(
                id: attachment.id.uuidString,
                fileName: attachment.fileName,
                isImage: true,
                byteSize: attachment.byteCount
            ),
            state: thumbnail,
            cornerRadius: JunoRadius.control
        )
        .frame(width: ComposerAttachmentMetrics.pictureSide, height: ComposerAttachmentMetrics.pictureSide)
        .overlay {
            if !attachment.isTerminal {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Uploading")
            } else if let failure, failure.retryable {
                retryButton
            }
        }
    }

    // MARK: Card

    private var card: some View {
        HStack(spacing: 0) {
            JunoIconView(attachment.isImage ? .image : .file, size: 20)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: ComposerAttachmentMetrics.cardHeight, height: ComposerAttachmentMetrics.cardHeight)
                .background(Color.junoSecondary)

            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text(attachment.fileName)
                    .junoType(.label)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(2)
                    .truncationMode(.middle)
                HStack(spacing: JunoSpace.tight) {
                    Text(metadata)
                        .junoType(.micro)
                        .foregroundStyle(failure == nil ? Color.junoSecondaryInk : Color.junoDestructiveInk)
                        .lineLimit(1)
                    if let failure, failure.retryable {
                        retryButton
                    }
                }
            }
            .padding(.horizontal, JunoSpace.close)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: ComposerAttachmentMetrics.cardWidth, height: ComposerAttachmentMetrics.cardHeight)
        .background(Color.junoCard)
        .clipShape(shape)
    }

    /// "PDF · 2.4 MB", or what is happening to the file instead.
    ///
    /// The upload reports no byte progress — the attachment model knows only
    /// that it is in flight — so this says "Uploading…" rather than inventing
    /// a percentage.
    private var metadata: String {
        switch attachment.state {
        case .preparing, .uploading:
            return "Uploading…"
        case .failed:
            return "Couldn't upload"
        case .uploaded:
            let size = ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file)
            let kind = URL(fileURLWithPath: attachment.fileName).pathExtension.uppercased()
            return kind.isEmpty ? size : "\(kind) · \(size)"
        }
    }

    // MARK: Controls

    /// Link-style text in the accent's ink rung (§0.4), stated rather than
    /// left to a borderless style, whose title takes the fill accent — below
    /// 4.5:1 on the dark canvas at this size.
    private var retryButton: some View {
        Button(action: retry) {
            Text("Retry")
                .junoType(JunoType.label.weight(.medium))
                .foregroundStyle(Color.junoAccentInk)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Retry \(attachment.fileName)")
    }

    /// The 18pt circle the web floats over a tile's corner, with a 28pt target
    /// around it so the pointer does not have to find the circle itself.
    private var removeButton: some View {
        Button(action: remove) {
            ZStack {
                Circle()
                    .fill(Color.junoForeground.opacity(0.8))
                    .frame(width: 18, height: 18)
                JunoIconView(.close, size: 8, weight: .bold)
                    .foregroundStyle(Color.junoCanvas)
            }
            .frame(width: 28, height: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Remove")
        // Hidden from sight until hover, never from VoiceOver: the label is
        // what a screen reader finds whether or not a pointer is near.
        .accessibilityLabel("Remove \(attachment.fileName)")
    }

    private var accessibilityLabel: String {
        switch attachment.state {
        case .preparing, .uploading: "\(attachment.fileName), uploading"
        case .uploaded: attachment.fileName
        case .failed(let message, _): "\(attachment.fileName), couldn't upload. \(message)"
        }
    }
}

enum ComposerAttachmentMetrics {
    /// A picture's thumbnail: the web's 64px tile.
    static let pictureSide: CGFloat = 64
    /// A file card: the web's 224×64.
    static let cardWidth: CGFloat = 224
    static let cardHeight: CGFloat = 64
}
