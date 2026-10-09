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

/// Alevr's mark: the Continuum — four blades turning around an open aperture.
///
/// Drawn as vector paths from the web's own construction data
/// (`src/components/brand/continuum-geometry.ts`, projected into
/// ``JunoBrandGeometry`` by `scripts/generate-native-brand-geometry.mjs`), not
/// from a raster. That buys three things the old chat-bubble PNG could not:
/// it is crisp at every size and scale; it picks the web's **optical master**
/// for the mark's width in device pixels (a 16pt mark on a 2x screen draws the
/// 32 master, as `continuumDrawingSet` does), so the channels between the
/// blades stay open at sidebar sizes; and it renders in offscreen snapshot
/// tests, where asset-catalog images come out blank.
///
/// The blades fill with the current foreground style — the native equivalent
/// of the web's `currentColor` — so the mark is correct in light and dark with
/// no second drawing. It is intentionally not tinted: the mark is ink, and the
/// accent is reserved for what is active.
///
/// The mark is the *brand*. The working indicator is ``JunoGalaxyMark``; the
/// two are never swapped for one another.
public struct JunoMark: View {
    private let size: CGFloat

    @Environment(\.displayScale) private var displayScale

    public init(size: CGFloat = 22) {
        self.size = size
    }

    public var body: some View {
        JunoContinuumShape(drawing: JunoContinuumShape.drawing(forDevicePixels: size * displayScale))
            .fill(.foreground)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The Continuum's four blades as one shape, in a square box.
///
/// `drawing` is a ``JunoBrandGeometry/continuum`` key: 16, 20, 24 or 32 for an
/// optical master, 0 for the master itself.
public struct JunoContinuumShape: Shape {
    public let drawing: Int

    public init(drawing: Int = 0) {
        self.drawing = JunoBrandGeometry.continuum[drawing] == nil ? 0 : drawing
    }

    /// The web's `opticalSizeFor`: the master that suits a rendered width in
    /// device pixels, or the master above 40.
    public static func drawing(forDevicePixels width: CGFloat) -> Int {
        if width <= 17 { return 16 }
        if width <= 21 { return 20 }
        if width <= 27 { return 24 }
        if width <= 40 { return 32 }
        return 0
    }

    public func path(in rect: CGRect) -> Path {
        var path = Path()
        for blade in 0..<4 {
            path.addPath(Self.blade(blade, drawing: drawing, in: rect))
        }
        return path
    }

    /// One blade, numbered clockwise from the upper sweep.
    public static func blade(_ index: Int, drawing: Int, in rect: CGRect) -> Path {
        let blades = JunoBrandGeometry.continuum[drawing] ?? JunoBrandGeometry.continuum[0]!
        let points = blades[index]
        let units = drawing == 0 ? JunoBrandGeometry.continuumMasterSide : CGFloat(drawing)
        func point(_ i: Int) -> CGPoint {
            CGPoint(x: rect.minX + points[i] / units * rect.width,
                    y: rect.minY + points[i + 1] / units * rect.height)
        }
        var path = Path()
        path.move(to: point(0))
        for i in stride(from: 2, to: points.count, by: 6) {
            path.addCurve(to: point(i + 4), control1: point(i), control2: point(i + 2))
        }
        path.closeSubpath()
        return path
    }
}

/// The "Alevr" wordmark: Newsreader SemiBold outlined to paths, as the web
/// sets it (`alevr-wordmark-geometry.ts`). A logotype, never live text, so it
/// does not depend on a font being installed and never reflows.
///
/// Sized by height; the width follows the word's own aspect. Fills with the
/// current foreground style.
public struct JunoWordmark: View {
    private let height: CGFloat

    public init(height: CGFloat = 18) {
        self.height = height
    }

    public var body: some View {
        let bounds = JunoBrandGeometry.wordmarkBounds
        JunoWordmarkShape()
            .fill(.foreground)
            .frame(width: height * bounds.width / bounds.height, height: height)
            .accessibilityElement()
            .accessibilityLabel("Alevr")
    }
}

/// The wordmark's outlines, fitted to their ink bounds.
public struct JunoWordmarkShape: Shape {
    public init() {}

    private static let outline: Path = {
        var path = Path()
        for glyph in JunoBrandGeometry.wordmark {
            path.addPath(JunoSVGPath.parse(glyph))
        }
        return path
    }()

    public func path(in rect: CGRect) -> Path {
        let bounds = JunoBrandGeometry.wordmarkBounds
        let scale = min(rect.width / bounds.width, rect.height / bounds.height)
        let transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: scale, y: scale)
            .translatedBy(x: -bounds.minX, y: -bounds.minY)
        return Self.outline.applying(transform)
    }
}

/// The few SVG path commands the brand geometry is written in: absolute and
/// relative M, L, H, V, C, Q and Z.
enum JunoSVGPath {
    static func parse(_ data: String) -> Path {
        var path = Path()
        var tokens: [String] = []
        var number = ""
        func flush() {
            if !number.isEmpty { tokens.append(number); number = "" }
        }
        for character in data {
            if character.isLetter, character != "e" {
                flush()
                tokens.append(String(character))
            } else if character == "-", !number.isEmpty, number.last != "e" {
                flush()
                number = "-"
            } else if character == " " || character == "," {
                flush()
            } else {
                number.append(character)
            }
        }
        flush()

        var index = 0
        var command: Character = "M"
        var current = CGPoint.zero
        var start = CGPoint.zero
        func next() -> CGFloat {
            defer { index += 1 }
            return index < tokens.count ? CGFloat(Double(tokens[index]) ?? 0) : 0
        }
        func point(relative: Bool) -> CGPoint {
            let x = next(), y = next()
            return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        }
        while index < tokens.count {
            if let letter = tokens[index].first, letter.isLetter {
                command = letter
                index += 1
            }
            let relative = command.isLowercase
            switch command.uppercased() {
            case "M":
                current = point(relative: relative)
                start = current
                path.move(to: current)
                // Further pairs after a move are lines.
                command = relative ? "l" : "L"
            case "L":
                current = point(relative: relative)
                path.addLine(to: current)
            case "H":
                let x = next()
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
            case "V":
                let y = next()
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
            case "C":
                let c1 = point(relative: relative), c2 = point(relative: relative), to = point(relative: relative)
                path.addCurve(to: to, control1: c1, control2: c2)
                current = to
            case "Q":
                let c = point(relative: relative), to = point(relative: relative)
                path.addQuadCurve(to: to, control: c)
                current = to
            case "Z":
                path.closeSubpath()
                current = start
            default:
                index += 1
            }
        }
        return path
    }
}

/// The Alevr lockup: mark plus wordmark, the mark's mass one and a half path
/// widths from the word, as `alevr-lockup-geometry.ts` sets it.
public struct JunoLogo: View {
    private let showsWordmark: Bool
    private let height: CGFloat

