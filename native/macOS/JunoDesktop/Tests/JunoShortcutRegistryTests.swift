import AppKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// The one table the menu bar and the Keyboard Shortcuts window are both built
/// from (Phase 3 brief A1). Menus cannot be photographed, so what they hold is
/// pinned here: one chord per place, no system chord taken, the words in the
/// right case, a glyph on every item, and the window listing exactly the
/// registry.
struct JunoShortcutRegistryTests {
    private let registry = JunoShortcutRegistry.entries

    /// A chord as AppKit matches it.
    private struct Chord: Hashable, CustomStringConvertible {
        let key: String
        let modifiers: Int

        init(_ key: KeyEquivalent, _ modifiers: EventModifiers) {
            self.key = String(key.character).lowercased()
            self.modifiers = modifiers.rawValue
        }

        var description: String { "\(EventModifiers(rawValue: modifiers)) \(key.debugDescription)" }
    }

    private func chord(_ entry: JunoShortcut) -> Chord? {
        entry.key.map { Chord($0, entry.modifiers) }
    }

    // MARK: 0. Every id, once

    @Test
    func everyIDHasExactlyOneEntry() {
        for id in JunoShortcutID.allCases {
            #expect(registry.filter { $0.id == id }.count == 1, "\(id)")
        }
        #expect(registry.count == JunoShortcutID.allCases.count)
    }

    // MARK: 1. No chord bound twice where both could answer

