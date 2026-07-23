import Foundation
import XCTest

@testable import JunoAuth

/// Guards the fix for "my profile photo never shows".
///
/// Juno stores an uploaded avatar as a relative path so one value serves both
/// local disk and S3. A browser resolves that against its own origin; a native
/// client does not, and the resulting hostless URL decodes cleanly, is non-nil,
/// and can never load — which looks exactly like an account with no photo.
final class NativeAvatarURLTests: XCTestCase {
    private let base = URL(string: "https://chat.liams.dev")!

    func testRelativeUploadPathResolvesAgainstTheBackendOrigin() {
        let resolved = NativeAccountProfile.resolveImageURL("/api/files/u123/avatar.jpg", relativeTo: base)
        XCTAssertEqual(resolved?.absoluteString, "https://chat.liams.dev/api/files/u123/avatar.jpg")
    }

    /// An OAuth avatar already carries a host and must not be rewritten.
    func testAbsoluteURLIsReturnedUnchanged() {
        let google = "https://lh3.googleusercontent.com/a/abc123=s96-c"
        XCTAssertEqual(
            NativeAccountProfile.resolveImageURL(google, relativeTo: base)?.absoluteString,
            google
        )
    }

    func testAbsentOrEmptyValuesStayNil() {
        XCTAssertNil(NativeAccountProfile.resolveImageURL(nil, relativeTo: base))
        XCTAssertNil(NativeAccountProfile.resolveImageURL("", relativeTo: base))
        XCTAssertNil(NativeAccountProfile.resolveImageURL("   ", relativeTo: base))
    }

    /// The resolved URL must be absolute, not merely a URL carrying a base —
    /// `AsyncImage` needs a scheme and host on the value itself.
    func testResolvedURLCarriesASchemeAndHost() {
        let resolved = NativeAccountProfile.resolveImageURL("/api/files/x.png", relativeTo: base)
        XCTAssertEqual(resolved?.scheme, "https")
        XCTAssertEqual(resolved?.host, "chat.liams.dev")
    }

    /// A base with a path must not swallow the leading slash of the avatar path.
    func testARootRelativePathIgnoresAnyBasePath() {
        let nested = URL(string: "https://chat.liams.dev/app/")!
        XCTAssertEqual(
            NativeAccountProfile.resolveImageURL("/api/files/x.png", relativeTo: nested)?.absoluteString,
            "https://chat.liams.dev/api/files/x.png"
        )
    }
}
