import XCTest
@testable import JunoCodeUI

final class ProjectTrashPolicyTests: XCTestCase {
    func testProtectedFoldersAndSymlinksNeverBecomeTrashableProjects() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let project = home.appendingPathComponent("Developer/project")
        try fm.createDirectory(at: project, withIntermediateDirectories: true)
        try fm.createDirectory(at: home.appendingPathComponent("Library/Cache"), withIntermediateDirectories: true)
        let alias = root.appendingPathComponent("home-alias")
        try fm.createSymbolicLink(at: alias, withDestinationURL: home)
        func refusal(_ folder: URL, others: [URL] = []) -> String? {
            ProjectTrashPolicy.refusal(for: folder, otherProjects: others, home: home, systemRoots: [])
        }
        XCTAssertNotNil(refusal(home))
        XCTAssertNotNil(refusal(root))
        XCTAssertNotNil(refusal(alias))
        XCTAssertNotNil(refusal(home.appendingPathComponent("Library/Cache")))
        XCTAssertNil(refusal(project))
        XCTAssertNotNil(refusal(project, others: [project.appendingPathComponent("child")]))
    }
}
