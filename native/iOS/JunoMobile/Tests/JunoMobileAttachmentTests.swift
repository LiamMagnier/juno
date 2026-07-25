import CoreGraphics
import JunoChatKit
import XCTest
@testable import JunoMobile

/// The attachment surfaces' state and geometry, tested where they are decidable
/// without a screen: which surface is up, where the camera panel's edges land,
/// and which attachment surfaces are reachable.
final class JunoMobileAttachmentCoordinatorTests: XCTestCase {
    @MainActor
    func testOnlyOneSurfaceCanBeUpAtOnce() {
        let coordinator = JunoMobileAttachmentCoordinator()

        coordinator.present(.photos, reduceMotion: true)
        // The second tap of a double tap, or a menu row chosen while the first
        // presentation is still arriving.
        coordinator.present(.camera, reduceMotion: true)

        XCTAssertEqual(coordinator.surface, .photos)
        XCTAssertFalse(coordinator.isShowingCamera)
    }

    @MainActor
    func testDismissingClearsTheSurfaceSoTheSameRowWorksAgain() {
        let coordinator = JunoMobileAttachmentCoordinator()

        coordinator.present(.photos, reduceMotion: true)
        coordinator.dismiss(.photos)
        XCTAssertNil(coordinator.surface)

        coordinator.present(.photos, reduceMotion: true)
        XCTAssertEqual(coordinator.surface, .photos)
    }

    /// The picker binding writes `false` when the system dismisses it. A late
    /// write from a surface that has already been replaced must not close its
    /// successor.
    @MainActor
    func testALateDismissalCannotCloseADifferentSurface() {
        let coordinator = JunoMobileAttachmentCoordinator()

        coordinator.present(.camera, reduceMotion: true)
        coordinator.dismiss(.photos)

        XCTAssertEqual(coordinator.surface, .camera)
    }

    /// Photos is a panel now, so it has no `isPresented` binding to go stale —
    /// only Files does.
    @MainActor
    func testTheFilesBindingRoundTrips() {
        let coordinator = JunoMobileAttachmentCoordinator()

        coordinator.isShowingFiles = true
        XCTAssertEqual(coordinator.surface, .files)

        coordinator.isShowingFiles = false
        XCTAssertNil(coordinator.surface)
    }

    @MainActor
    func testCameraAndPhotosPutTheKeyboardAwayAndFilesDoesNot() {
        XCTAssertTrue(JunoAttachmentSurface.camera.dismissesKeyboard)
        XCTAssertTrue(JunoAttachmentSurface.photos.dismissesKeyboard)
        XCTAssertFalse(JunoAttachmentSurface.files.dismissesKeyboard)
    }

    /// Photos and the camera are both Juno's own floating panels — inset from
    /// three edges, over the composer. Only Files hands off to a system
    /// presentation, and only it needs a two-way `isPresented` flag.
    @MainActor
    func testPhotosAndCameraAreBothFloatingPanels() {
        XCTAssertTrue(JunoAttachmentSurface.camera.isFloatingPanel)
        XCTAssertTrue(JunoAttachmentSurface.photos.isFloatingPanel)
        XCTAssertFalse(JunoAttachmentSurface.files.isFloatingPanel)
    }

    @MainActor
    func testEitherPanelMakesWhatIsUnderneathUnreachable() {
        let coordinator = JunoMobileAttachmentCoordinator()
        XCTAssertFalse(coordinator.isShowingPanel)

        coordinator.present(.photos, reduceMotion: true)
        XCTAssertTrue(coordinator.isShowingPanel)

        coordinator.dismissPanel(.photos, reduceMotion: true)
        coordinator.present(.camera, reduceMotion: true)
        XCTAssertTrue(coordinator.isShowingPanel)

        // Files is a system presentation; it dims and covers on its own.
        coordinator.dismissPanel(.camera, reduceMotion: true)
        coordinator.present(.files, reduceMotion: true)
        XCTAssertFalse(coordinator.isShowingPanel)
    }