    @Test
    func noChordIsBoundTwiceWithinOverlappingContexts() {
        let bound = registry.filter { $0.binding != .field && $0.key != nil }
        for (index, first) in bound.enumerated() {
            for second in bound[(index + 1)...] where chord(first) == chord(second) {
                #expect(
                    !first.context.overlaps(second.context),
                    "\(first.id) and \(second.id) share \(chord(first)!) in overlapping contexts"
                )
            }
        }
    }

    /// Menu shortcuts fire before the focused control, so a key a field answers
    /// must never also be a menu item's chord where both are live.
    @Test
    func noFieldKeyIsAlsoAMenuChord() {
        let menuChords = registry.filter { $0.binding != .field && $0.key != nil }
        for field in registry where field.binding == .field {
            for menu in menuChords where menu.keys == field.keys {
                #expect(!menu.context.overlaps(field.context), "\(field.id) is \(menu.id)'s chord")
            }
        }
    }

    /// Chat's ⌘. and Code's ⌘. are the one shared chord, and they live in
    /// contexts that never overlap.
    @Test
    func chatAndCodeStopShareOnlyAcrossProducts() {
        let chat = JunoShortcutRegistry.entry(.stopGenerating)
        let code = JunoShortcutRegistry.entry(.codeStop)
        #expect(chord(chat) == chord(code))
        #expect(chat.context == .chat)
        #expect(code.context == .code)
        #expect(!chat.context.overlaps(code.context))
    }

    // MARK: 2. No system chord

    @Test
    func noEntryTakesASystemChord() {
        let reserved: [Chord] = [
            Chord("q", [.command]), Chord("w", [.command]), Chord("h", [.command]),
            Chord("h", [.command, .option]), Chord("m", [.command]), Chord("`", [.command]),
            Chord(.tab, [.command]), Chord(.space, [.command]), Chord("f", [.command, .control]),
            Chord("c", [.command]), Chord("v", [.command]), Chord("x", [.command]),
            Chord("a", [.command]), Chord("z", [.command]), Chord("z", [.command, .shift]),
            // Show Spelling and Grammar and Check Document Now, were they ever added.
            Chord(":", [.command]), Chord(";", [.command]),
            // Show/Hide Toolbar (`ToolbarCommands`), and Save As.
            Chord("t", [.command, .option]), Chord("s", [.command, .shift]),
        ]
        for entry in registry where entry.binding != .system {
            guard let chord = chord(entry) else { continue }
            #expect(!reserved.contains(chord), "\(entry.id) takes the system's \(chord)")
        }
    }

    // MARK: 3. Title Case in menus

    private static let smallWords: Set<String> = [
        "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor",
        "of", "on", "or", "the", "to", "with",
    ]

    static func isTitleCase(_ title: String) -> Bool {
        let words = title.replacingOccurrences(of: "…", with: "").split(separator: " ").map(String.init)
        guard !words.isEmpty else { return false }
        for (index, word) in words.enumerated() {
            if word == "&" { continue }
            let isInner = index > 0 && index < words.count - 1
            if isInner, smallWords.contains(word) { continue }
            guard let first = word.first, first.isUppercase else { return false }
        }
        return true
    }

    @Test
    func everyMenuTitleIsTitleCase() {
        var titles = registry.compactMap(\.menuTitle)
        // The titles the moment gives an item: ⌘N in Code and with nothing
        // focused, and the theme item in the dark.
        titles += ["New Task", JunoDesktopWindow.newWindowMenuTitle, "Switch to Light Mode"]
        titles += DesktopConversationMenu.rows(pinned: false, renameTitle: "Rename…", showsOpenProject: true)
            .map(\.title)
        titles += DesktopConversationMenu.rows(pinned: true).map(\.title)
        for title in titles {
            #expect(Self.isTitleCase(title), "\"\(title)\" is not Title Case")
        }
        #expect(!Self.isTitleCase("Switch To dark mode"))
    }

    @Test
    func menuTitlesThatAskForMoreEndInAnEllipsis() {
        let asking: [JunoShortcutID] = [
            .commandMenu, .search, .askJuno, .attachFiles, .attachScreenshot, .findInConversation,
            .codeOpenFolder, .codeOpenFile, .codeCreatePullRequest,
        ]
        for id in asking {
            #expect(JunoShortcutRegistry.entry(id).menuTitle?.hasSuffix("…") == true, "\(id)")
        }
        for entry in registry where !asking.contains(entry.id) {
            #expect(entry.menuTitle?.hasSuffix("…") != true, "\(entry.id) should not ask for more")
        }
    }

    // MARK: 4. Sentence case in the list, the web's words where it lists them

    static func isSentenceCase(_ label: String) -> Bool {
        let words = label.split(separator: " ").map(String.init)
        guard let first = words.first?.first, first.isUppercase else { return false }
        for word in words.dropFirst() {
            guard let initial = word.first, initial.isLetter else { continue }
            if initial.isUppercase, word != "Juno" { return false }
        }
        return true
    }

    @Test
    func everyListLabelIsSentenceCase() {
        for label in registry.compactMap(\.listLabel) {
            #expect(Self.isSentenceCase(label), "\"\(label)\" is not sentence case")
        }
        #expect(!Self.isSentenceCase("Copy the Last Response"))
    }

    /// `shortcutGroups` in the web's `command-palette.tsx`, byte for byte,
    /// under the group the web puts each in.
    private static let webLabels: [JunoShortcutGroup: [String]] = [
        .everywhere: [
            "Command menu", "New chat", "Toggle sidebar", "Toggle theme", "Settings", "Keyboard shortcuts",
        ],
        .products: ["Chat", "Code"],
        .composer: [
            "Send message", "New line", "Attach files", "Edit your last message (empty field)",
            "Focus the composer", "Stop generating \u{00B7} close a menu",
        ],
        .responses: ["Copy the last response", "Copy the last code block", "Find in conversation"],
    ]

    @Test
    func theRowsTheWebListsCarryTheWebsWords() {
        for (group, labels) in Self.webLabels {
            let listed = JunoShortcutRegistry.groups.first { $0.group == group }?.rows.map(\.label) ?? []
            for label in labels {
                #expect(listed.contains(label), "\(group.title) is missing the web's \"\(label)\"")
            }
        }
        // The web's `/` Commands and `@` Tools and connectors wait for the
        // composer's palette (§7 of the Phase 3 brief).
        let composer = JunoShortcutRegistry.groups.first { $0.group == .composer }?.rows.map(\.label) ?? []
        #expect(!composer.contains("Commands"))
        #expect(!composer.contains("Tools and connectors"))
    }

    @Test
    func theWebsChordsAreTheMacsWhereTheyAgree() {
        #expect(JunoShortcutRegistry.entry(.copyLastResponse).keys == ["⇧", "⌘", "C"])
        #expect(JunoShortcutRegistry.entry(.copyLastCodeBlock).keys == ["⇧", "⌘", ";"])
        #expect(JunoShortcutRegistry.entry(.toggleTheme).keys == ["⇧", "⌘", "L"])
        #expect(JunoShortcutRegistry.entry(.newChatAlias).keys == ["⇧", "⌘", "O"])
        #expect(JunoShortcutRegistry.entry(.focusComposer).keys == ["⇧", "esc"])
        #expect(JunoShortcutRegistry.entry(.search).keys == ["⇧", "⌘", "F"])
        #expect(JunoShortcutRegistry.entry(.toggleSidebar).keys == ["⌃", "⌘", "S"])
        #expect(JunoShortcutRegistry.entry(.codeOpenFile).keys == ["⌥", "⇧", "⌘", "O"])
    }

    // MARK: 5. A glyph on every menu item

    @Test
    func everyMenuEntryHasAGlyph() {
        for entry in registry where entry.menu != nil {
            #expect(entry.glyph != nil, "\(entry.id) has no glyph")
        }
        for row in DesktopConversationMenu.rows(pinned: false, showsOpenProject: true) {
            #expect(!row.glyph.assetName.isEmpty)
        }
    }

    @Test
    func theConversationMenuWearsTheWebsGlyphsInItsOrder() {
        let rows = DesktopConversationMenu.rows(pinned: false, renameTitle: "Rename…", showsOpenProject: true)
        #expect(rows.map(\.title) == [
            "Rename…", "Pin", "Add to Project", "New Project…", "Open Project", "Share…", "Archive", "Delete…",
        ])
        #expect(rows.map(\.glyph.symbolName) == [
            "ph.pencilsimple", "ph.pushpin", "ph.folder", "ph.plus", "ph.folderopen",
            "ph.sharenetwork", "ph.archive", "ph.trash",
        ])
        #expect(rows.last?.isDestructive == true)
        #expect(rows.filter(\.isDestructive).count == 1)
        let pinned = DesktopConversationMenu.rows(pinned: true)
        #expect(pinned.first { $0.kind == .pin }?.title == "Unpin")
        #expect(pinned.first { $0.kind == .pin }?.glyph.symbolName == "ph.pushpinslash")
        #expect(!pinned.contains { $0.kind == .openProject })
    }

    // MARK: 6. The Shortcuts window is the registry

    @Test
    func theShortcutsWindowListsExactlyTheRegistry() {
        let window = DesktopShortcutsWindow()
        #expect(window.groups.map(\.group) == JunoShortcutRegistry.groups.map(\.group))
        #expect(window.groups.map(\.group) == JunoShortcutGroup.allCases)
        let listedIDs = window.groups.flatMap(\.rows).flatMap(\.ids)
        let registryIDs = registry.filter { $0.group != nil && $0.listLabel != nil }.map(\.id)
        #expect(Set(listedIDs) == Set(registryIDs))
        #expect(listedIDs.count == registryIDs.count)
        // Rows only merge when two chords do one thing.
        let newChat = window.groups.flatMap(\.rows).first { $0.label == "New chat" }
        #expect(newChat?.chords == [["⌘", "N"], ["⇧", "⌘", "O"]])
        for row in window.groups.flatMap(\.rows) {
            #expect(!row.chords.isEmpty)
            #expect(row.chords.allSatisfy { !$0.isEmpty })
        }
    }

    @Test
    func eachKeyIsItsOwnCap() {
        for entry in registry where entry.group != nil {
            for key in entry.keys {
                #expect(["Space", "esc"].contains(key) || key.count == 1, "\(entry.id) has a cap \"\(key)\"")
            }
        }
    }

    @Test
    func rowsAreReadAsKeysNotCodes() {
        let search = JunoShortcutRegistry.groups.flatMap(\.rows).first { $0.label == "Search" }
        #expect(search?.accessibilityLabel == "Search, Shift Command F")
        let newChat = JunoShortcutRegistry.groups.flatMap(\.rows).first { $0.label == "New chat" }
        #expect(newChat?.accessibilityLabel == "New chat, Command N, or Shift Command O")
    }

    @Test
    func theColumnsBalanceWithoutSplittingAGroup() {
        let layout = DesktopShortcutsLayout(groups: JunoShortcutRegistry.groups)
        #expect((layout.leading + layout.trailing).map(\.group) == JunoShortcutGroup.allCases)
        let leading = DesktopShortcutsLayout.columnHeight(layout.leading)
        let trailing = DesktopShortcutsLayout.columnHeight(layout.trailing)
        // No other split is shorter.
        let groups = JunoShortcutRegistry.groups
        for split in 0...groups.count {
            let tallest = max(
                DesktopShortcutsLayout.columnHeight(Array(groups[..<split])),
                DesktopShortcutsLayout.columnHeight(Array(groups[split...]))
            )
            #expect(max(leading, trailing) <= tallest)
        }
        #expect(DesktopShortcutsLayout.columnWidth == 280)
        #expect(layout.height == max(leading, trailing) + 48)
    }

    // MARK: Products

    @Test
    func theProductChordsAreTheSwitchsDigits() {
        #expect(
            JunoShortcutRegistry.entry(.productChat).keyboardShortcut == DesktopProductMode.chat.keyboardShortcut
        )
        #expect(
            JunoShortcutRegistry.entry(.productCode).keyboardShortcut == DesktopProductMode.code.keyboardShortcut
        )
    }

    @Test
    func menusAreGeneratedInTheirOrder() {
        func titles(_ menu: JunoShortcutMenu) -> [[String]] {
            JunoShortcutRegistry.sections(in: menu).map { $0.compactMap(\.menuTitle) }
        }
        #expect(titles(.file) == [
            ["New Chat", "New Incognito Chat"], ["New Chat"], ["Open Folder…"], ["Ask Juno…"],
        ])
        #expect(titles(.edit) == [["Find in Conversation…", "Find Next", "Find Previous"]])
        #expect(titles(.view) == [
            ["Chat", "Code"], ["Command Menu…", "Search…"], ["Switch to Dark Mode"],
            // The Chat window's pages (integration): the sidebar's four, then More's three.
            ["Library", "Projects", "Artifacts", "Orbit"], ["Assistants", "Skills", "Routines"],
        ])
        #expect(titles(.chat) == [
            ["Attach Files…", "Attach Screenshot…"],
            ["Focus Composer", "Stop Generating", "Regenerate"],
            ["Copy Last Response", "Copy Last Code Block"],
        ])
        #expect(titles(.session) == [
            ["Stop"], ["Previous Session", "Next Session"],
            ["Changes", "Terminal", "Toggle Side Panel", "Toggle Preview", "Open File…"],
            ["Create Pull Request…"],
        ])
        #expect(titles(.help) == [["Juno Help", "Keyboard Shortcuts", "Roadmap & Feature Requests"]])
        // The Session menu lost its ⌘K row: ⌘K is View › Command Menu….
        let commandK = registry.filter { $0.keys == ["⌘", "K"] }
        #expect(commandK.map(\.id) == [.commandMenu])
    }
}

