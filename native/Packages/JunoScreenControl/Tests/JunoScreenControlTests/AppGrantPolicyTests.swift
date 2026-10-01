import XCTest
@testable import JunoScreenControl

/// Category caps, the refused list, tiers per action, the floor and lapse
/// (CODE_AGENT_SPEC §3.3).
final class AppGrantPolicyTests: XCTestCase {
    private func offer(_ bundleID: String, preferences: ScreenControlPreferences = .default) -> AppGrantOffer {
        AppGrantPolicy.offer(request: bundleID, bundleID: bundleID, displayName: bundleID, preferences: preferences)
    }

    func testCategoryCaps() {
        XCTAssertEqual(offer("com.apple.TextEdit").offeredTier, .full)
        XCTAssertEqual(offer("com.apple.Terminal").offeredTier, .click)
        XCTAssertEqual(offer("com.googlecode.iterm2").offeredTier, .click)
        XCTAssertEqual(offer("com.mitchellh.ghostty").offeredTier, .click)
        XCTAssertEqual(offer("com.apple.dt.Xcode").offeredTier, .click)
        XCTAssertEqual(offer("com.microsoft.VSCode").offeredTier, .click)
        XCTAssertEqual(offer("com.jetbrains.intellij").offeredTier, .click)
        XCTAssertEqual(offer("com.apple.Safari").offeredTier, .view)
        XCTAssertEqual(offer("com.google.Chrome").offeredTier, .view)
        XCTAssertEqual(offer("com.apple.finder").offeredTier, .full)
        XCTAssertEqual(offer("com.apple.systempreferences").offeredTier, .full)
        XCTAssertTrue(offer("com.apple.finder").warnings.contains("Can read or write any file."))
        XCTAssertTrue(offer("com.apple.systempreferences").warnings.contains("Can change system settings. Every change asks first."))
        XCTAssertTrue(offer("com.apple.Terminal").line.hasPrefix("com.apple.Terminal: clicks only — Juno uses its own shell"))
    }

    func testRefusedAppsAreNeverOffered() {
        for id in [
            "com.liammagnier.JunoDesktop", "com.liammagnier.JunoDesktop.debug", "com.liammagnier.JunoCode",
            "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.UserNotificationCenter",
            "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.1password",
            "com.bitwarden.desktop", "com.dashlane.dashlanephonefinal", "com.apple.coreautha",
        ] {
            let offered = offer(id)
            XCTAssertNil(offered.offeredTier, id)
            XCTAssertFalse(offered.include, id)
            guard case .refused = offered.outcome else { return XCTFail(id) }
        }
        guard case let .refused(reason) = offer("com.liammagnier.JunoDesktop").outcome else { return XCTFail() }
        XCTAssertTrue(reason.contains("never controls itself"))
    }

    func testFinanceIsViewOnlyAndDeniedByDefault() {
        guard case .refused = offer("com.robinhood.desktop").outcome else { return XCTFail() }
        let allowed = offer("com.robinhood.desktop", preferences: ScreenControlPreferences(allowedFinance: ["com.robinhood.desktop"]))
        XCTAssertEqual(allowed.offeredTier, .view)
        let byCategory = AppGrantPolicy.offer(
            request: "Bank", bundleID: "com.example.bank", displayName: "Bank",
            appStoreCategory: "public.app-category.finance", preferences: .default
        )
        XCTAssertEqual(byCategory.category, .finance)
    }

    func testTheReaderCanLowerOrDenyButNeverRaise() {
        let lowered = offer("com.apple.TextEdit", preferences: ScreenControlPreferences(loweredTiers: ["com.apple.textedit": .view]))
        XCTAssertEqual(lowered.offeredTier, .view)
        let raised = offer("com.apple.Terminal", preferences: ScreenControlPreferences(loweredTiers: ["com.apple.terminal": .full]))
        XCTAssertEqual(raised.offeredTier, .click, "a cap is never raised")
        guard case .refused = offer("com.apple.TextEdit", preferences: ScreenControlPreferences(denied: ["com.apple.textedit"])).outcome else {
            return XCTFail()
        }
    }

