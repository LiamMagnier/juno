import Foundation
import XCTest
@testable import JunoCodeCore
@testable import JunoCodeRuntime

/// The permission rule grammar, checked against the fixture the cloud engine
/// is checked against too.
///
/// `.juno/settings.json` is read by two engines: this one on the Mac and
/// `runner/agent-core` in the cloud. A rule has to mean the same thing to both,
/// so the cases live once, in `contracts/agent/permission-rules.fixtures.json`,
/// and each language runs all of them (`src/test/permission-rules.test.ts` is
/// the other half). Changing the grammar here without the fixture fails this
/// test; changing it in the fixture without the TypeScript port fails that one.
final class PermissionRuleFixtureTests: XCTestCase {
    private struct Subject: Decodable {
        var command: String?
        var path: String?
        var domain: String?

        var value: PermissionRuleSubject? {
            if let command { return .command(command) }
            if let path { return .path(path) }
            if let domain { return .domain(domain) }
            return nil
        }
    }

    private struct Lists: Decodable {
        var allow: [String]?
        var ask: [String]?
        var deny: [String]?
    }

    private struct Expected: Decodable, Equatable {
        var decision: String
        var rule: String
    }

    private struct Fixture: Decodable {
        struct Parse: Decodable { var text: String; var rule: String? }
        struct Covers: Decodable { var rule: String; var tool: String; var expect: Bool }
        struct Match: Decodable { var rule: String; var tool: String; var subject: Subject?; var expect: Bool }
        struct EvaluateGroup: Decodable {
            struct Case: Decodable { var tool: String; var subject: Subject?; var expect: Expected? }
            var name: String
            var rules: Lists
            var cases: [Case]
        }
        struct Split: Decodable { var line: String; var segments: [String] }
        struct Suggested: Decodable { var tool: String; var subject: Subject?; var rule: String }
        struct Ruling: Decodable { var mode: String; var risk: String; var rule: Expected?; var expect: String }
        struct LayerGroup: Decodable {
            struct Layer: Decodable { var origin: String; var approved: Bool; var rules: Lists }
            var name: String
            var layers: [Layer]
            var expect: Lists
        }

        var families: [String: [String]]
        var parse: [Parse]
        var covers: [Covers]
        var matches: [Match]
        var evaluate: [EvaluateGroup]
        var split: [Split]
        var nested: [Split]
        var suggested: [Suggested]
        var ruling: [Ruling]
        var layers: [LayerGroup]
    }

