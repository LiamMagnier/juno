import XCTest
@testable import JunoCodeCore

final class OutputLimiterTests: XCTestCase {
    func testShortOutputPassesThrough() {
        let limit = OutputLimit(maximumBytes: 100)
        let result = OutputLimiter.apply(limit, to: "hello")
        XCTAssertEqual(result.text, "hello")
        XCTAssertFalse(result.wasTruncated)
        XCTAssertEqual(result.originalByteCount, 5)
    }

    func testTruncatesAtByteLimit() {
        let limit = OutputLimit(maximumBytes: 4, truncationNotice: "…")
        let result = OutputLimiter.apply(limit, to: "abcdef")
        XCTAssertEqual(result.text, "abcd…")
        XCTAssertTrue(result.wasTruncated)
        XCTAssertEqual(result.originalByteCount, 6)
    }

    func testNeverSplitsMultibyteCharacters() {
        let limit = OutputLimit(maximumBytes: 5, truncationNotice: "")
        // é is 2 bytes; "ééé" is 6 bytes, so only two fit in 5.
        let result = OutputLimiter.apply(limit, to: "ééé")
        XCTAssertEqual(result.text, "éé")
        XCTAssertTrue(result.wasTruncated)
    }

    func testZeroLimitYieldsNoticeOnly() {
        let limit = OutputLimit(maximumBytes: 0, truncationNotice: "[cut]")
        let result = OutputLimiter.apply(limit, to: "abc")
        XCTAssertEqual(result.text, "[cut]")
        XCTAssertTrue(result.wasTruncated)
    }
}