    /// - Parameter height: the mark's side. The word's cap height follows the
    ///   web's lockup (the mark is 1.1 cap heights tall).
    public init(showsWordmark: Bool = true, height: CGFloat = 24) {
        self.showsWordmark = showsWordmark
        self.height = height
    }

    public var body: some View {
        HStack(spacing: height * 0.2) {
            JunoMark(size: height)
            if showsWordmark {
                // The wordmark's ink box (ascender to baseline) is ~1.08 cap
                // heights; the mark sits at 1.1 cap heights.
                JunoWordmark(height: height * 0.72)
            }
        }
        .foregroundStyle(.primary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Alevr")
    }
}

/// A Juno glyph: a product destination, one of the things Juno Code talks
/// about, or a control.
///
/// These are the website's own icons, not lookalikes. The web draws every glyph
/// through `src/components/ui/icons.tsx` — Phosphor's geometry on its 256-unit
/// grid, plus Juno's own marks — and `src/lib/app-icons.ts` decides which
/// drawing each concept wears. A case named for a registry key (`AppIcons`,
/// `CodeIcons`, `ComposerIcons`, `StatusIcons`, `ActionIcons`,
/// `SettingsIcons`) wears exactly that key's drawing, and
/// `scripts/generate-native-icons.mjs --check` fails when one does not. The
/// assets are SF Symbol templates generated from the installed
/// `@phosphor-icons/react` and `juno-glyph-paths.ts`; regenerate rather than
/// editing them by hand.
///
/// Several cases can wear one drawing — `.edit` and `.pencil`, `.dismiss` and
/// `.close` — because the web's registries name concepts, and two concepts may
/// share a mark without being the same thing.
///
/// SF Symbols remain correct for what the system owns (§8.6): the sidebar
/// toggle, the magnifier inside a system search field, menu checkmarks,
/// disclosure chevrons, `ProgressView`, window controls and the share sheet's
/// own glyph. The line is whether the mark names something in the product or
/// something in the OS: a pull request is Juno's, a disclosure chevron is
/// Apple's.
public enum JunoIcon: String, CaseIterable, Sendable {
    case home, work, code, library, artifacts, projects
    /// The sidebar's New chat — the web's `new-chat` drawing (MessageSquarePlus).
    case newChat
    case tasks, connections, pulls, conversation, new, search

