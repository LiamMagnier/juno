import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Decodes image bytes into a SwiftUI `Image` on either platform.
///
/// `Image(data:)` does not exist; every route into SwiftUI from raw bytes goes
/// through the platform image type, and the two spell it differently.
func JunoPlatformImage(data: Data) -> Image? {
    #if canImport(UIKit)
    guard let image = UIImage(data: data) else { return nil }
    return Image(uiImage: image)
    #elseif canImport(AppKit)
    guard let image = NSImage(data: data) else { return nil }
    return Image(nsImage: image)
    #else
    return nil
    #endif
}

/// Juno's mark: the chat-bubble glyph the website renders at every entry point.
///
/// The asset is the very same `public/juno-mark.png` the web serves, imported
/// with a *template* rendering intent. That is the native equivalent of the
/// web's `dark:invert`: a template image contributes only its alpha, so the mark
/// takes the current foreground colour and is correct in light and dark from one
/// asset, with no second file to keep in sync.
///
/// It is intentionally not tinted coral by default. On the website the mark is
/// ink-coloured and the coral is reserved for emphasis; tinting the mark would
/// spend the accent on chrome that is always on screen.
public struct JunoMark: View {
    private let size: CGFloat

    public init(size: CGFloat = 22) {
        self.size = size
    }

