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
    case mic, send, stop, plus, chevronLeft, chevronRight, chevronDown, chevronUp
    case trash, pencil, copy, check, close, ellipsis, share, terminal
    case arrowDown, volume, thumbsUp, thumbsDown, eyeOff

    /// Added for the macOS rework: Codex-class Code shell, message actions,
    /// native lists. Each case has a key in `scripts/generate-native-icons.mjs`.
    case folderOpen, folderPlus, clock, history, shield, compass, blocks
    case play, pause, gitCommit, fork, fileDiff, list, grid, image
    case circleDot, loader, agents, archive, download, filter, eye, message
    case bell, arrowUp, arrowLeft, arrowRight, minus, box, key, link
    case sun, moon, monitor, home2

    /// Status and state marks — the web's `StatusIcons` and the handful of
    /// Lucide glyphs its lists draw beside a row's state. Added so the last SF
    /// Symbol names still crossing a package boundary resolve to a real mark
    /// instead of the wrench that ``init(systemImage:)``'s predecessor handed
    /// out for anything it did not recognise.
    case triangleAlert, circleCheck, circleX, circleMinus, circleHelp, circleDashed
    case circleSlash, circle, circlePause, circlePlay, circleStop, badgeCheck
    case chevronsUpDown, compose, fileSearch, filePlus, fileCode, fileQuestion
    case clockCheck, clockAlert, calendarCheck, hourglass
    case octagonX, wifiOff, sparkles, panelRight, panelLeft, columns, appWindow
    case diff, phoneOff, userCircle, penTool, micOff, lockOpen, monitorOff
    case crop, crosshair, binoculars, maximize, undo, rotateCcw, quote, brain
    case chartLine, hand, gauge, shieldCheck, shieldOff, dollar, equal, location
    case textCursor, listChecks, layoutList, power, upload, cloudOff, unlink
    case logOut, flag, imageOff, activity, gitMerge, volumeX, ellipsisVertical
    case squareStack
    /// The same paperclip as ``attach``, under the name the Code shell reaches
    /// for. Two names, one asset — a Lucide mark is what it draws, not a role.
    case paperclip

    /// The last marks the shared packages still spelled as SF Symbol names:
    /// a Markdown task-list checkbox, and the block headers over a Mermaid
    /// diagram — each named for what the diagram *is*, so a reader skimming a
    /// long answer can find the sequence diagram without reading its label.
    case squareCheck, square, arrowLeftRight, workflow, chartPie, chartGantt, waypoints

    /// The asset-catalog name, matching the generator's output.
    public var assetName: String { "nav-\(rawValue)" }

    /// The website's mark for an SF Symbol name, or `nil` when no such mark
    /// exists.
    ///
    /// **An exact table, not a heuristic.** The previous mapping matched
    /// substrings — `"doc.on.doc"` contained `"doc"` and became a file,
    /// `"speaker.wave.2"` matched nothing and became a *wrench* — and it was
    /// why every message's action row on the Mac drew wrenches and arrows.
    /// A name that is not in this table resolves to nothing.
    ///
    /// **No view takes an SF Symbol name any more.** ``JunoIconView`` and
    /// ``JunoIconLabel`` name a ``JunoIcon`` case, and the compiler checks
    /// that the mark exists; the string-typed rendering path they used to
    /// offer drew an empty frame for anything it did not know, and that gap
    /// was invisible until someone looked at the screen. This lookup stays
    /// for data that arrives as a symbol name — a model's capability badge,
    /// a recent-activity kind — where the caller then names the fallback.
    public init?(systemImage: String) {
        guard let icon = JunoIcon.systemImageTable[systemImage.lowercased()] else {
            return nil
        }
        self = icon
    }

    /// SF Symbol name → the website's mark. Lower-cased keys.
    static let systemImageTable: [String: JunoIcon] = [
        // Alerts and status
        "exclamationmark.triangle": .triangleAlert,
        "exclamationmark.triangle.fill": .triangleAlert,
        "exclamationmark.circle": .error,
        "exclamationmark.circle.fill": .error,
        "exclamationmark.shield.fill": .permission,
        "exclamationmark.arrow.triangle.2.circlepath": .refresh,
        "checkmark": .check,
        "checkmark.circle": .circleCheck,
        "checkmark.circle.fill": .circleCheck,
        "checkmark.seal": .badgeCheck,
        "checkmark.seal.fill": .badgeCheck,
        "checklist": .listChecks,
        "checklist.checked": .listChecks,
        "checkmark.square.fill": .squareCheck,
        "square": .square,
        "arrow.left.arrow.right": .arrowLeftRight,
        "point.topleft.down.to.point.bottomright.curvepath": .workflow,
        "chart.pie": .chartPie,
        "chart.bar.xaxis": .chartGantt,
        "circle.hexagongrid": .waypoints,
        "xmark": .close,
        "xmark.circle": .circleX,
        "xmark.circle.fill": .circleX,
        "xmark.octagon": .octagonX,
        "xmark.shield": .shieldOff,
        "xmark.seal.fill": .circleX,
        "info": .about,
        "info.circle": .about,
        "questionmark.circle": .circleHelp,
        "questionmark.bubble": .circleHelp,
        "questionmark.diamond": .circleHelp,
        "questionmark.folder": .projects,
        "slash.circle": .circleSlash,
        "minus": .minus,
        "minus.circle": .circleMinus,
        "minus.circle.fill": .circleMinus,
        "plus": .plus,
        "plus.circle": .plus,
        "plusminus.circle": .diff,
        "plus.forwardslash.minus": .diff,
        "equal": .equal,
        "circle": .circle,
        "circle.fill": .circleDot,
        "circle.inset.filled": .circleDot,
        "circle.lefthalf.filled": .circleDot,
        "circle.dotted": .circleDashed,
        "circle.dashed": .circleDashed,
        "circle.dotted.circle": .circleDot,
        "hourglass": .hourglass,
        "hourglass.circle": .hourglass,
        "gauge.with.dots.needle.33percent": .gauge,
        "gauge.with.dots.needle.67percent": .gauge,
        "gauge.with.dots.needle.100percent": .gauge,
        "flag.checkered": .flag,
        "location": .location,
        "dollarsign.circle": .dollar,
        "waveform.path.ecg": .activity,

        // Arrows and chevrons
        "chevron.down": .chevronDown,
        "chevron.up": .chevronUp,
        "chevron.left": .chevronLeft,
        "chevron.right": .chevronRight,
        "chevron.up.chevron.down": .chevronsUpDown,
        "arrow.up": .arrowUp,
        "arrow.up.circle": .arrowUp,
        "arrow.down": .arrowDown,
        "arrow.down.circle": .arrowDown,
        "arrow.left": .arrowLeft,
        "arrow.right": .arrowRight,
        "arrow.right.circle": .arrowRight,
        "arrow.up.right": .external,
        "arrow.up.right.square": .external,
        "arrow.up.left.and.arrow.down.right": .maximize,
        "arrow.down.to.line.compact": .download,
        "arrow.down.to.line": .download,
        "laptopcomputer.and.arrow.down": .download,
        "square.and.arrow.down": .download,
        "arrow.up.doc": .files,
        "arrow.clockwise": .refresh,
        "arrow.triangle.2.circlepath": .refresh,
        "arrow.counterclockwise": .rotateCcw,
        "arrow.counterclockwise.circle": .rotateCcw,
        "arrow.uturn.backward": .undo,
        "arrow.triangle.branch": .branch,
        "arrow.trianglehead.merge": .gitMerge,
        "arrow.trianglehead.pull": .pulls,
        "square.and.arrow.up": .share,

        // Files, folders, documents
        "doc": .file,
        "doc.text": .file,
        "doc.richtext": .file,
        "doc.on.doc": .copy,
        "doc.badge.plus": .filePlus,
        "doc.badge.arrow.up": .files,
        "doc.badge.ellipsis": .file,
        "doc.badge.gearshape": .file,
        "doc.text.magnifyingglass": .fileSearch,
        "folder": .projects,
        "folder.badge.plus": .folderPlus,
        "folder.badge.questionmark": .projects,
        "folder.badge.gearshape": .projects,
        "paperclip": .attach,
        "paperclip.circle": .paperclip,
        "photo": .image,
        "photo.badge.exclamationmark": .imageOff,
        "books.vertical": .library,
        "square.stack.3d.up": .artifacts,
        "square.on.square.dashed": .squareStack,
        "rectangle.on.rectangle": .copy,
        "square.grid.2x2": .grid,
        "circle.grid.cross": .grid,
        "rectangle.3.group": .artifactsTool,
        "square.split.2x1": .columns,
        "rectangle.split.2x1": .columns,
        "rectangle.topthird.inset.filled": .panelLeft,
        "sidebar.trailing": .panelRight,
        "sidebar.leading": .panelLeft,
        "macwindow": .appWindow,
        "macwindow.on.rectangle": .appWindow,
        "list.bullet": .list,
        "list.bullet.rectangle": .layoutList,
        "text.alignleft": .writing,
        "text.magnifyingglass": .search,
        "magnifyingglass": .search,
        "binoculars": .binoculars,
        "character.cursor.ibeam": .textCursor,
        "crop": .crop,
        "scope": .crosshair,
        "trash": .trash,
        "trash.fill": .trash,
        "pencil": .pencil,
        "pencil.tip": .penTool,
        "square.and.pencil": .compose,
        "ellipsis": .ellipsis,
        "ellipsis.circle": .ellipsis,
        "link": .link,
        "slider.horizontal.3": .sliders,
        "line.3.horizontal.decrease": .filter,
        "line.3.horizontal.decrease.circle": .filter,

        // Time
        "clock": .clock,
        "clock.fill": .clock,
        "clock.badge.checkmark": .clockCheck,
        "clock.badge.exclamationmark": .clockAlert,
        "clock.arrow.circlepath": .history,
        "calendar.badge.clock": .tasks,
        "bolt.badge.clock": .tasks,

        // Media and voice
        "play": .play,
        "play.fill": .play,
        "play.circle": .circlePlay,
        "pause": .pause,
        "pause.fill": .pause,
        "pause.circle": .circlePause,
        "stop": .stop,
        "stop.fill": .stop,
        "stop.circle": .circleStop,
        "stop.circle.fill": .circleStop,
        "mic": .mic,
        "mic.fill": .mic,
        "mic.slash": .micOff,
        "speaker.wave.2": .volume,
        "speaker.slash": .volumeX,
        "phone.down.fill": .phoneOff,

        // People, security, devices
        "person": .user,
        "person.crop.circle": .userCircle,
        "person.2": .agents,
        "hand.raised": .hand,
        "hand.raised.fill": .hand,
        "hand.thumbsup": .thumbsUp,
        "hand.thumbsup.fill": .thumbsUp,
        "hand.thumbsdown": .thumbsDown,
        "hand.thumbsdown.fill": .thumbsDown,
        "lock": .lock,
        "lock.open": .lockOpen,
        "lock.slash": .lockOpen,
        "shield.lefthalf.filled": .shield,
        "key": .key,
        "eye": .eye,
        "eye.slash": .eyeOff,
        "laptopcomputer": .device,
        "laptopcomputer.slash": .monitorOff,
        "laptopcomputer.trianglebadge.exclamationmark": .monitorOff,
        "desktopcomputer": .monitor,
        "desktopcomputer.trianglebadge.exclamationmark": .monitorOff,
        "shippingbox": .box,
        "wifi.slash": .wifiOff,
        "wifi.exclamationmark": .wifiOff,
        "powerplug": .connections,
        "point.3.connected.trianglepath.dotted": .connections,
        "app.connected.to.app.below.fill": .connections,
        "power": .power,

        // Product marks
        "bubble.left.and.bubble.right": .conversation,
        "text.bubble": .message,
        "globe": .web,
        "safari": .web,
        "telescope": .research,
        "sparkles": .sparkles,
        "brain": .brain,
        "brain.head.profile": .brain,
        "cpu": .models,
        "theatermasks": .appearance,
        "gearshape": .settings,
        "wrench.and.screwdriver": .tools,
        "bolt.horizontal": .work,
        "bolt.horizontal.fill": .work,
        "bolt.horizontal.circle": .work,
        "chart.line.uptrend.xyaxis": .chartLine,
        "chart.bar.doc.horizontal": .usage,
        "sun.max": .sun,
        "moon": .moon,
        "bell": .bell,
        "archivebox": .archive,
        "pin": .pin,
        "terminal": .terminal,
        "apple.terminal": .terminal,
    ]
}