    func testTierEnforcementPerAction() {
        let now = Date()
        let click = AppGrant(bundleID: "com.apple.Terminal", displayName: "Terminal", tier: .click, scope: .session("s"), grantedAt: now)
        let view = AppGrant(bundleID: "com.apple.Safari", displayName: "Safari", tier: .view, scope: .session("s"), grantedAt: now)
        XCTAssertNil(AppGrantPolicy.check(ScreenAction(kind: .leftClick).actionClass, against: click, appName: "Terminal"))
        XCTAssertNil(AppGrantPolicy.check(ScreenAction(kind: .scroll).actionClass, against: click, appName: "Terminal"))
        XCTAssertEqual(
            AppGrantPolicy.check(ScreenAction(kind: .type, text: "rm -rf ~").actionClass, against: click, appName: "Terminal"),
            "Terminal is granted for clicks only; typing, keys, right-click and drags were not sent."
        )
        XCTAssertNotNil(AppGrantPolicy.check(ScreenAction(kind: .key, text: "return").actionClass, against: click, appName: "Terminal"))
        XCTAssertNotNil(AppGrantPolicy.check(ScreenAction(kind: .rightClick).actionClass, against: click, appName: "Terminal"))
        XCTAssertNotNil(AppGrantPolicy.check(ScreenAction(kind: .leftClick, text: "cmd").actionClass, against: click, appName: "Terminal"),
                        "a modifier-click is a shortcut")
        XCTAssertNotNil(AppGrantPolicy.check(ScreenAction(kind: .leftClickDrag).actionClass, against: click, appName: "Terminal"))
        XCTAssertNil(AppGrantPolicy.check(ScreenAction(kind: .screenshot).actionClass, against: view, appName: "Safari"))
        XCTAssertEqual(
            AppGrantPolicy.check(ScreenAction(kind: .leftClick).actionClass, against: view, appName: "Safari"),
            "Safari is granted for viewing only; the action was not sent."
        )
        XCTAssertEqual(
            AppGrantPolicy.check(ScreenAction(kind: .leftClick).actionClass, against: nil, appName: "Notes"),
            "Notes is not granted for this session. Ask the reader to grant it with computer_apps request."
        )
    }

    // MARK: The floor

    func testFloorMatchesEnglishAndFrenchTitles() {
        let click = ScreenAction(kind: .leftClick, coordinate: [1, 1])
        for title in ["Send", "Envoyer", "Supprimer", "Delete…", "Buy Now", "Sign In", "Se connecter", "Place order", "Acheter", "Payer", "J’accepte", "Install", "Confirm"] {
            XCTAssertNotNil(
                ConsequentialActionFloor.evaluate(action: click, category: .other, targetTexts: [title], typedSinceLastCommit: false),
                title
            )
        }
        for title in ["Sender", "Postpone", "Save", "Ordinateur", "Format", "Cancel", "Annuler", "Bold"] {
            XCTAssertNil(
                ConsequentialActionFloor.evaluate(action: click, category: .other, targetTexts: [title], typedSinceLastCommit: false),
                title
            )
        }
    }