    /// The web reaches Settings from the user menu rather than the rail, and
    /// draws it with the same six-toothed gear (`AppIcons.settings`); the native
    /// sidebars give it a row.
    case settings

    /// The rest of `AppIcons`: Juno Design, and the destinations the web's
    /// command palette and More menu name.
    case design, assistants, skills, automations, permissions

    /// Juno Code's vocabulary (`CodeIcons`). `pin` is a pin and never a star,
    /// `error` is a circle and never a triangle, and `branch` covers
    /// repository, default branch and base ref alike — each because that is
    /// what the web draws.
    case cloud, device, branch, lock, permission
    case pin, error, refresh, external, file

    /// What the composer's "+" menu adds to a message, and the tools it arms
    /// (`ComposerIcons`).
    case attach, photos, files, canvas
    case research, web, artifactsTool, memory, task

    /// `StatusIcons`: what happens to you. A warning is a triangle, an error a
    /// circle (`.error`, above), a note an "i".
    case warning, info, success, verified, security

    /// `ActionIcons`: what you do. `.more` is the horizontal overflow on every
    /// row, card and message; `.restore` is the anticlockwise arrow, and
    /// ``archiveRestore`` is the box that brings an archived row back.
    case edit, delete, dismiss, restore, more, parameters

    /// `SettingsIcons`: the settings rail, each named for the thing you edit.
    case general, personalization, connectors, voice, data, account, billing

    /// The private-chat ghost (`private-chat-toggle.tsx`), with still eyes.
    /// Its `.fill` cut — the solid body with the face cut out — is the "on"
    /// state.
    case privateChat

    /// Marks the web draws under its own export names, where no registry key
    /// covers them: Unpin (`PinOff`), Restore from the archive
    /// (`ArchiveRestore`), Screenshot (`Scan`), the voice face (`AudioLines`)
    /// and Share Screen (`MonitorUp`).
    case pinOff, archiveRestore, scan, audioLines, monitorUp

    /// Settings, profile, and feature sections.
    case usage, appearance, writing, language, models, notifications, about
    case user, tools, knowledge, sliders

    /// Action controls, media, and navigation glyphs.
    case mic, send, stop, plus, chevronLeft, chevronRight, chevronDown, chevronUp
    case trash, pencil, copy, check, close, ellipsis, share, terminal
    case arrowDown, volume, thumbsUp, thumbsDown, eyeOff

    /// Added for the macOS rework: Codex-class Code shell, message actions,
    /// native lists.
    case folderOpen, folderPlus, clock, history, shield, compass, blocks
    case play, pause, gitCommit, fork, fileDiff, list, grid, image
    case circleDot, loader, agents, archive, download, filter, eye, message
    /// The design presets' devices (the web's `Smartphone` and `Tablet`,
    /// Phosphor's `DeviceMobile` and `DeviceTablet`).
    case smartphone, tablet
    case bell, arrowUp, arrowLeft, arrowRight, minus, box, key, link
    case sun, moon, monitor, home2
    case keyboard

    /// Status and state marks — the web's `StatusIcons` under their old
    /// names, and the glyphs its lists draw beside a row's state. Added so the
    /// last SF Symbol names still crossing a package boundary resolve to a real
    /// mark instead of the wrench that ``init(systemImage:)``'s predecessor
    /// handed out for anything it did not recognise.
    ///
    /// `sparkles` and `brain` resolve because existing call sites name them,
    /// not because they are right: §10.2 bans both as marks for "AI".
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
    /// for. Two names, one drawing.
    case paperclip