/// Renders a ``JunoIcon`` at a weight that sits correctly beside SF Symbols.
///
/// Lucide draws on a 24pt grid with a 2pt stroke. At a 20pt render that stroke
/// reads slightly heavier than an equivalent SF Symbol, so the default size is
/// nudged down rather than scaling the artwork up — matching stroke weight
/// matters more than matching bounding box when the two sit in one list.
///
/// **This is the one icon API.** `JunoIconView(.copy, size: 16)` in a view,
/// `Label("Copy", icon: .copy)` where a label is wanted. Every mark is one of
/// the website's own, generated from `lucide-react`. There is no SF Symbol
/// path: the `systemImage:` initialiser this once carried drew an empty frame
/// for a name it could not resolve, and the gap was invisible until someone
/// looked at the screen. A mark that is missing is now a compile error.
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

public extension Label where Title == Text, Icon == JunoIconView {
    /// `Label("Copy", icon: .copy)` — a label whose mark is one of the
    /// website's, sized for a menu row or a list row rather than at the asset's
    /// own 24pt.
    @MainActor
    init(_ title: LocalizedStringKey, icon: JunoIcon, size: CGFloat = 15) {
        self.init { Text(title) } icon: { JunoIconView(icon, size: size) }
    }

    /// The same for a runtime string.
    @MainActor
    init(verbatim title: String, icon: JunoIcon, size: CGFloat = 15) {
        self.init { Text(title) } icon: { JunoIconView(icon, size: size) }
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
