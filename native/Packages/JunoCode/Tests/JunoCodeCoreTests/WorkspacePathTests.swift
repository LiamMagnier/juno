import XCTest
@testable import JunoCodeCore

final class WorkspacePathTests: XCTestCase {
    func testRejectsTraversalAbsoluteAndInvalidPaths() {
        XCTAssertThrowsError(try WorkspacePath("")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .empty)
        }
        XCTAssertThrowsError(try WorkspacePath("../secrets.txt")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .traversal)
        }
        XCTAssertThrowsError(try WorkspacePath("src/../../etc/passwd")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .traversal)
        }
        XCTAssertThrowsError(try WorkspacePath("/etc/passwd")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .absolute)
        }
        XCTAssertThrowsError(try WorkspacePath("~/Documents/x")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .absolute)
        }
        XCTAssertThrowsError(try WorkspacePath("a\\b")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .absolute)
        }
        XCTAssertThrowsError(try WorkspacePath("a//b")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .invalidComponent)
        }
        XCTAssertThrowsError(try WorkspacePath("a/./b")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .invalidComponent)
        }
        XCTAssertThrowsError(try WorkspacePath("a/\u{07}bell")) { error in
            XCTAssertEqual(error as? WorkspacePathError, .invalidComponent)
        }
        XCTAssertThrowsError(try WorkspacePath(String(repeating: "a", count: 5_000))) { error in
            XCTAssertEqual(error as? WorkspacePathError, .tooLong)
        }
        XCTAssertNoThrow(try WorkspacePath("Sources/App/main.swift"))
        XCTAssertNoThrow(try WorkspacePath("..hidden/..file"))
    }

    func testComponentsAndDerivedProperties() throws {
        let path = try WorkspacePath("Sources/App/main.swift")
        XCTAssertEqual(path.components, ["Sources", "App", "main.swift"])
        XCTAssertEqual(path.lastComponent, "main.swift")
        XCTAssertEqual(path.fileExtension, "swift")
        XCTAssertEqual(path.parent?.value, "Sources/App")
        XCTAssertNil(try WorkspacePath("README").fileExtension)
        XCTAssertNil(try WorkspacePath(".gitignore").fileExtension)
        XCTAssertNil(try WorkspacePath("README").parent)
    }

    func testAppendingAndDescendants() throws {
        let root = try WorkspacePath("Sources")
        let child = try root.appending("App")
        XCTAssertEqual(child.value, "Sources/App")
        XCTAssertThrowsError(try root.appending("../escape"))
        XCTAssertThrowsError(try root.appending(""))
        XCTAssertTrue(child.isDescendant(of: root))
        XCTAssertFalse(root.isDescendant(of: child))
        XCTAssertFalse(root.isDescendant(of: root))
        let sibling = try WorkspacePath("SourcesOther/App")
        XCTAssertFalse(sibling.isDescendant(of: root))
    }

    func testDecodingRejectsUnsafeValues() throws {
        let decoder = JSONDecoder()
        XCTAssertThrowsError(
            try decoder.decode(WorkspacePath.self, from: Data("\"../x\"".utf8))
        )
        let decoded = try decoder.decode(WorkspacePath.self, from: Data("\"a/b.txt\"".utf8))
        XCTAssertEqual(decoded.value, "a/b.txt")
        let encoded = try JSONEncoder().encode(decoded)
        XCTAssertEqual(String(decoding: encoded, as: UTF8.self), "\"a\\/b.txt\"")
    }
}
