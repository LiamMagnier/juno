import AppKit
import AVKit
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// An announcement (`src/components/app/announcement-popup.tsx`): the visual,
/// an optional model name, the title and description, then "Read More" or
/// "Not Now" and the call to action. Closing it by any route dismisses it.
///
/// Signature detail: the visual at 16:9 — a looping muted video, a picture or
/// a provider's mark — so the news is seen before it is read.
struct DesktopAnnouncementSheet: View {
    let announcement: NativeAnnouncement
    let close: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            DesktopAnnouncementVisual(announcement: announcement)
                .frame(width: 512, height: 288)
                .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                if let model = announcement.modelName, !model.isEmpty {
                    Text(model)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                Text(announcement.title)
                    .junoType(.title)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(announcement.description)
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(5)
            }

            Spacer(minLength: 0)

            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                if let news = announcement.newsHref, !news.isEmpty {
                    Button(announcement.newsLabel?.isEmpty == false ? announcement.newsLabel! : "Read More") {
                        follow(news)
                    }
                    .buttonStyle(.junoGlass)
                    .tint(nil)
                    .contentShape(.rect)
                } else {
                    Button("Not Now", action: close)
                        .buttonStyle(.borderless)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
                if announcement.hasCallToAction, let label = announcement.ctaLabel {
                    Button {
                        follow(announcement.ctaHref)
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            Text(label)
                            JunoIconView(.arrowRight, size: 13)
                        }
                    }
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(JunoSpace.section)
        // Always a way out that does not follow a link: the web's
        // DialogCloseButton, the one cancel action in the sheet (Esc).
        .overlay(alignment: .topTrailing) {
            Button(action: close) {
                JunoIconView(.close, size: 14)
                    .foregroundStyle(Color.junoForeground)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Color.junoCard))
                    .overlay(Circle().strokeBorder(Color.junoBorder, lineWidth: 1))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .help("Close")
            .accessibilityLabel("Close")
            .accessibilityIdentifier("juno.desktop.announcement.close")
            .padding(JunoSpace.cozy)
        }
        .frame(width: 560, height: 520)
        .presentationSizing(.page)
    }

    private func follow(_ href: String?) {
        close()
        switch DesktopAnnouncementLink.resolve(href) {
        case .route(let route)?:
            DesktopWorkbenchRegistry.shared.requestRoute(route)
        case .browser(let url)?:
            openURL(url)
        case nil:
            break
        }
    }
}

/// The announcement's picture: its video, its image, a provider's mark, or
/// Juno's own.
struct DesktopAnnouncementVisual: View {
    let announcement: NativeAnnouncement

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Color.junoSecondary
            if let video = resolved(announcement.videoURL) {
                DesktopLoopingVideo(url: video, playsAutomatically: !reduceMotion)
            } else if let image = resolved(announcement.imageURL) {
                AsyncImage(url: image) { phase in
                    switch phase {
                    case .success(let picture):
                        if image.path.contains("/provider-logos/") {
                            picture.resizable().scaledToFit().padding(JunoSpace.expanse)
                        } else {
                            picture.resizable().scaledToFill()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .clipped()
                        }
                    default:
                        Color.junoSecondary
                    }
                }
            } else if let provider = announcement.provider {
                JunoProviderMark(providerID: provider, providerName: provider, size: 64)
            } else {
                JunoIconView(.conversation, size: 44)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .accessibilityHidden(true)
    }

    /// A relative path is the web's own asset.
    private func resolved(_ url: URL?) -> URL? {
        guard let url else { return nil }
        if url.scheme == nil { return URL(string: JunoBackend.productionURLString + url.absoluteString) }
        return url
    }
}

/// A muted video that loops with no controls, or waits paused with controls
/// under Reduce Motion.
struct DesktopLoopingVideo: NSViewRepresentable {
    let url: URL
    let playsAutomatically: Bool

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        let player = AVQueuePlayer()
        player.isMuted = true
        context.coordinator.looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        view.player = player
        view.videoGravity = .resizeAspectFill
        view.controlsStyle = playsAutomatically ? .none : .inline
        if playsAutomatically { player.play() }
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        view.controlsStyle = playsAutomatically ? .none : .inline
        if playsAutomatically { view.player?.play() } else { view.player?.pause() }
    }

    static func dismantleNSView(_ view: AVPlayerView, coordinator: Coordinator) {
        view.player?.pause()
        coordinator.looper = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var looper: AVPlayerLooper?
    }
}
