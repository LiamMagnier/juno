import JunoChatKit
import SwiftUI

/// The pending attachments, shown above the composer.
///
/// Each chip carries its own state rather than the row carrying one shared
/// status, because the states genuinely differ per file: one photo can be
/// uploading while another has been refused for its type, and a single "3 files
/// uploading" line would hide that entirely.
struct JunoMobileAttachmentChips: View {
    let attachments: [NativeComposerAttachment]
    let onRemove: (UUID) -> Void
    let onRetry: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    chip(attachment)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("juno.mobile.composer-attachments")
    }

    private func chip(_ attachment: NativeComposerAttachment) -> some View {
        HStack(spacing: 8) {
            thumbnail(attachment)
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.fileName)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                statusLine(attachment)
            }
            .frame(maxWidth: 150, alignment: .leading)

            if case .failed(_, let retryable) = attachment.state, retryable {
                Button {
                    onRetry(attachment.id)
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("attachments.retry"))
            }

            Button {
                onRemove(attachment.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("attachments.remove"))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        // One VoiceOver stop per attachment, reading name and state together,
        // rather than four separate stops per chip.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(attachment))
    }

    @ViewBuilder
    private func thumbnail(_ attachment: NativeComposerAttachment) -> some View {
        if let data = attachment.previewData, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 30, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            Image(systemName: "doc")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
        }
    }

    @ViewBuilder
    private func statusLine(_ attachment: NativeComposerAttachment) -> some View {
        switch attachment.state {
        case .preparing, .uploading:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("attachments.uploading").font(.caption2).foregroundStyle(.secondary)
            }
        case .uploaded:
            Text("attachments.ready").font(.caption2).foregroundStyle(.secondary)
        case .failed(let message, _):
            Text(message)
                .font(.caption2)
                .foregroundStyle(.red)
                .lineLimit(2)
        }
    }

    private func accessibilityLabel(_ attachment: NativeComposerAttachment) -> Text {
        switch attachment.state {
        case .preparing, .uploading:
            Text("\(attachment.fileName), \(String(localized: "attachments.uploading"))")
        case .uploaded:
            Text("\(attachment.fileName), \(String(localized: "attachments.ready"))")
        case .failed(let message, _):
            Text("\(attachment.fileName), \(message)")
        }
    }
}