    public var body: some View {
        Image("JunoMark")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The Juno lockup: mark plus wordmark, as it appears in the sidebar header.
public struct JunoLogo: View {
    private let showsWordmark: Bool

    public init(showsWordmark: Bool = true) {
        self.showsWordmark = showsWordmark
    }

    public var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoMark(size: 24)
            if showsWordmark {
                Text("Juno")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Juno")
    }
}

/// A Juno glyph: a product destination, or one of the things Juno Code talks
/// about.
///
/// These are the website's own icons, not lookalikes: the cases mirror
/// `src/lib/app-icons.ts` one-for-one — the first group is its `AppIcons`, the
/// second its `CodeIcons` — and the assets are generated from the installed
/// `lucide-react` by `scripts/generate-native-icons.mjs`, so the two platforms
/// cannot drift. Regenerate rather than editing the SVGs by hand.
///
/// SF Symbols remain correct for *system* affordances — back, close, share,
/// camera, photo picker, chevrons, checkmarks — where there is no Juno icon and
/// the platform glyph is what a user already recognises. The line is whether
/// the mark names something in the product or something in the OS: a pull
/// request is Juno's, a disclosure chevron is Apple's.
public enum JunoIcon: String, CaseIterable, Sendable {
    case home, work, code, library, artifacts, projects
    case tasks, connections, pulls, conversation, new, search

    /// The web reaches Settings from the user menu rather than the rail, so this
    /// mark had no destination row to be generated for and the native sidebars —
    /// which do have one — fell back to `gearshape`. One SF Symbol sitting in a
    /// column of Lucide marks reads as a glyph borrowed from another product,
    /// which is exactly the drift this enum exists to prevent.
    case settings

    /// Juno Code's vocabulary. `pin` is a pin and never a star, `error` is a
    /// circle and never a triangle, and `branch` covers repository, default
    /// branch and base ref alike — each because that is what the web draws.
    case cloud, device, branch, lock, permission
    case pin, error, refresh, external, file

    /// What the composer's "+" menu adds to a message, and the tools it arms.
    case attach, photos, files, canvas
    case research, web, artifactsTool, memory

    /// Settings, profile, and feature sections.
    case usage, appearance, writing, language, models, notifications, about
    case user, tools, knowledge, sliders

    /// Action controls, media, and navigation glyphs.
    case mic, send, stop, plus, chevronRight, chevronDown, chevronUp
    case trash, pencil, copy, check, close, ellipsis, share, terminal
    case arrowDown, volume, thumbsUp, thumbsDown, eyeOff

    /// The asset-catalog name, matching the generator's output.
    public var assetName: String { "nav-\(rawValue)" }

    /// Maps a legacy SF Symbol name to the closest website/Lucide mark.
    ///
    /// A few package boundaries still receive a string from older models. The
    /// mapping keeps those boundaries source-compatible while ensuring the
    /// rendered control uses the same generated asset as the web and the rest
    /// of native Juno.
    public static func from(systemImage: String) -> JunoIcon {
        let value = systemImage.lowercased()
        if value.contains("chevron") || value.contains("arrow.right") { return .chevronRight }
        if value.contains("arrow.up.right") || value.contains("external") || value.contains("link") {
            return .external
        }
        if value.contains("arrow.down") { return .arrowDown }
        if value.contains("arrow.up") { return .send }
        if value.contains("arrow") {
            return .external
        }
        if value.contains("xmark") || value.contains("trash") || value.contains("minus") {
            return value.contains("trash") ? .trash : .close
        }
        if value.contains("check") { return .check }
        if value.contains("exclamation") || value.contains("warning") || value.contains("error") {
            return .error
        }
        if value.contains("lock") || value.contains("shield") || value.contains("hand.raised") {
            return .permission
        }
        if value.contains("pause") || value.contains("stop") { return .stop }
        if value.contains("play") || value.contains("bolt") || value.contains("power") {
            return .work
        }
        if value.contains("clock") || value.contains("refresh") || value.contains("rotate") {
            return .refresh
        }
        if value.contains("magnifyingglass") || value.contains("search") { return .search }
        if value.contains("doc") || value.contains("file") || value.contains("folder") {
            return value.contains("folder") ? .projects : .file
        }
        if value.contains("photo") || value.contains("camera") || value.contains("image") {
            return .photos
        }
        if value.contains("person") || value.contains("user") { return .user }
        if value.contains("paperclip") { return .attach }
        if value.contains("ellipsis") || value.contains("more") { return .ellipsis }
        if value.contains("plus") { return .plus }
        if value.contains("copy") { return .copy }
        if value.contains("pencil") || value.contains("edit") { return .pencil }
        if value.contains("terminal") || value.contains("cpu") { return .terminal }
        if value.contains("globe") || value.contains("safari") { return .web }
        if value.contains("eye") { return .eyeOff }
        if value.contains("branch") || value.contains("git") { return .branch }
        if value.contains("sparkle") || value.contains("brain") { return .models }
        if value.contains("grid") || value.contains("rectangle") { return .artifactsTool }
        if value.contains("bubble") || value.contains("message") { return .conversation }
        return .tools
    }
}

/// Renders a ``JunoIcon`` at a weight that sits correctly beside SF Symbols.
///
/// Lucide draws on a 24pt grid with a 2pt stroke. At a 20pt render that stroke
/// reads slightly heavier than an equivalent SF Symbol, so the default size is
/// nudged down rather than scaling the artwork up — matching stroke weight
/// matters more than matching bounding box when the two sit in one list.
public struct JunoIconView: View {
    private let icon: JunoIcon
    private let size: CGFloat

    public init(_ icon: JunoIcon, size: CGFloat = 19) {
        self.icon = icon
        self.size = size
    }

    /// Compatibility initializer for older symbol-backed call sites. It is
    /// intentionally rendered through the website icon mapping above.
    public init(systemImage: String, size: CGFloat = 19) {
        self.icon = .from(systemImage: systemImage)
        self.size = size
    }

    public var body: some View {
        Image(icon.assetName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

/// A menu row, button or list row labelled with a Juno icon.
///
/// `Label(_:systemImage:)` cannot take one of these — the assets are images,
/// not symbols — and `Label(_:image:)` renders them at the image's own size,
/// which is a 24pt box beside 13pt menu text. This pairs the text with a
/// ``JunoIconView`` sized for the row instead, so a Juno mark can appear
/// anywhere an SF Symbol label already does.
public struct JunoIconLabel: View {
    private let title: Text
    private let icon: JunoIcon
    private let size: CGFloat

    public init(_ title: LocalizedStringKey, icon: JunoIcon, size: CGFloat = 15) {
        self.title = Text(title)
        self.icon = icon
        self.size = size
    }

    public init(verbatim title: String, icon: JunoIcon, size: CGFloat = 15) {
        self.title = Text(title)
        self.icon = icon
        self.size = size
    }

    public var body: some View {
        Label {
            title
        } icon: {
            JunoIconView(icon, size: size)
        }
    }
}

/// The signed-in account's real photo, with initials only as a genuine fallback.
///
/// The image URL is the same `user.image` the web renders in its user menu,
/// carried on the native profile from `/api/v1/bootstrap`. Initials appear only
/// when the account truly has no photo — never as a placeholder while one loads,
/// which would flash the wrong identity on every launch.
public struct JunoAvatar: View {
    private let imageData: Data?
    private let imageURL: URL?
    private let name: String?
    private let size: CGFloat

    /// - Parameter imageData: bytes already fetched by the caller. Juno's own
    ///   avatars live behind an authenticated route that `AsyncImage` cannot
    ///   reach, so they arrive this way (see `NativeAvatarModel`); a photo
    ///   inherited from an OAuth provider is a plain URL and uses `imageURL`.
    public init(
        imageData: Data? = nil,
        imageURL: URL?,
        name: String?,
        size: CGFloat = 32
    ) {
        self.imageData = imageData
        self.imageURL = imageURL
        self.name = name
        self.size = size
    }

    public var body: some View {
        Group {
            if let imageData, let image = JunoPlatformImage(data: imageData) {
                image.resizable().scaledToFill()
            } else if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        initials
                    case .empty:
                        // Neutral while loading: showing initials here would
                        // flash a different identity before the photo lands.
                        Color.junoMuted
                    @unknown default:
                        initials
                    }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel(name.map { "Account, \($0)" } ?? "Account")
    }

    private var initials: some View {
        ZStack {
            Color.junoMuted
            Text(JunoAvatar.initials(from: name))
                .junoFont(size: size * 0.4, relativeTo: .body, weight: .semibold)
                .foregroundStyle(Color.junoMutedForeground)
        }
    }

    /// First letters of the first and last word, matching the web's fallback.
    /// Uses `Character`-level slicing so multi-scalar names are not cut apart.
    public static func initials(from name: String?) -> String {
        let words = (name ?? "")
            .split(whereSeparator: { $0 == " " || $0 == "\u{00A0}" })
            .filter { !$0.isEmpty }
        switch words.count {
        case 0: return "?"
        case 1: return String(words[0].prefix(1)).uppercased()
        default:
            let first = String(words[0].prefix(1))
            let last = String(words[words.count - 1].prefix(1))
            return (first + last).uppercased()
        }
    }
}
