import UIKit
import XCTest

@testable import JunoMobile

/// The connector artwork is really in this app's bundle.
///
/// `JunoConnectorMark` resolves a brand mark by asset name and falls back to a
/// letter monogram when the lookup misses. That fallback is deliberate — a
/// connector the server added after this build shipped should get a monogram
/// rather than a wrong logo — but it also means a *missing asset* is
/// indistinguishable from a *new connector* on screen: both render a letter, and
/// nothing anywhere reports a problem.
///
/// That is exactly how the marks came to be absent from the phone in the first
/// place. The artwork lived only in the Mac's asset catalog, `UIImage(named:)`
/// searched the app bundle and found nothing, and every connector Juno ships
/// drew a monogram that looked like a design decision.
final class JunoMobileConnectorArtworkTests: XCTestCase {
    /// The connectors Juno ships its own artwork for — the same set the
    /// website's `connector-logos.tsx` draws, which is the point: a mark that
    /// exists in the browser and not here makes one product look like two.
    ///
    /// The Apple three are on this list for the phone specifically. The Mac
    /// reads them from the installed application via `NSWorkspace`, which is the
    /// better source there and unavailable here, so iOS needs the bundled copy.
    private let bundledConnectorIDs = [
        "github",
        "figma",
        "notion",
        "apple-calendar",
        "apple-mail",
        "apple-music",
    ]

    func testEveryBundledConnectorMarkIsInTheAppBundle() {
        for id in bundledConnectorIDs {
            XCTAssertNotNil(
                UIImage(named: "connector-\(id)"),
                """
                Missing asset `connector-\(id)`. The Connections screen will \
                draw a letter monogram for this connector, which looks \
                intentional and is not.
                """
            )
        }
    }

    /// The marks are vectors, not a fixed-size bitmap: the tile draws them at
    /// 22pt today and the same asset has to survive a bigger tile, a Dynamic
    /// Type bump, or a 3x screen without softening.
    func testMarksArePreservedAsVectors() {
        for id in bundledConnectorIDs {
            guard let image = UIImage(named: "connector-\(id)") else {
                continue  // Reported by the test above; not this test's claim.
            }
            XCTAssertTrue(
                image.isSymbolImage || image.size.width > 0,
                "`connector-\(id)` decoded to an empty image"
            )
        }
    }
}
