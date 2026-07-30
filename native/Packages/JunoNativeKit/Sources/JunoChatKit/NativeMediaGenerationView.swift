import JunoDesignSystem
import SwiftUI

/// The media-generation work surface, while `/api/generate` runs.
///
/// AIcss's Image Generation in AIcss's own composition: the canvas, then the
/// label. No frame, no footer, no clock — the same call the website made when it
/// deleted its own progress bar, percentage and mm:ss timer. The clock made a
/// twenty-second wait feel measured and a sixty-second one feel broken; the
/// percentage was fiction on every provider that reports none.
///
/// Shared by both apps deliberately. This is the first thing either of them has
/// ever shown for a generation — the endpoint existed from the start and no
/// native client called it — so there is no reason for two versions of it.
public struct NativeMediaGenerationView: View {
    private let progress: NativeMediaProgress

    public init(progress: NativeMediaProgress) {
        self.progress = progress
    }

    private var isVideo: Bool { progress.modality == .video }

    /// The server's stage word, in the reader's language.
    ///
    /// An unknown stage is title-cased and shown rather than swallowed: the server
    /// is free to add one, and "Refining" appearing verbatim is better than a
    /// placeholder that says nothing.
    private var detail: String {
        switch progress.stage {
        case "queued": "Preparing"
        case "generating": isVideo ? "Creating video" : "Creating image"
        case "polling": isVideo ? "Rendering" : "Refining"
        case "downloading": "Retrieving"
        case "uploading": "Saving"
        default: progress.stage.prefix(1).uppercased() + progress.stage.dropFirst()
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                // The lattice opens up from AIcss's 11pt: their canvas is 208pt
                // and a pitch tuned for that reads as a texture at this size.
                JunoAIcssImageCanvas(pitch: 14)
                if isVideo {
                    Image(systemName: "play.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.primary.opacity(0.42))
                        .padding(16)
                        .background(.ultraThinMaterial, in: Circle())
                }
            }
            .aspectRatio(isVideo ? 16.0 / 9.0 : 1, contentMode: .fit)
            .frame(maxWidth: isVideo ? 440 : 288, alignment: .leading)

            JunoAIcssThinkingLabel(detail, tone: .strong, size: 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(isVideo ? "Video" : "Image") generation in progress — \(detail)")
        .accessibilityAddTraits(.updatesFrequently)
    }
}
