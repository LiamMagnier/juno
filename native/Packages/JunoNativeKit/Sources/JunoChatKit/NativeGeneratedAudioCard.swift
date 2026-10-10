import AVFoundation
import JunoDesignSystem
import SwiftUI

/// A track a music model made (Lyria through `/api/generate`), in the answer:
/// a card at most 480pt wide with a play button, the file's name and format,
/// and the track's own waveform — read from the file, not drawn as a
/// decoration — which fills with ink as it plays and takes a tap to seek.
///
/// The card holds its size from the first frame; the waveform rises in once
/// the file is read, so the transcript never jumps when it arrives.
public struct NativeGeneratedAudioCard: View {
    private let attachment: NativeChatAttachment
    private let load: @MainActor () async throws -> URL

    @State private var model = NativeAudioCardModel()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let shape = RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
    #if os(iOS)
    private static let button: CGFloat = 44
    #else
    private static let button: CGFloat = 36
    #endif

    /// `load` hands back a local file for the attachment: the Mac's
    /// transcript media cache, or bytes the phone fetched and wrote down.
    public init(attachment: NativeChatAttachment, load: @escaping @MainActor () async throws -> URL) {
        self.attachment = attachment
        self.load = load
    }

    public var body: some View {
        HStack(spacing: JunoSpace.cozy) {
            Button {
                model.toggle()
            } label: {
                ZStack {
                    Circle().fill(Color.junoForeground)
                    JunoIconView(model.isPlaying ? .pause : .play, size: 16)
                        .foregroundStyle(Color.junoCanvas)
                }
                .frame(width: Self.button, height: Self.button)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(model.phase != .ready)
            .opacity(model.phase == .ready ? 1 : 0.4)
            .accessibilityLabel(model.isPlaying ? "Pause" : "Play")
            .accessibilityIdentifier("juno.audio-card.play")

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.snug) {
                    Text(title)
                        .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: JunoSpace.snug)
                    Text(timeLine)
                        .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .fixedSize()
                }
                waveform
                    .frame(height: 24)
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.cozy)
        .frame(maxWidth: 480, alignment: .leading)
        .background(Color.junoCard, in: Self.shape)
        .overlay { Self.shape.strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Audio, \(title)")
        .accessibilityIdentifier("juno.audio-card")
        .task(id: attachment.id) { await model.prepare(load) }
        .onDisappear { model.pause() }
    }

    private var title: String {
        let name = attachment.fileName
        let stem = (name as NSString).deletingPathExtension
        return stem.isEmpty ? "Track" : stem.replacingOccurrences(of: "-", with: " ").capitalized
    }

    private var timeLine: String {
        switch model.phase {
        case .preparing: return "Preparing · \(attachment.extensionBadge)"
        case .failed: return "Unavailable"
        case .ready:
            let format = attachment.extensionBadge
            return "\(Self.clock(model.elapsed)) / \(Self.clock(model.duration)) · \(format)"
        }
    }

    static func clock(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }

    private var waveform: some View {
        GeometryReader { proxy in
            let peaks = model.peaks
            let count = max(peaks.count, 1)
            let gap: CGFloat = 2
            let bar = max(1.5, (proxy.size.width - gap * CGFloat(count - 1)) / CGFloat(count))
            let played = model.duration > 0 ? model.elapsed / model.duration : 0
            HStack(alignment: .center, spacing: gap) {
                ForEach(Array(peaks.enumerated()), id: \.offset) { index, peak in
                    Capsule()
                        .fill(Double(index) / Double(count) < played
                              ? Color.junoForeground : Color.junoForeground.opacity(0.22))
                        .frame(width: bar, height: max(3, proxy.size.height * peak))
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
            .contentShape(.rect)
            .onTapGesture { location in
                guard proxy.size.width > 0 else { return }
                model.seek(to: Double(location.x / proxy.size.width))
            }
        }
        .opacity(model.peaks.isEmpty ? 0 : 1)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: model.peaks.isEmpty)
        .accessibilityHidden(true)
    }
}

/// The card's player: an `AVPlayer` over the local file, the clock it reports,
/// and the waveform's peaks.
@MainActor
@Observable
final class NativeAudioCardModel {
    enum Phase: Equatable { case preparing, ready, failed }

    var phase = Phase.preparing
    var isPlaying = false
    var elapsed: Double = 0
    var duration: Double = 0
    var peaks: [Double] = []

    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var observer: Any?

    nonisolated static let barCount = 56

    func prepare(_ load: @MainActor () async throws -> URL) async {
        do {
            let url = try await load()
            let item = AVPlayerItem(url: url)
            let player = AVPlayer(playerItem: item)
            self.player = player
            peaks = await Task.detached(priority: .utility) { Self.readPeaks(url, count: Self.barCount) }.value
            let seconds = try await item.asset.load(.duration).seconds
            duration = seconds.isFinite ? seconds : 0
            observer = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main
            ) { [weak self] time in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.elapsed = time.seconds
                    if self.duration > 0, time.seconds >= self.duration - 0.05 {
                        self.isPlaying = false
                    }
                }
            }
            phase = .ready
        } catch is CancellationError {
            return
        } catch {
            phase = .failed
        }
    }

    func toggle() {
        guard let player else { return }
        if isPlaying {
            player.pause()
        } else {
            if duration > 0, elapsed >= duration - 0.05 { player.seek(to: .zero) }
            player.play()
        }
        isPlaying.toggle()
    }

    func pause() {
        player?.pause()
        isPlaying = false
    }

    func seek(to fraction: Double) {
        guard let player, duration > 0 else { return }
        let target = max(0, min(1, fraction)) * duration
        elapsed = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
    }

    /// The loudest sample in each of `count` equal slices of the track, scaled
    /// so the loudest slice fills the height.
    nonisolated static func readPeaks(_ url: URL, count: Int) -> [Double] {
        guard let file = try? AVAudioFile(forReading: url),
            file.length > 0
        else { return [] }
        let frames = AVAudioFrameCount(file.length)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames),
            (try? file.read(into: buffer)) != nil,
            let channel = buffer.floatChannelData?[0]
        else { return [] }
        let total = Int(buffer.frameLength)
        let slice = max(1, total / count)
        var out: [Double] = []
        out.reserveCapacity(count)
        for index in 0..<count {
            let start = index * slice
            guard start < total else { break }
            let end = min(total, start + slice)
            var peak: Float = 0
            var i = start
            // Every 8th sample is plenty for a 56-bar outline.
            while i < end {
                peak = max(peak, abs(channel[i]))
                i += 8
            }
            out.append(Double(peak))
        }
        let loudest = out.max() ?? 0
        guard loudest > 0 else { return out.map { _ in 0.1 } }
        return out.map { max(0.08, $0 / loudest) }
    }
}