    /// The last marks the shared packages still spelled as SF Symbol names:
    /// a Markdown task-list checkbox, and the block headers over a Mermaid
    /// diagram — each named for what the diagram *is*, so a reader skimming a
    /// long answer can find the sequence diagram without reading its label.
    case squareCheck, square, arrowLeftRight, workflow, chartPie, chartGantt, waypoints

    /// The transcript's own vocabulary (Phase 2): Switch Model's cube, the
    /// Regenerate menu's More Concise (`ListMinus`, drawn as dashes) and Add
    /// Details, Continue's elbow, a generated video, a link that leaves the
    /// app (`ExternalLink`, a square with an arrow out of it — ``external`` is
    /// the bare arrow), and a React artifact's brackets (`Code2`, which is not
    /// the Juno Code mark ``code`` wears).
    case cube, listDashes, listPlus, cornerDownRight, video, externalLink, codeBrackets

    /// The run's tool rows: `calculate` and `search_chats` (SPEC §3.1).
    case calculator, chats

    /// A task's meter (Phase 5): Elapsed, Cost and Tokens — the web's
    /// `WorkLiveMeter` glyphs.
    case timer, coins, sigma
    /// The research report window's Print… (the web's `Printer`).
    case printer

    /// The memory page's topics (`memory-icons.tsx`) — each the drawing the
    /// web files that category under — the never-remember list's project
    /// token (`FolderLock`), the empty topic list (`Layers`), and Import from
    /// GitHub on the Skills page, which wears Phosphor's own GitHub mark
    /// where the web draws the brand's filled one (register #75).
    case fingerprint, target, graduationCap, braces, users, layers, folderLock, github

    /// The menu bar's Command Menu… (Phase 3 Stage A): the ⌘ key itself.
    case command

    /// Phase 3 Stage B: the ⌘K panel's "Roadmap & feature requests" row
    /// (the web's `Map`).
    case mapTrifold

    /// Settings (Phase 3 Stage C): the profile photo's camera badge and a
    /// pinned model's star.
    case camera, star
    /// The effort panel's Flash: the web's `Zap` (its `bolt` drawing).
    case zap