    func testReturnAfterTypingInAMessagingAppAlwaysAsks() {
        let enter = ScreenAction(kind: .key, text: "Return")
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: enter, category: .messaging, targetTexts: [], typedSinceLastCommit: true),
            .sendsMessage
        )
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .key, text: "cmd+Return"), category: .messaging, targetTexts: [], typedSinceLastCommit: true),
            .sendsMessage
        )
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: enter, category: .messaging, targetTexts: [], typedSinceLastCommit: false))
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: enter, category: .other, targetTexts: [], typedSinceLastCommit: true))
        // Return presses the window's default button: its title counts.
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: enter, category: .other, targetTexts: ["Delete"], typedSinceLastCommit: false),
            .consequentialControl("delete")
        )
    }

    func testALineBreakTypedIsAReturn() {
        let typed = ScreenAction(kind: .type, text: "On my way\n")
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: typed, category: .messaging, targetTexts: [], typedSinceLastCommit: false),
            .sendsMessage,
            "typing a line break in a messaging app sends"
        )
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .type, text: "ok\r\n"), category: .other, targetTexts: ["Supprimer"], typedSinceLastCommit: false),
            .consequentialControl("supprimer"),
            "and presses a dialog's default button anywhere"
        )
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .type, text: "line one\nline two"), category: .other, targetTexts: [], typedSinceLastCommit: false))
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .type, text: "no break"), category: .messaging, targetTexts: [], typedSinceLastCommit: false))
    }

    func testHeldReturnSpaceOnAButtonAndCommandDeleteAsk() {
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .holdKey, text: "return", duration: 1), category: .messaging, targetTexts: [], typedSinceLastCommit: true),
            .sendsMessage,
            "holding Return is pressing it"
        )
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .key, text: "space"), category: .other, targetTexts: ["Send"], typedSinceLastCommit: false),
            .consequentialControl("send"),
            "space presses the focused button"
        )
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .key, text: "space"), category: .other, targetTexts: ["Bold"], typedSinceLastCommit: false))
        for chord in ["cmd+delete", "cmd+backspace", "cmd+shift+delete", "cmd+option+forward_delete"] {
            XCTAssertEqual(
                ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .key, text: chord), category: .systemReach, targetTexts: [], typedSinceLastCommit: false),
                .consequentialControl("delete"),
                chord
            )
        }
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .key, text: "delete"), category: .other, targetTexts: [], typedSinceLastCommit: false), "a plain backspace edits text")
    }

    func testAKeyInsideASentenceStillReadsAsACredential() {
        let line = ScreenAction(kind: .type, text: "Here is the key: sk-live-4f9a8b7c6d5e4f3a2b1c")
        XCTAssertEqual(
            ConsequentialActionFloor.evaluate(action: line, category: .messaging, targetTexts: [], typedSinceLastCommit: false),
            .credentialText
        )
        XCTAssertNil(ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .type, text: "Cuisine asiatique et akira"), category: .other, targetTexts: [], typedSinceLastCommit: false))
    }

    func testEveryChangeInSystemSettingsAsks() {
        for action in [
            ScreenAction(kind: .leftClick, coordinate: [1, 1]),
            ScreenAction(kind: .type, text: "a"),
            ScreenAction(kind: .key, text: "space"),
            ScreenAction(kind: .leftClickDrag, coordinate: [2, 2], startCoordinate: [1, 1]),
        ] {
            XCTAssertEqual(
                ConsequentialActionFloor.evaluate(action: action, category: .systemReach, targetTexts: ["Terminal"], typedSinceLastCommit: false, bundleID: "com.apple.systempreferences"),
                .systemSettings,
                "\(action.kind)"
            )
        }
        for action in [ScreenAction(kind: .scroll, coordinate: [1, 1], scrollDirection: .down), ScreenAction(kind: .screenshot)] {
            XCTAssertNil(
                ConsequentialActionFloor.evaluate(action: action, category: .systemReach, targetTexts: [], typedSinceLastCommit: false, bundleID: "com.apple.systempreferences"),
                "\(action.kind) changes nothing"
            )
        }
        XCTAssertNil(
            ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .leftClick, coordinate: [1, 1]), category: .systemReach, targetTexts: ["Documents"], typedSinceLastCommit: false, bundleID: "com.apple.finder"),
            "Finder clicks follow the ordinary rules"
        )
    }

    func testClipboardControlsAreRecognisedInTheOwnersLanguages() {
        XCTAssertEqual(ClipboardControls.use(of: ["Paste and Match Style"]), .read)
        XCTAssertEqual(ClipboardControls.use(of: ["Coller"]), .read)
        XCTAssertEqual(ClipboardControls.use(of: ["Einfügen"]), .read)
        XCTAssertEqual(ClipboardControls.use(of: ["Copy Link"]), .write)
        XCTAssertEqual(ClipboardControls.use(of: ["Couper"]), .write)
        XCTAssertNil(ClipboardControls.use(of: ["Copyright", "Pasted Items", "Cutting Board"]))
    }

    func testCredentialLikeTextAlwaysAsks() {
        for secret in ["sk-ant-api03-abcdefghijklmnop", "ghp_0123456789abcdefABCDEF0123456789", "AKIAIOSFODNN7EXAMPLE", "Tr0ub4dor&3xyzQWERTY77"] {
            XCTAssertEqual(
                ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .type, text: secret), category: .other, targetTexts: [], typedSinceLastCommit: false),
                .credentialText,
                secret
            )
        }
        for plain in ["Hello world", "Fix the export sheet", "https://example.com/a/b/c/d", "notes.txt"] {
            XCTAssertNil(
                ConsequentialActionFloor.evaluate(action: ScreenAction(kind: .type, text: plain), category: .other, targetTexts: [], typedSinceLastCommit: false),
                plain
            )
        }
    }

    func testAlwaysAllowIsScopedToBundleAndActionClassAndNeverOfferedForTheFloor() {
        let rule = ScreenInputRule.suggestion(
            bundleID: "com.apple.TextEdit", category: .other, actionClass: .click,
            floor: nil, targetIsSecure: false, persistentRulesEnabled: true
        )
        XCTAssertEqual(rule?.description, "ScreenInput(com.apple.TextEdit:click)")
        XCTAssertNil(ScreenInputRule.suggestion(
            bundleID: "com.apple.TextEdit", category: .other, actionClass: .click,
            floor: .consequentialControl("send"), targetIsSecure: false, persistentRulesEnabled: true
        ))
        XCTAssertNil(ScreenInputRule.suggestion(
            bundleID: "com.apple.TextEdit", category: .other, actionClass: .full,
            floor: nil, targetIsSecure: true, persistentRulesEnabled: true
        ))
        XCTAssertNil(ScreenInputRule.suggestion(
            bundleID: "com.apple.SecurityAgent", category: .refused, actionClass: .click,
            floor: nil, targetIsSecure: false, persistentRulesEnabled: true
        ))
        // D-021: per app, per session, no persistent Always allow this pass.
        XCTAssertFalse(ScreenInputRule.persistentRulesEnabled)
        XCTAssertNil(ScreenInputRule.suggestion(
            bundleID: "com.apple.TextEdit", category: .other, actionClass: .click, floor: nil, targetIsSecure: false
        ))
    }

    func testGrantsLapseAfterThirtyIdleMinutes() {
        var book = AppGrantBook()
        let start = Date(timeIntervalSince1970: 0)
        book.add(AppGrant(bundleID: "com.apple.TextEdit", displayName: "TextEdit", tier: .full, scope: .session("s"), grantedAt: start))
        XCTAssertNotNil(book.grant(for: "com.apple.textedit", now: start.addingTimeInterval(29 * 60)))
        book.touch(now: start.addingTimeInterval(29 * 60))
        XCTAssertNotNil(book.grant(for: "com.apple.TextEdit", now: start.addingTimeInterval(58 * 60)), "use restarts the clock")
        XCTAssertNil(book.grant(for: "com.apple.TextEdit", now: start.addingTimeInterval(60 * 60)), "30 idle minutes")
        XCTAssertTrue(book.isEmpty)
    }

    func testSecureElementsAreSecureWhateverTheirValue() {
        let field = AXElementInfo(id: "e1", role: "AXTextField", subrole: "AXSecureTextField", value: "hunter2", frame: ScreenRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertTrue(field.isSecure)
        XCTAssertNil(field.value, "a secure field's value is never kept")
    }
}
