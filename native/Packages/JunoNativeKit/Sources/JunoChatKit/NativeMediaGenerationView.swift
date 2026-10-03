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
/// **The one number kept is a sentence.** Past twenty seconds for a picture, or
/// fifteen for a clip, a second line says the wait is normal — the web's
/// `GenerationPlaceholder`, word for word. It appears only once the wait is
/// long enough to doubt, so it reads as reassurance rather than as a warning
/// printed in advance.
///
/// Shared by both apps deliberately. This is the first thing either of them has
/// ever shown for a generation — the endpoint existed from the start and no
/// native client called it — so there is no reason for two versions of it.
public struct NativeMediaGenerationView: View {
    private let progress: NativeMediaProgress

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The wait has run past the point a reader starts to doubt it.
    @State private var longWait = false

    public init(progress: NativeMediaProgress) {
        self.progress = progress
    }

    private var isVideo: Bool { progress.modality == .video }
    private var isAudio: Bool { progress.modality == .audio }

    /// The work, named for a screen reader: the stage word alone means nothing spoken.
    private var workName: String {
        switch progress.modality {
        case .image: "Image"
        case .video: "Video"
        case .audio: "Music"
        }
    }

    /// The server's stage word, in the reader's language.
    ///
    /// An unknown stage is title-cased and shown rather than swallowed: the server
    /// is free to add one, and "Refining" appearing verbatim is better than a
    /// placeholder that says nothing.
    private var detail: String {
        switch progress.stage {
        case "queued": "Preparing"
        case "generating": isAudio ? "Composing" : isVideo ? "Creating video" : "Creating image"
        case "polling": isVideo ? "Rendering" : "Refining"
        case "downloading": "Retrieving"
        case "uploading": "Saving"
        default: progress.stage.prefix(1).uppercased() + progress.stage.dropFirst()
        }
    }

    /// The web's reassurance, verbatim (`generation-placeholder.tsx`).
    private var longWaitLine: String {
        isAudio
            ? "A full song can take a minute or two."
            : isVideo
            ? "Longer clips can take a couple of minutes."
            : "Still working. Detailed images can take a minute."
    }

    /// Doubt arrives sooner for a picture than for a clip: a video is expected
    /// to take a while.
    private var longWaitDelay: Duration { isVideo ? .seconds(15) : .seconds(20) }

    /// `rounded-field`: the canvas is clipped to the field radius, so the
    /// lattice ends in a corner rather than a hard edge.
    private static let canvasShape = RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                // The lattice opens up from AIcss's 11pt: their canvas is 208pt
                // and a pitch tuned for that reads as a texture at this size.
                JunoAIcssImageCanvas(pitch: 14)
                if isVideo {
                    playPlate
                }
            }
            // A track has no picture: its canvas is a strip the height of the
            // web's player card rather than a square.
            .aspectRatio(isAudio ? 480.0 / 104.0 : isVideo ? 16.0 / 9.0 : 1, contentMode: .fit)
            .frame(maxWidth: isAudio ? 480 : isVideo ? 440 : 288, alignment: .leading)
            .clipShape(Self.canvasShape)

            VStack(alignment: .leading, spacing: 2) {
                // `text-body` (15pt), the sibling sentence's rung: the label
                // sat on an arbitrary 14 that is on no rung.
                JunoAIcssThinkingLabel(detail, tone: .strong, size: 15)
                if longWait {
                    Text(longWaitLine)
                        .junoType(.body)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.opacity)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.updatesFrequently)
        // Keyed on the modality, so a picture's clock does not carry over to
        // a clip — and restarted by a new placeholder, not by a stage change.
        .task(id: progress.modality) {
            longWait = false
            try? await Task.sleep(for: longWaitDelay)
            guard !Task.isCancelled else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint)) {
                longWait = true
            }
            AccessibilityNotification.Announcement(longWaitLine).post()
        }
        // A live region announces what changed, so each stage is said once —
        // with the work named, because "Refining" alone means nothing spoken.
        .onChange(of: detail) { _, stage in
            AccessibilityNotification.Announcement("\(workName) generation: \(stage)").post()
        }
    }

    private var accessibilityLabel: String {
        let base = "\(workName) generation in progress — \(detail)"
        return longWait ? "\(base). \(longWaitLine)" : base
    }

    /// The set's play mark on a 48pt plate in the card fill with a hairline
    /// rim: it says "this will be a video", not "playing", so it is the
    /// regular cut, in foreground ink at 55% (`.generation-media__play-icon`).
    private var playPlate: some View {
        JunoIconView(.play, size: 14)
            .foregroundStyle(Color.junoForeground.opacity(0.55))
            .frame(width: 48, height: 48)
            .background(Circle().fill(Color.junoCard))
            .overlay(Circle().strokeBorder(Color.junoBorder, lineWidth: 1))
    }
}