    /// The generated symbol this case wears, without a cut suffix: `ph.<name>`
    /// for Phosphor's drawings, `juno.<name>` for Juno's own.
    ///
    /// One case per line, and only string literals: the generator's check
    /// reads this switch to prove every name exists, carries a `.bold` cut,
    /// and — for a registry key — is the drawing the web's registry assigns.
    public var symbolName: String {
        switch self {
        // Juno's own marks.
        case .home, .conversation: "juno.chat"
        case .code: "juno.code"
        case .design: "juno.design"
        case .library: "juno.library"
        case .agents: "juno.agents"
        case .send: "juno.send"
        case .privateChat: "juno.ghost"

        // AppIcons.
        case .work, .automations, .task, .workflow: "ph.treestructure"
        case .artifacts: "ph.stack"
        case .projects: "ph.folder"
        case .folderOpen: "ph.folderopen"
        case .tasks: "ph.calendardots"
        case .connections, .connectors: "ph.plug"
        case .pulls: "ph.gitpullrequest"
        case .new, .plus: "ph.plus"
        case .newChat: "ph.newchat"
        case .search: "ph.magnifyingglass"
        case .settings: "ph.gearsix"
        case .assistants: "ph.robot"
        case .skills: "ph.scroll"
        case .permissions, .shieldCheck: "ph.shieldcheck"

        // CodeIcons.
        case .cloud: "ph.cloud"
        case .device: "ph.laptop"
        case .branch: "ph.gitbranch"
        case .lock: "ph.locksimple"
        case .permission, .security: "ph.shieldwarning"
        case .pin: "ph.pushpin"
        case .error: "ph.warningcircle"
        case .refresh: "ph.arrowclockwise"
        case .external: "ph.arrowupright"
        case .file: "ph.filetext"

        // ComposerIcons.
        case .attach, .paperclip: "ph.paperclip"
        case .photos: "ph.imagesquare"
        case .files: "ph.filearrowup"
        case .canvas, .memory, .compose: "ph.notepencil"
        case .research, .binoculars: "ph.binoculars"
        case .web, .language: "ph.globesimple"
        case .artifactsTool: "ph.layout"
        case .scan: "ph.scan"

        // StatusIcons and ActionIcons.
        case .warning, .triangleAlert: "ph.warning"
        case .info, .about: "ph.info"
        case .success, .check: "ph.check"
        case .verified, .badgeCheck: "ph.sealcheck"
        case .edit, .pencil: "ph.pencilsimple"
        case .delete, .trash: "ph.trash"
        case .dismiss, .close: "ph.x"
        case .restore, .rotateCcw: "ph.arrowcounterclockwise"
        case .more, .ellipsis: "ph.dotsthree"
        case .parameters, .general, .sliders, .filter: "ph.slidershorizontal"
        case .copy: "ph.copy"
        case .share: "ph.sharenetwork"
        case .download: "ph.downloadsimple"
        case .upload: "ph.uploadsimple"
        case .link: "ph.linksimple"
        case .unlink: "ph.linksimplebreak"
        case .archive: "ph.archive"
        case .archiveRestore: "ph.boxarrowup"
        case .pinOff: "ph.pushpinslash"
        case .logOut: "ph.signout"
        case .thumbsUp: "ph.thumbsup"
        case .thumbsDown: "ph.thumbsdown"
        case .volume: "ph.speakerhigh"
        case .quote: "ph.quotes"
        case .fork: "ph.gitfork"

        // SettingsIcons.
        case .personalization: "ph.usergear"
        case .models, .cube: "ph.cube"
        case .data: "ph.database"
        case .account, .user: "ph.user"
        case .billing: "ph.creditcard"

        // Voice and media.
        case .mic, .voice: "ph.microphone"
        case .micOff: "ph.microphoneslash"
        case .audioLines: "ph.waveform"
        case .phoneOff: "ph.phonedisconnect"
        case .monitorUp: "ph.monitorarrowup"
        case .monitorOff: "ph.screencast"
        case .stop, .square: "ph.square"
        case .play: "ph.play"
        case .pause: "ph.pause"
        case .circlePlay: "ph.playcircle"
        case .circlePause: "ph.pausecircle"
        case .circleStop: "ph.stopcircle"
        case .image: "ph.image"
        case .imageOff: "ph.imagebroken"
        case .crop: "ph.crop"
        case .crosshair: "ph.crosshair"

        // Direction and navigation.
        case .chevronLeft: "ph.caretleft"
        case .chevronRight: "ph.caretright"
        case .chevronDown: "ph.caretdown"
        case .chevronUp: "ph.caretup"
        case .chevronsUpDown: "ph.caretupdown"
        case .arrowDown: "ph.arrowdown"
        case .arrowUp: "ph.arrowup"
        case .arrowLeft: "ph.arrowleft"
        case .arrowRight: "ph.arrowright"
        case .arrowLeftRight: "ph.arrowsleftright"
        case .maximize: "ph.arrowsoutsimple"
        case .undo: "ph.arrowuupleft"
        case .history: "ph.clockcounterclockwise"
        case .panelLeft: "ph.sidebarsimple"
        case .panelRight: "ph.sidebarsimple.mirrored"
        case .ellipsisVertical: "ph.dotsthreevertical"

        // Objects, people and state.
        case .terminal: "ph.terminalwindow"
        case .eyeOff: "ph.eyeslash"
        case .eye: "ph.eye"
        case .clock: "ph.clock"
        case .fileDiff, .diff: "ph.gitdiff"
        case .list: "ph.listbullets"
        case .listChecks: "ph.listchecks"
        case .grid: "ph.squaresfour"
        case .columns: "ph.columns"
        case .loader: "ph.circlenotch"
        case .message: "ph.chattext"
        case .minus: "ph.minus"
        case .box: "ph.package"
        case .key: "ph.key"
        case .sun: "ph.sun"
        case .moon: "ph.moon"
        case .monitor: "ph.monitor"
        case .smartphone: "ph.devicemobile"
        case .tablet: "ph.devicetablet"
        case .keyboard: "ph.keyboard"
        case .knowledge: "ph.bookopen"
        case .tools: "ph.wrench"
        case .circleCheck: "ph.checkcircle"
        case .circleX: "ph.xcircle"
        case .circleHelp: "ph.question"
        case .circleDashed: "ph.circledashed"
        case .circleSlash: "ph.prohibitinset"
        case .octagonX: "ph.prohibit"
        case .circle: "ph.circle"
        case .fileSearch: "ph.filemagnifyingglass"
        case .fileCode: "ph.filecode"
        case .wifiOff: "ph.wifislash"
        case .sparkles: "ph.sparkle"
        case .penTool: "ph.pennib"
        case .lockOpen: "ph.locksimpleopen"
        case .hand: "ph.hand"
        case .shieldOff: "ph.shieldslash"
        case .activity: "ph.pulse"
        case .squareStack: "ph.cards"
        case .cloudOff: "ph.cloudslash"

        // Named by a native surface only; each is Phosphor's own drawing of it.
        case .usage: "ph.chartbar"
        case .appearance: "ph.palette"
        case .writing: "ph.textalignleft"
        case .notifications: "ph.bellsimple"
        case .bell: "ph.bell"
        case .folderPlus: "ph.folderplus"
        case .shield: "ph.shield"
        case .compass: "ph.compass"
        case .blocks: "ph.puzzlepiece"
        case .gitCommit: "ph.gitcommit"
        case .gitMerge: "ph.gitmerge"
        case .circleDot: "ph.record"
        case .home2: "ph.house"
        case .circleMinus: "ph.minuscircle"
        case .filePlus: "ph.fileplus"
        case .fileQuestion: "ph.filedashed"
        case .clockCheck, .calendarCheck: "ph.calendarcheck"
        case .clockAlert: "ph.clockcountdown"
        case .hourglass: "ph.hourglass"
        case .appWindow: "ph.appwindow"
        case .userCircle: "ph.usercircle"
        case .brain: "ph.brain"
        case .chartLine: "ph.chartline"
        case .chartPie: "ph.chartpie"
        case .chartGantt: "ph.chartbarhorizontal"
        case .gauge: "ph.gauge"
        case .dollar: "ph.currencydollar"
        case .equal: "ph.equals"
        case .location: "ph.mappin"
        case .textCursor: "ph.cursortext"
        case .layoutList: "ph.rows"
        case .power: "ph.power"
        case .flag: "ph.flag"
        case .volumeX: "ph.speakerx"
        case .squareCheck: "ph.checksquare"
        case .waypoints: "ph.graph"

        // The transcript's menus and cards.
        case .listDashes: "ph.listdashes"
        case .listPlus: "ph.listplus"
        case .cornerDownRight: "ph.arrowelbowdownright"
        case .video: "ph.videocamera"
        case .externalLink: "ph.arrowsquareout"
        case .codeBrackets: "ph.code"
        case .calculator: "ph.calculator"
        case .chats: "ph.chats"
        case .timer: "ph.timer"
        case .coins: "ph.coins"
        case .sigma: "ph.sigma"
        case .printer: "ph.printer"
        case .fingerprint: "ph.fingerprint"
        case .target: "ph.target"
        case .graduationCap: "ph.graduationcap"
        case .braces: "ph.bracketscurly"
        case .users: "ph.users"
        case .layers: "ph.stacksimple"
        case .folderLock: "ph.folderlock"
        case .github: "ph.githublogo"
        case .command: "ph.command"
        case .mapTrifold: "ph.maptrifold"
        case .camera: "ph.camera"
        case .star: "ph.star"
        case .zap: "ph.lightning"
        }
    }

