import XCTest
@testable import JunoCore

/// Quick Entry's global shortcut: what it may be, and that changing it can
/// never leave the reader without one (A11).
final class JunoGlobalHotkeyTests: XCTestCase {

    /// Records what the system was asked to do, and refuses what it is told to.
    private final class FakeRegistrar: JunoHotkeyRegistrar {
        var refused: Set<JunoHotkey> = []
        private(set) var registered: [Int: JunoHotkey] = [:]
        private var next = 0

        func register(_ hotkey: JunoHotkey) -> Int? {
            guard !refused.contains(hotkey) else { return nil }
            next += 1
            registered[next] = hotkey
            return next
        }

        func unregister(_ registration: Int) {
            registered[registration] = nil
        }

        var live: [JunoHotkey] { Array(registered.values) }
    }

    private let optionSpace = JunoHotkey.quickEntryDefault
    private let controlOptionK = JunoHotkey(keyCode: 40, modifiers: [.control, .option])

    // MARK: Model

    func testDefaultIsOptionSpace() {
        XCTAssertEqual(optionSpace.keys, ["⌥", "Space"])
        XCTAssertEqual(optionSpace.display, "⌥Space")
        XCTAssertNil(optionSpace.problem())
    }

    func testKeysAreInTheMacsModifierOrder() {
        let chord = JunoHotkey(keyCode: 35, modifiers: [.command, .shift, .option, .control])
        XCTAssertEqual(chord.keys, ["⌃", "⌥", "⇧", "⌘", "P"])
    }

    func testStorageRoundTripsAndRejectsGarbage() {
        XCTAssertEqual(JunoHotkey(storageValue: controlOptionK.storageValue), controlOptionK)
        XCTAssertNil(JunoHotkey(storageValue: ""))
        XCTAssertNil(JunoHotkey(storageValue: "49"))
        XCTAssertNil(JunoHotkey(storageValue: "49:x"))
        XCTAssertNil(JunoHotkey(storageValue: "49:255"))
    }

    func testCharacterKeyCodes() {
        XCTAssertEqual(JunoHotkey.keyCode(forCharacter: "p"), 35)
        XCTAssertEqual(JunoHotkey.keyCode(forCharacter: "K"), 40)
        XCTAssertEqual(JunoHotkey.keyCode(forCharacter: " "), JunoHotkey.KeyCode.space)
        XCTAssertNil(JunoHotkey.keyCode(forCharacter: "é"))
    }

    // MARK: Validation

    func testSystemShortcutsAreRefusedByName() {
        let spotlight = JunoHotkey(keyCode: 49, modifiers: [.command])
        XCTAssertEqual(spotlight.problem(), .reservedBySystem("Spotlight"))
        let inputSource = JunoHotkey(keyCode: 49, modifiers: [.control])
        XCTAssertEqual(inputSource.problem(), .reservedBySystem("switching input sources"))
        let screenshot = JunoHotkey(keyCode: 21, modifiers: [.shift, .command])
        XCTAssertEqual(screenshot.problem(), .reservedBySystem("screenshots"))
    }

    func testCommandOnlyChordsAreRefused() {
        XCTAssertEqual(JunoHotkey(keyCode: 45, modifiers: [.command]).problem(), .needsControlOrOption)
        XCTAssertEqual(JunoHotkey(keyCode: 45, modifiers: [.command, .shift]).problem(), .needsControlOrOption)
        XCTAssertEqual(JunoHotkey(keyCode: 45, modifiers: []).problem(), .needsControlOrOption)
    }

    func testOptionWithALetterTypesACharacter() {
        XCTAssertEqual(JunoHotkey(keyCode: 14, modifiers: [.option]).problem(), .typesCharacter)
        XCTAssertEqual(JunoHotkey(keyCode: 14, modifiers: [.option, .shift]).problem(), .typesCharacter)
        XCTAssertNil(JunoHotkey(keyCode: 14, modifiers: [.option, .command]).problem())
    }

    func testFunctionKeysNeedNoModifier() {
        XCTAssertNil(JunoHotkey(keyCode: 96, modifiers: []).problem())
        XCTAssertEqual(JunoHotkey(keyCode: 96, modifiers: []).display, "F5")
    }

    func testUnknownKeysAreRefused() {
        XCTAssertEqual(JunoHotkey(keyCode: 200, modifiers: [.control]).problem(), .unknownKey)
    }

    func testAppChordsAreRefusedByName() {
        let preview = JunoHotkey(keyCode: 35, modifiers: [.option, .command])
        XCTAssertEqual(preview.problem(appChords: [preview: "Preview"]), .usedByApp("Preview"))
    }

    // MARK: Binding (A11)

    func testBindRegistersTheShortcut() {
        let registrar = FakeRegistrar()
        let binder = JunoHotkeyBinder(registrar: registrar)
        XCTAssertNil(binder.bind(optionSpace))
        XCTAssertEqual(binder.active, optionSpace)
        XCTAssertEqual(registrar.live, [optionSpace])
    }

    func testRebindReplacesTheOldShortcut() {
        let registrar = FakeRegistrar()
        let binder = JunoHotkeyBinder(registrar: registrar)
        binder.bind(optionSpace)
        XCTAssertNil(binder.bind(controlOptionK))
        XCTAssertEqual(binder.active, controlOptionK)
        XCTAssertEqual(registrar.live, [controlOptionK])
    }

    func testAShortcutTheSystemRefusesKeepsTheOldOneActive() {
        let registrar = FakeRegistrar()
        registrar.refused = [controlOptionK]
        let binder = JunoHotkeyBinder(registrar: registrar)
        binder.bind(optionSpace)
        XCTAssertEqual(binder.bind(controlOptionK), .unavailable)
        XCTAssertEqual(binder.active, optionSpace)
        XCTAssertEqual(registrar.live, [optionSpace])
    }

    func testAnInvalidShortcutIsNeverRegisteredAndKeepsTheOldOne() {
        let registrar = FakeRegistrar()
        let preview = JunoHotkey(keyCode: 35, modifiers: [.option, .command])
        let binder = JunoHotkeyBinder(registrar: registrar, appChords: [preview: "Preview"])
        binder.bind(optionSpace)
        XCTAssertEqual(binder.bind(JunoHotkey(keyCode: 49, modifiers: [.command])), .reservedBySystem("Spotlight"))
        XCTAssertEqual(binder.bind(preview), .usedByApp("Preview"))
        XCTAssertEqual(binder.active, optionSpace)
        XCTAssertEqual(registrar.live, [optionSpace])
    }

    func testBindingTheSameShortcutAgainIsANoOp() {
        let registrar = FakeRegistrar()
        let binder = JunoHotkeyBinder(registrar: registrar)
        binder.bind(optionSpace)
        XCTAssertNil(binder.bind(optionSpace))
        XCTAssertEqual(registrar.live.count, 1)
    }

    func testUnbindReleasesTheShortcut() {
        let registrar = FakeRegistrar()
        let binder = JunoHotkeyBinder(registrar: registrar)
        binder.bind(optionSpace)
        binder.unbind()
        XCTAssertNil(binder.active)
        XCTAssertTrue(registrar.live.isEmpty)
    }
}
