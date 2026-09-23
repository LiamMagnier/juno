import XCTest
@testable import JunoDesignSystem

/// The `juno-visual` fence: which fences carry one, and how its JSON is read —
/// the web's `parseVisualBlock` (`inline-visual-block.tsx`).
final class JunoVisualBlockTests: XCTestCase {
    func testTheFenceNamesTheWebRoutes() {
        for name in ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block", "Juno-Visual", "visual extra"] {
            XCTAssertTrue(JunoVisualMarkup.isVisualFence(info: name), name)
        }
        for name in ["json", "mermaid", "visualise", "", nil] as [String?] {
            XCTAssertFalse(JunoVisualMarkup.isVisualFence(info: name), name ?? "nil")
        }
    }

    func testAFlowReadsItsNodesAndEdges() throws {
        let block = try XCTUnwrap(JunoVisualMarkup.parse("""
        {"type":"flowchart","title":"Request path","nodes":[{"name":"Edge","description":"TLS ends"},"Router",{"label":"db","value":"Postgres"}],
         "edges":[{"from":"Edge","to":"Router","label":"HTTP"},{"nope":1}]}
        """))
        XCTAssertEqual(block.type, .flowchart)
        XCTAssertEqual(block.type.label, "Flow map")
        XCTAssertEqual(block.parts.count, 3)
        XCTAssertEqual(block.partCount, 3)
        XCTAssertEqual(block.parts[0].title(fallback: "x"), "Edge")
        XCTAssertEqual(block.parts[0].primaryText, "TLS ends")
        XCTAssertEqual(block.parts[1].primaryText, "Router")
        XCTAssertEqual(block.parts[2].title(fallback: "x"), "db")
        XCTAssertEqual(block.edges, [JunoVisualBlockModel.Edge(from: "Edge", to: "Router", label: "HTTP")])
    }

    func testAComparisonReadsListedAndKeyedValues() throws {
        let block = try XCTUnwrap(JunoVisualMarkup.parse("""
        {"type":"comparison","columns":["Speed","Cost"],"rows":[
          {"title":"Redis","values":["Fast",1]},
          {"title":"Postgres","cells":{"speed":"Slower","Cost":"Low"}},
          {"title":"Files","body":"Only the first column"}]}
        """))
        XCTAssertEqual(block.partCount, 3)
        let rows = block.comparisonRows
        XCTAssertEqual(rows[0].value(column: "Speed", index: 0), "Fast")
        XCTAssertEqual(rows[0].value(column: "Cost", index: 1), "1")
        XCTAssertEqual(rows[1].value(column: "Speed", index: 0), "Slower")
        XCTAssertEqual(rows[1].value(column: "Cost", index: 1), "Low")
        XCTAssertEqual(rows[2].value(column: "Speed", index: 0), "Only the first column")
        XCTAssertEqual(rows[2].value(column: "Cost", index: 1), "")
    }

    func testAComparisonWithNoColumnsGetsTheWebsPlaceholders() throws {
        let block = try XCTUnwrap(JunoVisualMarkup.parse(#"{"type":"table","items":[{"title":"A","body":"x"}]}"#))
        XCTAssertEqual(block.comparisonColumns, ["Option A", "Option B"])
        XCTAssertEqual(block.comparisonRows.first?.value(column: "Option A", index: 0), "x")
    }

    func testAQuizKnowsItsAnswer() throws {
        let block = try XCTUnwrap(JunoVisualMarkup.parse("""
        {"type":"quiz","question":"Which is idempotent?","options":[{"label":"POST"},{"label":"PUT","correct":true,"why":"Same result twice"}]}
        """))
        XCTAssertEqual(block.partCount, 2)
        XCTAssertEqual(block.options?[1].correct, true)
        XCTAssertEqual(block.options?[1].explanation, "Same result twice")
        XCTAssertEqual(block.options?[0].correct, false)
    }

    func testTypelessIsCardsAndUnknownIsRefused() throws {
        XCTAssertEqual(JunoVisualMarkup.parse(#"{"cards":[{"title":"One"}]}"#)?.type, .cards)
        XCTAssertNil(JunoVisualMarkup.parse(#"{"type":"hologram"}"#))
        XCTAssertNil(JunoVisualMarkup.parse("[1,2]"))
        XCTAssertNil(JunoVisualMarkup.parse(#"{"type":"cards","items":[{"title":"half"#), "a fence still streaming is not a visual yet")
    }

    func testLegacyStepsBecomeAStepLab() throws {
        let block = try XCTUnwrap(JunoVisualMarkup.parse("""
        {"type":"steps","title":"How a token is chosen","steps":[{"title":"Tokenize","body":"Split the text"},{"title":"Choose what comes next","body":"Sample"}]}
        """))
        let lab = JunoStepLab.fromLegacySteps(title: block.title, description: nil, steps: block.parts)
        XCTAssertEqual(lab.title, "How a token is chosen")
        XCTAssertEqual(lab.label, "Step Lab")
        XCTAssertEqual(lab.steps.map(\.title), ["Tokenize", "Choose what comes next"])
        XCTAssertEqual(lab.steps.map(\.visualType), [.tokenization, .nextTokenSelection])
        XCTAssertEqual(Set(lab.steps.map(\.id)).count, 2)
    }
}