    /// The symbols that ship a `.fill` cut: the "on" drawings — a pinned row,
    /// the stop face, a rated reply, the selected product, private mode on.
    /// Everything else has no solid drawing, and asking for one draws the
    /// outline rather than an empty frame.
    static let filledSymbols: Set<String> = [
        "juno.chat", "juno.code", "juno.design", "juno.library", "juno.agents", "juno.ghost",
        "ph.pushpin", "ph.square", "ph.thumbsup", "ph.thumbsdown", "ph.star",
    ]

    /// Which of a glyph's drawings to use — the web's `weight`, and the only
    /// three the apps ship.
    public enum Weight: String, CaseIterable, Sendable {
        /// The house weight: a 16-unit line on the 256 grid, 1pt at 16pt.
        case regular
        /// The heavier cut, for 13pt and under, where a 1pt line starts to
        /// disappear.
        case bold
        /// The solid drawing, for an "on" or selected state only.
        case fill
    }

    /// Whether this glyph has a solid drawing for an "on" state.
    public var hasFill: Bool { Self.filledSymbols.contains(symbolName) }

    /// The regular cut's asset name — what `Image(_:)`, `Label(_:image:)` and
    /// `NSImage(named:)` load. A symbol, so it sizes with the surrounding font
    /// like an SF Symbol does.
    public var assetName: String { symbolName }