// MARK: - The built menu bar

/// The menu bar the app actually builds, read from `NSApp.mainMenu` inside the
/// test host (where no window is focused, so Chat stands, not Session).
///
/// AppKit localizes key equivalents to the reader's keyboard layout
/// (`allowsAutomaticKeyEquivalentLocalization`): on a French layout ⌘1 is
/// drawn and matched as ⌘&, ⌘/ as ⌘: and ⇧⌘; as ⇧⌘). So these tests hold on
/// every layout: they read titles and modifiers, and prove the chords unique
/// in whatever form the layout gave them, rather than pinning US characters.
@MainActor
struct DesktopMenuBarTests {
    private func items(_ menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { item in [item] + (item.submenu.map(items) ?? []) }
    }

    private func mainMenuItems() throws -> [NSMenuItem] {
        let menu = try #require(NSApp.mainMenu, "The test host has no main menu to read.")
        return items(menu)
    }

    private static func mask(_ modifiers: EventModifiers) -> NSEvent.ModifierFlags {
        var mask: NSEvent.ModifierFlags = []
        if modifiers.contains(.command) { mask.insert(.command) }
        if modifiers.contains(.shift) { mask.insert(.shift) }
        if modifiers.contains(.option) { mask.insert(.option) }
        if modifiers.contains(.control) { mask.insert(.control) }
        return mask
    }

