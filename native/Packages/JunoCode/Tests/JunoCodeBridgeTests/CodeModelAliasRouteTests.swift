import XCTest
import JunoCodeBridge

/// SPEC docs/code-v2/SPEC.md §1: the short aliases pointed at the retired
/// Sonnet 5 ("sonnet", "pro") and at Qwen ("max"). They now resolve through
/// the shared Code v2 alias table.
final class CodeModelAliasRouteTests: XCTestCase {
    private func route(_ id: String) throws -> CodeModelRoute {
        try XCTUnwrap(CodeModelProviderResolver.default.route(for: id), id)
    }

    func testSonnetAndProRouteToSonnet55() throws {
        for alias in ["sonnet", "pro", "SONNET"] {
            let r = try route(alias)
            XCTAssertEqual(r.providerID, "anthropic", alias)
            XCTAssertEqual(r.providerModelID, "claude-sonnet-5-5", alias)
            XCTAssertEqual(r.wireProtocol, .anthropicMessages, alias)
        }
    }

    func testMaxRoutesToTheCurrentFlagship() throws {
        let r = try route("max")
        XCTAssertEqual(r.providerID, "anthropic")
        XCTAssertEqual(r.providerModelID, "claude-opus-5-5")
    }

    func testOtherAliasesKeepTheirRoutes() throws {
        XCTAssertEqual(try route("opus").providerModelID, "claude-opus-5-5")
        XCTAssertEqual(try route("haiku").providerModelID, "claude-haiku-4-5")
        let flash = try route("flash")
        XCTAssertEqual(flash.providerID, "google")
        XCTAssertEqual(flash.providerModelID, "gemini-3.8-flash")
        XCTAssertEqual(flash.wireProtocol, .openAIChat)
        XCTAssertEqual(try route("fast").providerModelID, "gemini-3.8-flash")
    }

    func testCanonicalIdsAreUntouched() throws {
        XCTAssertEqual(try route("qwen:qwen3.8-max").providerModelID, "qwen3.8-max")
        XCTAssertEqual(try route("anthropic:claude-sonnet-5").providerModelID, "claude-sonnet-5")
    }
}
