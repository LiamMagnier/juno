import SwiftUI
import XCTest
@testable import JunoDesignSystem

final class JunoControlAppearanceTests: XCTestCase {
    func testFocusWinsOverHoverAndUsesTheGeneratedFieldFamily() {
        let idle = JunoFieldAppearance(focused: false, hovered: false, enabled: true, increaseContrast: false)
        let hovered = JunoFieldAppearance(focused: false, hovered: true, enabled: true, increaseContrast: false)
        let focused = JunoFieldAppearance(focused: true, hovered: true, enabled: true, increaseContrast: false)
        XCTAssertEqual(idle.surface, JunoGeneratedColors.fieldSurface)
        XCTAssertEqual(idle.border, JunoGeneratedColors.fieldBorder)
        XCTAssertFalse(idle.showsFocus)
        XCTAssertEqual(hovered.surface, JunoGeneratedColors.fieldSurfaceActive)
        XCTAssertEqual(hovered.border, JunoGeneratedColors.fieldHover)
        XCTAssertEqual(focused.surface, JunoGeneratedColors.fieldSurfaceActive)
        XCTAssertEqual(focused.border, JunoGeneratedColors.fieldFocus)
        XCTAssertTrue(focused.showsFocus)
    }

    func testDisabledFieldsDoNotLookFocusedOrHovered() {
        let disabled = JunoFieldAppearance(focused: true, hovered: true, enabled: false, increaseContrast: false)
        XCTAssertEqual(disabled.surface, JunoGeneratedColors.fieldSurface)
        XCTAssertEqual(disabled.border, JunoGeneratedColors.fieldBorder)
        XCTAssertFalse(disabled.showsFocus)
        XCTAssertEqual(disabled.opacity, 0.5)
    }

    func testIncreasedContrastKeepsAFullEdgeInEveryFieldState() {
        for focused in [false, true] {
            for hovered in [false, true] {
                let appearance = JunoFieldAppearance(focused: focused, hovered: hovered, enabled: true, increaseContrast: true)
                XCTAssertEqual(appearance.border, JunoGeneratedColors.fieldRing)
                XCTAssertEqual(appearance.showsFocus, focused)
                for dark in [false, true] {
                    XCTAssertEqual(appearance.border.resolve(dark: dark, highContrast: true).opacity, 1)
                }
            }
        }
    }

    func testEitherTravelPreferenceRemovesThePressScaleButKeepsTonalFeedback() {
        let ordinary = JunoPressFeedback(pressed: true, enabled: true, reducesTravel: false)
        XCTAssertLessThan(ordinary.scale, 1)
        for preference in [
            JunoAccessibilityPreferences(reduceMotion: true),
            JunoAccessibilityPreferences(prefersCrossFadeTransitions: true),
        ] {
            let reduced = JunoPressFeedback(pressed: true, enabled: true, reducesTravel: preference.reducesTravel)
            XCTAssertEqual(reduced.scale, 1)
            XCTAssertEqual(reduced.opacity, ordinary.opacity)
            XCTAssertLessThan(reduced.opacity, 1)
        }
    }

    func testDisabledAndReleasedControlsNeverKeepAStalePress() {
        for pressed in [false, true] {
            let disabled = JunoPressFeedback(pressed: pressed, enabled: false, reducesTravel: false)
            XCTAssertEqual(disabled.scale, 1)
            XCTAssertEqual(disabled.opacity, 0.5)
        }
        let released = JunoPressFeedback(pressed: false, enabled: true, reducesTravel: false)
        XCTAssertEqual(released.scale, 1)
        XCTAssertEqual(released.opacity, 1)
    }

    func testComposerAndFieldsKeepSharedGeometryWithoutShrinkingTouchTargets() {
        XCTAssertEqual(JunoComposerMetrics.cornerRadius, JunoGeneratedRadius.composer)
        #if os(macOS)
        XCTAssertGreaterThanOrEqual(JunoFieldMetrics.minimumHeight, JunoLayout.pointerTarget)
        #else
        XCTAssertGreaterThanOrEqual(JunoFieldMetrics.minimumHeight, JunoLayout.touchTarget)
        #endif
    }
}