    private static func chordMask(_ item: NSMenuItem) -> NSEvent.ModifierFlags {
        item.keyEquivalentModifierMask.intersection([.command, .shift, .option, .control, .function])
    }

    /// ⇧⌘; is ⌘: on a US layout — AppKit's Show Spelling and Grammar. The app
    /// adds no `TextEditingCommands`, so no spelling item exists, and no item
    /// in the menu bar shares Copy Last Code Block's press in any layout.
    @Test
    func shiftCommandSemicolonIsCopyLastCodeBlocksAlone() throws {
        let all = try mainMenuItems()
        for word in ["Spelling", "Check Document Now", "Substitutions"] {
            #expect(!all.contains { $0.title.localizedCaseInsensitiveContains(word) }, "\(word)")
        }
        let codeBlock = try #require(all.first { $0.title == "Copy Last Code Block" })
        #expect(Self.chordMask(codeBlock) == [.command, .shift])
        let press = (codeBlock.keyEquivalent.lowercased(), Self.chordMask(codeBlock).rawValue)
        let sharing = all.filter {
            $0 !== codeBlock && ($0.keyEquivalent.lowercased(), Self.chordMask($0).rawValue) == press
        }
        #expect(sharing.isEmpty, "\(sharing.map(\.title)) share Copy Last Code Block's press")
    }

