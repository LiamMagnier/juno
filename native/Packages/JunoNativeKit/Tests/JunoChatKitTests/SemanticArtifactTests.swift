import Foundation
import XCTest
@testable import JunoChatKit

/// The semantic bodies as the web stores them (`serializeWorkbook`,
/// `serializeDocument`, `serializeDeck`) and as the chat model authors them.
final class SemanticArtifactTests: XCTestCase {
    static let storedWorkbook = #"""
    {"kind":"spreadsheet","version":1,"title":"Q3 budget","sheets":[
      {"name":"Model","cells":{
        "A1":{"v":"Item","bold":true},"B1":{"v":"Cost","bold":true},
        "A2":{"v":"Rent"},"B2":{"v":1200,"fmt":"\"$\"#,##0.00"},
        "A3":{"v":"Food"},"B3":{"v":450.5},
        "A4":{"v":"Total"},"B4":{"f":"SUM(B2:B3)","fmt":"\"$\"#,##0.00"},
        "C4":{"f":"B4/Assumptions!B1","fmt":"0.0%"},
        "D4":{"f":"XLOOKUP(A2,A2:A3,B2:B3)"},
        "E4":{"f":"Budget*2"},
        "F4":{"f":"IF(B4>1000,\"over\",\"under\")"},
        "G4":{"f":"B2/0"},
        "H4":{"f":"ROUND(AVERAGE(B2:B3),0)&\" avg\""},
        "A5":{"t":"date","v":46112,"fmt":"yyyy-mm-dd"}
      },"columns":{"A":{"width":20}},"freeze":{"rows":1,"cols":0},"tables":[],
      "charts":[{"id":"c1","type":"bar","categories":"A2:A3","series":[{"values":"B2:B3"}],"anchor":{"cell":"J2","cols":8,"rows":16}}]},
      {"name":"Assumptions","cells":{"B1":{"v":10000}},"columns":{},"freeze":{"rows":0,"cols":0},"tables":[],"charts":[]}
    ],"names":{"Budget":"Assumptions!$B$1"}}
    """#

    func testStoredWorkbookComputesFormulasInTheirFormats() throws {
        guard case .workbook(let book) = try SemanticArtifact.parse(kind: .spreadsheet, content: Self.storedWorkbook) else {
            return XCTFail("not a workbook")
        }
        XCTAssertEqual(book.title, "Q3 budget")
        XCTAssertEqual(book.sheets.map(\.name), ["Model", "Assumptions"])
        let model = book.sheets[0]
        XCTAssertEqual(model.rowCount, 5)
        XCTAssertEqual(model.columnCount, 8)
        XCTAssertEqual(model.frozenRows, 1)
        XCTAssertEqual(model.columnWidths[1], 20)
        XCTAssertEqual(model.chartCount, 1)

        let engine = SemanticWorkbookEngine(workbook: book)
        func show(_ a1: String) -> SemanticWorkbookEngine.Display {
            engine.display(sheet: 0, address: SemanticCellAddress(a1)!)
        }
        XCTAssertEqual(show("B2").text, "$1,200.00")
        XCTAssertEqual(show("B3").text, "450.5")
        XCTAssertEqual(show("B4").text, "$1,650.50")
        XCTAssertTrue(show("B4").isNumeric)
        XCTAssertEqual(show("C4").text, "16.5%")
        // A function outside the ported core shows its formula, never a guess.
        XCTAssertEqual(show("D4").text, "=XLOOKUP(A2,A2:A3,B2:B3)")
        XCTAssertTrue(show("D4").isUncomputed)
        XCTAssertEqual(show("E4").text, "20000")
        XCTAssertEqual(show("F4").text, "over")
        XCTAssertEqual(show("G4").text, "#DIV/0!")
        XCTAssertTrue(show("G4").isError)
        XCTAssertEqual(show("H4").text, "825 avg")
        XCTAssertEqual(show("A5").text, "2026-03-31")
        XCTAssertEqual(show("Z9").text, "")
    }

    func testAuthoringWorkbookRowsDatesAndFormulasWithEquals() throws {
        let authoring = #"""
        {"title":"Trip","sheets":[{"name":"Costs","rows":[
          ["Night", 120, {"v":0.075,"fmt":"percent"}],
          ["Total", {"f":"=B1*2","fmt":"currency"}, null],
          [{"date":"2026-03-31"}, true, "=HYPERLINK(\"x\")"]
        ]}]}
        """#
        guard case .workbook(let book) = try SemanticArtifact.parse(kind: .spreadsheet, content: authoring) else {
            return XCTFail("not a workbook")
        }
        let engine = SemanticWorkbookEngine(workbook: book)
        func show(_ a1: String) -> String { engine.display(sheet: 0, address: SemanticCellAddress(a1)!).text }
        XCTAssertEqual(show("C1"), "7.5%")
        XCTAssertEqual(show("B2"), "$240.00")
        XCTAssertEqual(show("A3"), "2026-03-31")
        XCTAssertEqual(show("B3"), "TRUE")
        // The injection rule: a string that starts with "=" is text.
        XCTAssertEqual(show("C3"), "=HYPERLINK(\"x\")")
        XCTAssertFalse(engine.display(sheet: 0, address: SemanticCellAddress("C3")!).isUncomputed)
        XCTAssertEqual(SemanticArtifact.summary(kind: .spreadsheet, content: authoring), "1 sheet · 1 formula")
    }

    func testCyclesAndMissingSheetsAreErrorsNotHangs() throws {
        let body = #"{"title":"Loop","sheets":[{"name":"S","cells":{"A1":{"f":"B1+1"},"B1":{"f":"A1+1"},"C1":{"f":"Nope!A1"}}}]}"#
        guard case .workbook(let book) = try SemanticArtifact.parse(kind: .spreadsheet, content: body) else {
            return XCTFail("not a workbook")
        }
        let engine = SemanticWorkbookEngine(workbook: book)
        XCTAssertTrue(engine.display(sheet: 0, address: SemanticCellAddress("A1")!).isError)
        XCTAssertEqual(engine.display(sheet: 0, address: SemanticCellAddress("C1")!).text, "#REF!")
    }

    func testCellAddresses() {
        XCTAssertEqual(SemanticCellAddress("$AB$12"), SemanticCellAddress(row: 12, column: 28))
        XCTAssertEqual(SemanticCellAddress(row: 3, column: 703).a1, "AAA3")
        XCTAssertNil(SemanticCellAddress("12A"))
        XCTAssertNil(SemanticCellAddress("A0"))
    }

    func testNumberFormats() {
        XCTAssertEqual(SemanticNumberFormat.format(-1234.5, code: "#,##0.00"), "-1,234.50")
        XCTAssertEqual(SemanticNumberFormat.format(0.1234, code: "0%"), "12%")
        XCTAssertEqual(SemanticNumberFormat.format(1500, code: "\"€\"#,##0"), "€1,500")
        XCTAssertEqual(SemanticNumberFormat.format(46112, code: "mmm yyyy"), "Mar 2026")
        XCTAssertEqual(SemanticNumberFormat.format(3, code: nil), "3")
    }

    static let storedDocument = #"""
    {"kind":"document","version":1,"title":"Launch memo","metadata":{},"styles":{},
     "sources":[{"id":"src1","title":"Market report","url":"https://example.com/r","publisher":"Example"}],
     "blocks":[
      {"id":"b1","type":"heading","level":1,"text":"Why now"},
      {"id":"b2","type":"paragraph","text":"Demand is **up** 20% [@src1].","style":"lead"},
      {"id":"b3","type":"list","ordered":false,"items":[{"text":"Ship","level":0},{"text":"Measure","level":1}]},
      {"id":"b4","type":"table","header":["Q","Revenue"],"rows":[["Q1","10"],["Q2","12"]],"caption":"Revenue"},
      {"id":"b5","type":"callout","tone":"warning","title":"Risk","text":"Supply is thin."},
      {"id":"b6","type":"pageBreak"}
     ],
     "comments":[
      {"id":"c1","blockId":"b2","author":"Maya","text":"Source?","createdAt":"2026-10-01T10:00:00.000Z"},
      {"id":"c2","blockId":"b2","author":"Maya","text":"Done","createdAt":"2026-10-01T10:00:00.000Z","resolved":true}
     ],
     "revisions":[{"id":"r1","blockId":"b1","kind":"replace","text":"Why this quarter","author":"Alevr","createdAt":"2026-10-01T10:00:00.000Z","status":"pending"}]}
    """#

    func testStoredDocumentBlocksCommentsAndCitations() throws {
        guard case .document(let document) = try SemanticArtifact.parse(kind: .document, content: Self.storedDocument) else {
            return XCTFail("not a document")
        }
        XCTAssertEqual(document.title, "Launch memo")
        XCTAssertEqual(document.blocks.count, 6)
        XCTAssertEqual(document.blocks[0].kind, .heading(level: 1, text: "Why now"))
        XCTAssertEqual(document.blocks[2].kind, .list(ordered: false, items: [
            .init(text: "Ship", level: 0), .init(text: "Measure", level: 1),
        ]))
        XCTAssertEqual(document.openComments(on: "b2").map(\.text), ["Source?"])
        XCTAssertEqual(document.pendingRevisions(on: "b1").map(\.text), ["Why this quarter"])
        XCTAssertEqual(document.inlineMarkdown("Demand is **up** 20% [@src1]."), "Demand is **up** 20%[1].")
        XCTAssertEqual(SemanticArtifact.parsed(kind: .document, content: Self.storedDocument)?.summary,
                       "6 blocks · 1 comment · 1 suggestion")
    }

    func testAuthoringDocumentWithoutIdsAndBareListItems() throws {
        let body = #"{"title":"Notes","blocks":[{"type":"paragraph","text":"Hi"},{"type":"list","ordered":true,"items":["one","two"]}]}"#
        guard case .document(let document) = try SemanticArtifact.parse(kind: .document, content: body) else {
            return XCTFail("not a document")
        }
        XCTAssertEqual(document.blocks.map(\.id), ["b1", "b2"])
        XCTAssertEqual(document.blocks[1].kind, .list(ordered: true, items: [.init(text: "one", level: 0), .init(text: "two", level: 0)]))
    }

    static let storedDeck = #"""
    {"kind":"presentation","version":1,"title":"Q3 review",
     "theme":{"headingFont":"Calibri","bodyFont":"Calibri","background":"#FFFFFF","text":"#1F2328","accent":"#2F6FEB","muted":"#6E7781"},
     "master":{"slideNumbers":true},
     "slides":[
      {"id":"s1","layout":"title","title":"Q3 review","subtitle":"October 2026","elements":[]},
      {"id":"s2","layout":"content","title":"Highlights","elements":[
        {"type":"text","id":"e1","region":"body","paragraphs":[{"text":"Revenue up","level":0,"bullet":true},{"text":"EMEA led","level":1,"bullet":true}]},
        {"type":"chart","id":"e2","chartType":"column","title":"Revenue","categories":["Q1","Q2"],"series":[{"name":"2026","values":[10,12]}]}
      ],"notes":"Pause here."},
      {"id":"s3","layout":"two-column","title":"Compare","elements":[
        {"type":"table","id":"e3","region":"left","header":["A","B"],"rows":[["1","2"]]},
        {"type":"image","id":"e4","region":"right","src":"https://example.com/a.png","alt":"Map"}
      ]}
     ]}
    """#

    func testStoredDeckSlidesElementsAndNotes() throws {
        guard case .deck(let deck) = try SemanticArtifact.parse(kind: .presentation, content: Self.storedDeck) else {
            return XCTFail("not a deck")
        }
        XCTAssertEqual(deck.slides.map(\.layout), ["title", "content", "two-column"])
        XCTAssertEqual(deck.slides[0].subtitle, "October 2026")
        XCTAssertEqual(deck.slides[1].notes, "Pause here.")
        XCTAssertEqual(deck.slides[1].elements.first, .text(region: "body", paragraphs: [
            .init(text: "Revenue up", level: 0, bullet: true, bold: false),
            .init(text: "EMEA led", level: 1, bullet: true, bold: false),
        ]))
        XCTAssertEqual(deck.slides[1].elements.last, .chart(
            type: "column", title: "Revenue", categories: ["Q1", "Q2"],
            series: [.init(name: "2026", values: [10, 12])]
        ))
        XCTAssertEqual(deck.slides[2].elements.last, .image(alt: "Map"))
        XCTAssertEqual(SemanticArtifact.summary(kind: .presentation, content: Self.storedDeck), "3 slides")
    }

    func testBodiesThatDoNotOpenSayWhy() {
        XCTAssertThrowsError(try SemanticArtifact.parse(kind: .spreadsheet, content: "not json")) { error in
            XCTAssertEqual(error as? SemanticArtifact.ParseError, .notJSON)
        }
        XCTAssertThrowsError(try SemanticArtifact.parse(kind: .presentation, content: #"{"title":"x","slides":[]}"#))
        XCTAssertThrowsError(try SemanticArtifact.parse(kind: .html, content: "{}")) { error in
            XCTAssertEqual(error as? SemanticArtifact.ParseError, .notSemantic)
        }
    }

    func testKindsRuntimeAndDecodingFromStreamedRows() {
        XCTAssertEqual(NativeArtifactKind(rawValue: "SPREADSHEET"), .spreadsheet)
        XCTAssertTrue(NativeArtifactKind.document.isSemantic)
        XCTAssertFalse(NativeArtifactKind.presentation.supportsRenderedPreview)
        XCTAssertFalse(NativeArtifactKind.html.isSemantic)
        let runtime = NativeArtifactRuntimeInfo.resolve(kind: .presentation, language: nil)
        XCTAssertEqual(runtime.mode, .semantic)
        XCTAssertEqual(runtime.label, "Deck")
        XCTAssertFalse(runtime.runsOnThisMac)
    }

    // MARK: Transcript tags

    func testSemanticTagsKeepTheirKind() {
        let parts = NativeMessageContent.parts(of: #"Here. <juno:artifact identifier="plan" type="spreadsheet" title="Plan">{"title":"Plan","sheets":[{"name":"S","rows":[[1]]}]}</juno:artifact>"#)
        guard case .artifact(let reference)? = parts.last else { return XCTFail("no card") }
        XCTAssertEqual(reference.kind, "SPREADSHEET")
        XCTAssertFalse(reference.streaming)
    }

    func testClosedOpsBlockReadsAsAReferenceNotJSON() {
        let raw = #"Updated the totals. <juno:artifact-ops identifier="plan">[{"op":"setCell","sheet":"S","cell":"A1","value":2}]</juno:artifact-ops> Done."#
        let parts = NativeMessageContent.parts(of: raw)
        XCTAssertEqual(parts.count, 3)
        guard case .artifact(let reference) = parts[1] else { return XCTFail("no card") }
        XCTAssertEqual(reference.identifier, "plan")
        XCTAssertFalse(reference.streaming)
        XCTAssertFalse(NativeMessageContent.plainText(of: raw).contains("setCell"))
    }

    func testStreamingOpsBlockIsAnEditingCard() {
        let raw = #"On it. <juno:artifact-ops identifier="plan">[{"op":"setCe"#
        let parts = NativeMessageContent.parts(of: raw)
        guard case .artifact(let reference)? = parts.last else { return XCTFail("no card") }
        XCTAssertEqual(reference.identifier, "plan")
        XCTAssertEqual(reference.title, "Editing")
        XCTAssertTrue(reference.streaming)
        XCTAssertEqual(reference.content, "")

        let partial = NativeMessageContent.parts(of: "On it. <juno:artifact-op")
        XCTAssertEqual(partial.count, 1)
        guard case .text(let text)? = partial.first else { return XCTFail("text expected") }
        XCTAssertFalse(text.contains("<juno"))
    }
}