    /// The asset for one cut. A `.fill` this glyph does not have falls back to
    /// the regular drawing: an outline in the "on" state is a smaller mistake
    /// than an empty frame.
    public func assetName(_ weight: Weight) -> String {
        switch weight {
        case .regular: symbolName
        case .bold: "\(symbolName).bold"
        case .fill: hasFill ? "\(symbolName).fill" : symbolName
        }
    }

    /// The web's optical rule (`icons.tsx`): the solid drawing only for an "on"
    /// state, and only where one exists; otherwise the bold cut at 13pt and
    /// under, where a 1pt line starts to disappear.
    public func opticalWeight(size: CGFloat, isOn: Bool = false) -> Weight {
        if isOn, hasFill { return .fill }
        return size <= 13 ? .bold : .regular
    }

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

/// Renders a ``JunoIcon`` in a fixed square, choosing the cut the way the web
/// does.
///
/// `size` is the edge of the 256-unit grid, as on the web: `JunoIconView(.copy,
/// size: 16)` draws what `<Copy size={16} />` draws. At 13pt and under it takes
/// the bold cut, whose line survives the size; `isOn: true` takes the solid
/// drawing where the glyph has one (a pinned row, a rated reply, private mode
/// on) and is ignored where it does not. `weight:` overrides both, for the few
/// places the design names a cut outright — the composer's send face is
/// `JunoIconView(.send, size: 14, weight: .bold)`.
///
/// The default size stays at the 19pt the unsized call sites were laid out
/// against. §8.6's house size is 16 (12 bold, 14, 20 for empty states); new
/// surfaces pass it.
///
/// **This is the one icon API for a fixed box.** Where the system sizes the
/// glyph — a sidebar row, a menu item, a toolbar label — use the symbol itself
/// (`Image(.library)`, `Label("Library", image: JunoIcon.library.assetName)`),
/// which takes the text's size and baseline like an SF Symbol. There is no SF
/// Symbol path here: the `systemImage:` initialiser this once carried drew an
/// empty frame for a name it could not resolve, and the gap was invisible until
/// someone looked at the screen. A mark that is missing is now a compile error.
public struct JunoIconView: View {
    private let icon: JunoIcon
    private let size: CGFloat
    private let weight: JunoIcon.Weight
    @Environment(\.displayScale) private var displayScale

    public init(_ icon: JunoIcon, size: CGFloat = 19, weight: JunoIcon.Weight? = nil, isOn: Bool = false) {
        self.icon = icon
        self.size = size
        self.weight = weight ?? icon.opticalWeight(size: size, isOn: isOn)
    }

    public var body: some View {
        JunoGlyphBox.image(named: icon.assetName(weight), box: size, scale: displayScale)
            .renderingMode(.template)
            .frame(width: size, height: size)
    }
}

/// Draws a generated symbol into a square exactly the size of its grid.
///
/// Neither of SwiftUI's own routes does this. `.resizable()` on a symbol scales
/// the *ink* to the frame — a 16pt plus came out 15.5pt wide instead of 12, and
/// every glyph a different size — and sizing by font needs a frozen
/// `Font.system(size:)`, which the type gate rightly refuses for text. So the
/// symbol is asked for at the point size that sets its grid to `box` (the
/// generator sets the grid at 16/14 of the point size) and drawn with its
/// cap-height centre — the grid's centre — on the square's centre. Drawn, not
/// passed through, so no enclosing `font` or `imageScale` can resize it.
@MainActor
enum JunoGlyphBox {
    /// The 256 grid's edge per point of symbol size (`generate-native-icons.mjs`).
    static let gridPerPoint: CGFloat = 16.0 / 14.0

    #if canImport(UIKit)
    private static var cache: [String: UIImage] = [:]
    #elseif canImport(AppKit)
    private static var cache: [String: NSImage] = [:]
    #endif