    /// No two items in the built menu bar answer the same press.
    @Test
    func noTwoMenuItemsShareAPress() throws {
        let chords = try mainMenuItems()
            .filter { !$0.keyEquivalent.isEmpty }
            .map { (title: $0.title, press: "\($0.keyEquivalent.lowercased()) \(Self.chordMask($0).rawValue)") }
        var seen: [String: String] = [:]
        for chord in chords {
            if let other = seen[chord.press] {
                Issue.record("\(other) and \(chord.title) share a press")
            }
            seen[chord.press] = chord.title
        }
    }

    /// Every item the registry places outside Session is in the built menu
    /// bar, under the words the context gives it, on its modifiers.
    @Test
    func theMenuBarIsTheRegistry() throws {
        let all = try mainMenuItems()
        let context = DesktopCommandContext()
        for entry in JunoShortcutRegistry.entries {
            guard let menu = entry.menu, menu != .session else { continue }
            let title = context.title(for: entry)
            let matches = all.filter { $0.title == title }
            #expect(!matches.isEmpty, "\(entry.id): no \"\(title)\" in the menu bar")
            guard entry.key != nil else { continue }
            #expect(
                matches.contains { Self.chordMask($0) == Self.mask(entry.modifiers) && !$0.keyEquivalent.isEmpty },
                "\(entry.id): \"\(title)\" is not on its chord"
            )
        }
        #expect(!all.contains { $0.title == "Command Palette…" })
        #expect(!all.contains { $0.title == "Find in Juno…" })
    }
}
