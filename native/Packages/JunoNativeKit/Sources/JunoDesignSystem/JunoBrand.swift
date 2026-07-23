import SwiftUI

#if canImport(UIKit)
import UIKit
public typealias JunoPlatformImage = UIImage
#elseif canImport(AppKit)
import AppKit
public typealias JunoPlatformImage = NSImage
#endif

extension Image {
    init(junoPlatformImage image: JunoPlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: image)
        #else
        self.init(nsImage: image)
        #endif
    }
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

/// A product destination's glyph.
///
/// These are the website's own icons, not lookalikes: the cases mirror
/// `src/lib/app-icons.ts` one-for-one, and the assets are generated from the
/// installed `lucide-react` by `scripts/generate-native-icons.mjs`, so the two
/// platforms cannot drift. Regenerate rather than editing the SVGs by hand.
///
/// SF Symbols remain correct for *system* affordances — back, close, share,
/// camera, photo picker — where there is no Juno icon and the platform glyph is
/// what a user already recognises.
public enum JunoIcon: String, CaseIterable, Sendable {
    case home, code, library, artifacts, projects
    case tasks, connections, pulls, conversation, new, search

    /// The asset-catalog name, matching the generator's output.
    public var assetName: String { "nav-\(rawValue)" }
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

    public var body: some View {
        Image(icon.assetName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

/// Why an avatar cannot simply be an `AsyncImage`.
///
/// Juno stores an uploaded avatar at `/api/files/<key>`, and that route calls
/// `getCurrentUser()` — it is **authenticated**. A browser satisfies it with the
/// session cookie it already holds. `AsyncImage` sends neither cookie nor bearer
/// token, so it receives a 401 and renders its failure case, which is
/// indistinguishable from an account that has no photo at all.
///
/// The avatar therefore has to be fetched through the same authenticated
/// transport as everything else, which is what the `load` closure carries.
public enum JunoAvatarLoading {}

/// The signed-in account's real photo, with initials only as a genuine fallback.
///
/// The image URL is the same `user.image` the web renders in its user menu,
/// carried on the native profile from `/api/v1/bootstrap`. Initials appear only
/// when the account truly has no photo — never as a placeholder while one loads,
/// which would flash the wrong identity on every launch.
/// Why an avatar cannot simply be an `AsyncImage`.
///
/// Juno stores an uploaded avatar at `/api/files/<key>`, and that route calls
/// `getCurrentUser()` — it is **authenticated**. A browser satisfies it with the
/// session cookie it already holds. `AsyncImage` sends neither cookie nor bearer
/// token, so it receives a 401 and renders its failure case, which is
/// indistinguishable from an account that has no photo at all.
///
/// The avatar therefore has to be fetched through the same authenticated
/// transport as every other request, which is what `load` carries.
public struct JunoAvatar: View {
    private let imageURL: URL?
    private let name: String?
    private let size: CGFloat
    private let load: ((URL) async -> Data?)?

    /// - Parameter load: fetches the image through the app's authenticated
    ///   transport. Passing nil falls back to an unauthenticated fetch, which is
    ///   correct only for a genuinely public URL.
    public init(
        imageURL: URL?,
        name: String?,
        size: CGFloat = 32,
        load: ((URL) async -> Data?)? = nil
    ) {
        self.imageURL = imageURL
        self.name = name
        self.size = size
        self.load = load
    }

    @State private var loaded: JunoPlatformImage?
    @State private var failed = false

    public var body: some View {
        Group {
            if let loaded {
                Image(junoPlatformImage: loaded).resizable().scaledToFill()
            } else if imageURL == nil || failed {
                initials
            } else {
                // Neutral while loading: showing initials here would flash a
                // different identity before the photo lands.
                Color.junoMuted
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: imageURL) { await fetch() }
        .accessibilityLabel(name.map { "Account, \($0)" } ?? "Account")
    }

    private func fetch() async {
        guard let imageURL else { return }
        loaded = nil
        failed = false
        let data: Data?
        if let load {
            data = await load(imageURL)
        } else {
            data = try? await URLSession.shared.data(from: imageURL).0
        }
        guard let data, let image = JunoPlatformImage(data: data) else {
            failed = true
            return
        }
        loaded = image
    }

    private var initials: some View {
        ZStack {
            Color.junoMuted
            Text(JunoAvatar.initials(from: name))
                .font(.system(size: size * 0.4, weight: .semibold))
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