    static func image(named name: String, box: CGFloat, scale: CGFloat) -> Image {
        #if canImport(UIKit)
        let key = "\(name)@\(box)x\(scale)"
        if let cached = cache[key] { return Image(uiImage: cached) }
        let configuration = UIImage.SymbolConfiguration(pointSize: box / gridPerPoint, weight: .regular)
        guard let symbol = UIImage(named: name, in: .main, with: configuration) else { return Image(name) }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: box, height: box), format: format).image { _ in
            // The alignment rect is the cap-height box, whose centre is the grid's.
            let insets = symbol.alignmentRectInsets
            let midX = insets.left + (symbol.size.width - insets.left - insets.right) / 2
            let midY = insets.top + (symbol.size.height - insets.top - insets.bottom) / 2
            symbol.withTintColor(.black, renderingMode: .alwaysOriginal)
                .draw(at: CGPoint(x: box / 2 - midX, y: box / 2 - midY))
        }
        .withRenderingMode(.alwaysTemplate)
        cache[key] = drawn
        return Image(uiImage: drawn)
        #elseif canImport(AppKit)
        let key = "\(name)@\(box)"
        if let cached = cache[key] { return Image(nsImage: cached) }
        guard let symbol = NSImage(named: name)?
            .withSymbolConfiguration(.init(pointSize: box / gridPerPoint, weight: .regular))
        else { return Image(name) }
        // Vector all the way: the handler runs at whatever scale the image is
        // drawn at. The alignment rect is the cap-height box, whose centre is
        // the grid's.
        let alignment = symbol.alignmentRect
        let natural = symbol.size
        let drawn = NSImage(size: NSSize(width: box, height: box), flipped: false) { rect in
            symbol.draw(in: NSRect(
                x: rect.midX - alignment.midX,
                y: rect.midY - alignment.midY,
                width: natural.width,
                height: natural.height
            ))
            return true
        }
        drawn.isTemplate = true
        cache[key] = drawn
        return Image(nsImage: drawn)
        #else
        return Image(name)
        #endif
    }
}

public extension Image {
    /// A Juno glyph as a symbol, sized by the surrounding font like an SF
    /// Symbol. Pass `.bold` beside text of 13pt and under.
    ///
    /// **Where the system picks the image scale — a sidebar row, a toolbar
    /// item — use ``JunoSymbol`` instead.** See there for why a bare `Image`
    /// draws nothing in those places.
    init(_ icon: JunoIcon, weight: JunoIcon.Weight = .regular) {
        self.init(icon.assetName(weight))
    }
}

/// A Juno glyph as a symbol the surrounding font sizes — for a sidebar row's
/// or a toolbar item's `Label` icon, where the system decides the size.
///
/// **Pinned to the medium image scale, and that is load-bearing.** The
/// generated symbol sets carry a single `Regular-M` master, so the compiled
/// catalog holds renditions for the medium scale only. A `.sidebar` list and
/// the toolbar ask for the *large* scale; CoreUI finds no rendition for it and
/// SwiftUI draws nothing — measured on macOS 27, where every Phosphor and Juno
/// glyph in the sidebar and toolbar came out as an empty slot while the same
/// image rendered correctly everywhere else. AppKit-drawn surfaces (menus, a
/// segmented `Picker`) load the image through `NSImage(named:)`, which ignores
/// the scale, so they are unaffected. When the icon generator emits `S` and
/// `L` masters, this can go back to a bare `Image`.
///
/// The point size still follows the row's font, so the sidebar's icon-size
/// setting still moves the glyph with its label.
public struct JunoSymbol: View {
    private let icon: JunoIcon
    private let weight: JunoIcon.Weight

    public init(_ icon: JunoIcon, weight: JunoIcon.Weight = .regular) {
        self.icon = icon
        self.weight = weight
    }

    public var body: some View {
        Image(icon, weight: weight)
            .imageScale(.medium)
    }
}

public extension Label where Title == Text, Icon == JunoIconView {
    /// `Label("Copy", icon: .copy)` — a label whose mark is one of the
    /// website's, in a fixed box sized for a menu row or a list row.
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

/// A menu row, button or list row labelled with a Juno icon in a fixed box.
///
/// Pairs the text with a ``JunoIconView`` sized for the row. Where the row
/// should size the glyph itself, `Label(_:image:)` with the icon's
/// ``JunoIcon/assetName`` does that: the assets are symbols, so they take the
/// row's font like an SF Symbol.
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