    private func loadFixture() throws -> Fixture {
        var root = URL(fileURLWithPath: #filePath)
        // Tests/JunoCodeRuntimeTests/<file> → Tests → JunoCode → Packages → native → repository.
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let url = root.appendingPathComponent("contracts/agent/permission-rules.fixtures.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func rule(_ text: String, file: StaticString = #filePath, line: UInt = #line) throws -> PermissionRule {
        try XCTUnwrap(PermissionRule(parsing: text), "fixture rule does not parse: \(text)", file: file, line: line)
    }

    private func ruleSet(_ lists: Lists) throws -> PermissionRuleSet {
        PermissionRuleSet(
            allow: try (lists.allow ?? []).map { try rule($0) },
            ask: try (lists.ask ?? []).map { try rule($0) },
            deny: try (lists.deny ?? []).map { try rule($0) }
        )
    }

    private func described(_ decision: PermissionRuleDecision?) -> Expected? {
        switch decision {
        case let .allow(rule)?: Expected(decision: "allow", rule: rule.description)
        case let .ask(rule)?: Expected(decision: "ask", rule: rule.description)
        case let .deny(rule)?: Expected(decision: "deny", rule: rule.description)
        case nil: nil
        }
    }

    private func decision(_ expected: Expected) throws -> PermissionRuleDecision {
        let parsed = try rule(expected.rule)
        switch expected.decision {
        case "allow": return .allow(parsed)
        case "ask": return .ask(parsed)
        case "deny": return .deny(parsed)
        default: throw CocoaError(.coderInvalidValue)
        }
    }

    func testTheFamilyTableIsTheOneBothEnginesUse() throws {
        let fixture = try loadFixture()
        XCTAssertEqual(PermissionRule.families, fixture.families.mapValues(Set.init))
    }

    func testParsing() throws {
        for item in try loadFixture().parse {
            XCTAssertEqual(PermissionRule(parsing: item.text)?.description, item.rule, "\(item.text.debugDescription)")
        }
    }

    func testWhichToolsARuleNames() throws {
        for item in try loadFixture().covers {
            XCTAssertEqual(try rule(item.rule).covers(toolName: item.tool), item.expect, "\(item.rule) covers \(item.tool)")
        }
    }

    func testMatchingOneInvocation() throws {
        for item in try loadFixture().matches {
            XCTAssertEqual(
                try rule(item.rule).matches(toolName: item.tool, subject: item.subject?.value),
                item.expect,
                "\(item.rule) ~ \(item.tool) \(String(describing: item.subject?.value))"
            )
        }
    }

    func testDenyBeatsAskBeatsAllowSegmentBySegment() throws {
        for group in try loadFixture().evaluate {
            let rules = try ruleSet(group.rules)
            for item in group.cases {
                XCTAssertEqual(
                    described(rules.evaluate(toolName: item.tool, subject: item.subject?.value)),
                    item.expect,
                    "\(group.name): \(item.tool) \(String(describing: item.subject?.value))"
                )
            }
        }
    }

    func testSegmentsAndNestedSegments() throws {
        let fixture = try loadFixture()
        for item in fixture.split {
            XCTAssertEqual(ShellSegments.split(item.line), item.segments, item.line.debugDescription)
        }
        for item in fixture.nested {
            XCTAssertEqual(ShellSegments.nestedSegments(item.line), item.segments, item.line.debugDescription)
        }
    }

    func testTheRuleAlwaysAllowSaves() throws {
        for item in try loadFixture().suggested {
            XCTAssertEqual(
                PermissionRuleSet.suggestedRule(toolName: item.tool, subject: item.subject?.value).description,
                item.rule,
                "\(item.tool) \(String(describing: item.subject?.value))"
            )
        }
    }

    func testTheModeLadderWithRulesOnTop() throws {
        let modes: [String: PermissionMode] = [
            "plan": .readOnly, "ask": .askBeforeChanges, "auto_edit": .workspaceWrite, "full": .fullAccess,
        ]
        for item in try loadFixture().ruling {
            let mode = try XCTUnwrap(modes[item.mode])
            let risk = try XCTUnwrap(ActionRisk(rawValue: item.risk))
            let ruled = PermissionCoordinator.ruling(
                mode: mode,
                risk: risk,
                approvalPolicy: .byRisk,
                rule: try item.rule.map { try decision($0) }
            )
            let outcome = switch ruled {
            case .allow: "allow"
            case .requireApproval: "ask"
            case .deny: "deny"
            }
            XCTAssertEqual(outcome, item.expect, "\(item.mode)/\(item.risk) with \(String(describing: item.rule))")
        }
    }

    func testSettingsLayersAndWhatAnUnapprovedProjectFileMayDo() throws {
        let origins: [String: CodeSettingsLayer.Origin] = ["user": .user, "project": .project, "local": .local]
        for group in try loadFixture().layers {
            let layers = try group.layers.map { layer in
                let rules = try ruleSet(layer.rules)
                return CodeSettingsLayer(
                    CodeSettingsFile(permissions: .init(allow: rules.allow, ask: rules.ask, deny: rules.deny)),
                    origin: try XCTUnwrap(origins[layer.origin]),
                    isApproved: layer.approved
                )
            }
            let resolved = ResolvedCodeSettings.resolve(layers).rules
            XCTAssertEqual(resolved.allow.map(\.description), group.expect.allow ?? [], group.name)
            XCTAssertEqual(resolved.ask.map(\.description), group.expect.ask ?? [], group.name)
            XCTAssertEqual(resolved.deny.map(\.description), group.expect.deny ?? [], group.name)
        }
    }
}
