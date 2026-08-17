import Foundation
import XCTest
@testable import JunoCodeLocal

final class ToolchainEnvironmentTests: XCTestCase {
    private var tempHomeURL: URL!

    override func setUpWithError() throws {
        tempHomeURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-toolchain-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempHomeURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        if let tempHomeURL {
            try? FileManager.default.removeItem(at: tempHomeURL)
        }
    }

    func testResolvedPATHContainsDefaultBasePaths() {
        let path = ToolchainEnvironment.resolvedPATH(homeDirectory: tempHomeURL.path)
        for base in ToolchainEnvironment.defaultBasePaths {
            XCTAssertTrue(path.contains(base), "Expected PATH to contain \(base)")
        }
    }

    func testResolvedPATHDiscoversExistingToolchainDirs() throws {
        let bunBin = tempHomeURL.appendingPathComponent(".bun/bin")
        let cargoBin = tempHomeURL.appendingPathComponent(".cargo/bin")
        let nvmNodeBin = tempHomeURL.appendingPathComponent(".nvm/versions/node/v20.10.0/bin")

        try FileManager.default.createDirectory(at: bunBin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: cargoBin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: nvmNodeBin, withIntermediateDirectories: true)

        let path = ToolchainEnvironment.resolvedPATH(homeDirectory: tempHomeURL.path)

        XCTAssertTrue(path.contains(bunBin.path), "Expected PATH to contain bun bin")
        XCTAssertTrue(path.contains(cargoBin.path), "Expected PATH to contain cargo bin")
        XCTAssertTrue(path.contains(nvmNodeBin.path), "Expected PATH to contain nvm node bin")
    }

    func testResolvedPATHExcludesNonExistentDirectories() {
        let path = ToolchainEnvironment.resolvedPATH(homeDirectory: tempHomeURL.path)
        XCTAssertFalse(path.contains(".bun/bin"))
        XCTAssertFalse(path.contains(".cargo/bin"))
    }
}
