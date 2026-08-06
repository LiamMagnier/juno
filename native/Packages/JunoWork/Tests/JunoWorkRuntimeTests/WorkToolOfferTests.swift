import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

/// A tool whose underlying machinery can be switched on and off, the way a macOS
/// permission or a running browser can.
private struct SwitchableTool: WorkTool {
    let name: String
    let description = "Does something to this Mac."
    let schema = WorkToolSchema([])

    func assessRisk(input: WorkToolValue) -> WorkRiskLevel { .safe }
    func summary(input: WorkToolValue) -> String { "Do something." }
    func execute(input: WorkToolValue, context: WorkToolContext) async throws -> WorkToolResult {
        WorkToolResult(content: "done")
    }
}

/// Counts how many times the registry asked whether a tool was ready, and with
/// what answer.
private actor ReadinessProbe {
    private var answers: [Bool]
    private(set) var asked = 0

    init(_ answers: [Bool]) { self.answers = answers }

    func next() -> Bool {
        asked += 1
        return answers.isEmpty ? false : answers.removeFirst()
    }
}

/// ``WorkToolRegistry/automation(offers:)``.
///
/// The registry is the last place that can stop a tool the model cannot use from
/// reaching it. Screen control with no Screen Recording permission and browser
/// control with no browser open are both ordinary states of a Mac, and a
/// registry that advertised them anyway would spend a turn of the run producing
/// a refusal the model reads as the person's answer.
final class WorkToolOfferTests: XCTestCase {
    func testOnlyTheToolsThatCanActAreRegistered() async {
        let registry = await WorkToolRegistry.automation(
            offers: [
                WorkToolOffer(tool: SwitchableTool(name: "browser_control"), isReady: { false }),
                WorkToolOffer(tool: SwitchableTool(name: "app_control"), isReady: { true }),
                WorkToolOffer(tool: SwitchableTool(name: "screen_control"), isReady: { false }),
            ]
        )
        XCTAssertEqual(registry.allTools.map(\.name), ["app_control"])
        XCTAssertNil(registry.tool(named: "screen_control"))
    }

    /// A tool that was filtered out is not merely hidden from the listing — it
    /// is not in the registry at all, so a call naming it is refused by the same
    /// path that refuses a tool this build has never had.
    func testAFilteredToolCannotBeInvokedByName() async {
        let registry = await WorkToolRegistry.automation(
            offers: [
                WorkToolOffer(tool: SwitchableTool(name: "screen_control"), isReady: { false })
            ]
        )
        XCTAssertNotNil(registry.validateInput(toolName: "screen_control", input: .object([:])))
        do {
            _ = try await registry.executeAuthorized(
                toolName: "screen_control",
                input: .object([:]),
                context: WorkToolContext(
                    runID: "run-1",
                    toolCallID: "call-1",
                    authorization: .allowedByPolicy,
                    approvals: WorkApprovalCoordinator(policy: .permissive)
                )
            )
            XCTFail("a tool that was not registered must not be executable")
        } catch let error as WorkToolError {
            guard case .unknownTool = error else {
                return XCTFail("expected an unknown-tool refusal, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    /// Asked at the moment the registry is built, and asked again the next time
    /// one is built. Caching the answer is how a Mac keeps advertising screen
    /// control after somebody revoked it in System Settings.
    func testReadinessIsAskedAfreshForEveryRegistry() async {
        let probe = ReadinessProbe([true, false])
        let tool = SwitchableTool(name: "screen_control")

        let first = await WorkToolRegistry.automation(
            offers: [WorkToolOffer(tool: tool, isReady: { await probe.next() })]
        )
        XCTAssertEqual(first.allTools.map(\.name), ["screen_control"])

        let second = await WorkToolRegistry.automation(
            offers: [WorkToolOffer(tool: tool, isReady: { await probe.next() })]
        )
        XCTAssertEqual(second.allTools.map(\.name), [])

        let asked = await probe.asked
        XCTAssertEqual(asked, 2)
    }

    func testAnEmptyOfferListIsARegistryThatOffersNothing() async {
        let registry = await WorkToolRegistry.automation(offers: [])
        XCTAssertTrue(registry.allTools.isEmpty)
        // `readWrite` for the reason `automation(tools:)` gives: no grant is
        // involved, so a narrower mode would refuse every automated action
        // before the risk ladder that governs them got to decide.
        XCTAssertEqual(registry.mode, .readWrite)
    }
}