    @MainActor
    func testDismissPanelRefusesASurfaceThatIsNotAPanel() {
        let coordinator = JunoMobileAttachmentCoordinator()
        coordinator.present(.files, reduceMotion: true)

        coordinator.dismissPanel(.files, reduceMotion: true)

        XCTAssertEqual(coordinator.surface, .files)
    }

    @MainActor
    func testAnImportFailureIsSurfacedAndClearable() {
        let coordinator = JunoMobileAttachmentCoordinator()
        XCTAssertNil(coordinator.importError)

        coordinator.reportPhotoImportFailure()
        XCTAssertNotNil(coordinator.importError)

        coordinator.clearImportError()
        XCTAssertNil(coordinator.importError)
    }
}

/// The panel's geometry. These are the two things the eye catches immediately
/// and that no amount of careful view code guarantees on its own.
final class JunoFloatingPanelMetricsTests: XCTestCase {
    private func metrics(
        width: CGFloat = 393, height: CGFloat = 852, bottomSafeArea: CGFloat = 34
    ) -> JunoFloatingPanelMetrics {
        JunoFloatingPanelMetrics(
            size: CGSize(width: width, height: height), bottomSafeArea: bottomSafeArea
        )
    }

    func testTheVisibleMarginIsIdenticalOnAllThreeOpenEdges() {
        let panel = metrics()
        let leading = (panel.size.width - panel.width) / 2
        let trailing = leading

        XCTAssertEqual(leading, panel.inset, accuracy: 0.001)
        XCTAssertEqual(trailing, panel.inset, accuracy: 0.001)
        // The bottom margin is the inset by construction — the panel is placed
        // with exactly this padding — so the guard is that no second constant
        // ever creeps in beside it.
        XCTAssertEqual(JunoFloatingPanelMetrics.panelInset, panel.inset)
    }

    func testThePanelStartsBetweenFortyAndFortyTwoPercentDown() {
        for size in [
            CGSize(width: 393, height: 852),   // iPhone 17 Pro
            CGSize(width: 440, height: 956),   // iPhone 17 Pro Max
            CGSize(width: 375, height: 667),   // a small, home-button phone
        ] {
            let panel = JunoFloatingPanelMetrics(size: size, bottomSafeArea: 34)
            XCTAssertGreaterThanOrEqual(panel.resolvedTopFraction, 0.40)
            XCTAssertLessThanOrEqual(panel.resolvedTopFraction, 0.42)
        }
    }

    /// Concentric, not merely rounded: the panel's curve is the display's curve
    /// less the margin between them.
    func testTheCornerIsConcentricWithTheDisplay() {
        let panel = metrics()
        XCTAssertEqual(panel.cornerRadius, panel.displayCornerRadius - panel.inset, accuracy: 0.001)
    }

    func testANestedSurfaceFollowsTheSameRule() {
        let panel = metrics()
        let padding: CGFloat = JunoFloatingPanelMetrics.chromePadding

        XCTAssertEqual(
            panel.nestedCornerRadius(padding: padding),
            panel.cornerRadius - padding,
            accuracy: 0.001
        )
    }

    /// A device with no home indicator gets a smaller display corner — and the
    /// panel must still be sane rather than nearly square.
    func testAHomeButtonDeviceStillGetsAUsableCorner() {
        let panel = metrics(width: 375, height: 667, bottomSafeArea: 0)
        XCTAssertGreaterThanOrEqual(panel.cornerRadius, 18)
        XCTAssertEqual(panel.controlBottomPadding, 18, accuracy: 0.001)
    }

    func testTheControlsClearTheHomeIndicator() {
        let panel = metrics(bottomSafeArea: 34)
        // 34 of safe area, 12 of which the panel's own bottom margin already
        // provides.
        XCTAssertEqual(panel.controlBottomPadding, 34 - 12 + 18, accuracy: 0.001)
    }
}
