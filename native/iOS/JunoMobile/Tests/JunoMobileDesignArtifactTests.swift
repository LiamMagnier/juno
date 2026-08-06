import JunoDesignKit
import XCTest
@testable import JunoMobile

/// What the phone shows for a design document: the layers, in the order and the
/// nesting the document describes, and a stated refusal for a body that is not
/// one.
final class JunoMobileDesignArtifactTests: XCTestCase {
    /// A page with a frame containing a rectangle and a line of text, plus a
    /// hidden sibling. Enough to pin ordering, nesting, the text a design
    /// carries, and the visibility flag — which are the four things the reader
    /// claims to know.
    private static let documentJSON = """
    {
      "schemaVersion": 1,
      "id": "doc-test",
      "name": "Viewer test",
      "revision": 4,
      "migratedFrom": [],
      "pages": [
        {
          "id": "page1",
          "name": "Page 1",
          "children": ["frame", "draft"],
          "backgroundColor": { "r": 1, "g": 1, "b": 1, "a": 1 }
        }
      ],
      "nodes": {
        "frame": {
          "id": "frame", "type": "frame", "name": "Frame", "parentId": null,
          "x": 0, "y": 0, "width": 320, "height": 200,
          "rotation": 0, "opacity": 1, "visible": true, "locked": false,
          "blendMode": "normal",
          "fills": [{ "type": "solid", "color": { "r": 1, "g": 1, "b": 1, "a": 1 } }],
          "strokes": [], "cornerRadius": 0, "shadows": [], "blur": null,
          "constraints": { "horizontal": "min", "vertical": "min" },
          "widthMode": "fixed", "heightMode": "fixed", "limits": {},
          "layoutChild": { "grow": false, "absolute": false },
          "boundVariables": {},
          "children": ["swatch", "label"], "clipsContent": true, "layout": null
        },
        "swatch": {
          "id": "swatch", "type": "rectangle", "name": "Swatch", "parentId": "frame",
          "x": 24, "y": 24, "width": 120, "height": 64,
          "rotation": 0, "opacity": 1, "visible": true, "locked": false,
          "blendMode": "normal",
          "fills": [{ "type": "solid", "color": { "r": 0.2, "g": 0.3, "b": 0.9, "a": 1 } }],
          "strokes": [], "cornerRadius": 8, "shadows": [], "blur": null,
          "constraints": { "horizontal": "min", "vertical": "min" },
          "widthMode": "fixed", "heightMode": "fixed", "limits": {},
          "layoutChild": { "grow": false, "absolute": false },
          "boundVariables": {}
        },
        "label": {
          "id": "label", "type": "text", "name": "Label", "parentId": "frame",
          "x": 24, "y": 110, "width": 240, "height": 24,
          "rotation": 0, "opacity": 1, "visible": true, "locked": false,
          "blendMode": "normal",
          "fills": [{ "type": "solid", "color": { "r": 0.06, "g": 0.06, "b": 0.08, "a": 1 } }],
          "strokes": [], "cornerRadius": 0, "shadows": [], "blur": null,
          "constraints": { "horizontal": "min", "vertical": "min" },
          "widthMode": "fixed", "heightMode": "hug", "limits": {},
          "layoutChild": { "grow": false, "absolute": false },
          "boundVariables": {},
          "characters": "Handoff to the phone",
          "typography": {
            "fontFamily": "Inter", "fontSize": 16, "fontWeight": 400,
            "lineHeight": { "unit": "percent", "value": 140 },
            "letterSpacing": 0, "textAlign": "left", "verticalAlign": "top"
          }
        },
        "draft": {
          "id": "draft", "type": "ellipse", "name": "Draft blob", "parentId": null,
          "x": 200, "y": 20, "width": 60, "height": 60,
          "rotation": 0, "opacity": 1, "visible": false, "locked": false,
          "blendMode": "normal",
          "fills": [], "strokes": [], "cornerRadius": 0, "shadows": [], "blur": null,
          "constraints": { "horizontal": "min", "vertical": "min" },
          "widthMode": "fixed", "heightMode": "fixed", "limits": {},
          "layoutChild": { "grow": false, "absolute": false },
          "boundVariables": {}
        }
      },
      "components": {}, "collections": {}, "variables": {}, "activeModes": {},
      "interactions": {}, "animations": {}, "comments": [], "assets": {},
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
    """

    private func document() throws -> DesignDocument {
        try DesignDocumentCodec.load(Data(Self.documentJSON.utf8))
    }

    /// The order is the page's `children`, depth-first — not the `nodes`
    /// dictionary's, which has none. A reader that listed a dictionary would put
    /// the layers in a different order on every launch.
    func testTheOutlineFollowsTheDocumentsOwnOrderAndNesting() throws {
        let document = try document()
        let page = try XCTUnwrap(document.pages.first)
        let rows = JunoMobileDesignOutline.rows(of: page, in: document)

        XCTAssertEqual(rows.map(\.id), ["frame", "swatch", "label", "draft"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 1, 0])
    }

    /// The words a design contains are the part worth reading on a phone, and
    /// they belong to text layers alone.
    func testOnlyTextLayersCarryTheirWords() throws {
        let document = try document()
        let page = try XCTUnwrap(document.pages.first)
        let rows = JunoMobileDesignOutline.rows(of: page, in: document)

        XCTAssertEqual(
            rows.first { $0.id == "label" }?.characters, "Handoff to the phone"
        )
        XCTAssertNil(rows.first { $0.id == "swatch" }?.characters)
        XCTAssertNil(rows.first { $0.id == "frame" }?.characters)
    }

    /// A hidden layer is listed and marked, not omitted. It is in the file, and
    /// a reader that silently dropped it would disagree with the Mac's layers
    /// panel about what the document contains.
    func testAHiddenLayerIsShownAsHiddenRatherThanDropped() throws {
        let document = try document()
        let page = try XCTUnwrap(document.pages.first)
        let rows = JunoMobileDesignOutline.rows(of: page, in: document)

        let draft = try XCTUnwrap(rows.first { $0.id == "draft" })
        XCTAssertTrue(draft.hidden)
        XCTAssertFalse(try XCTUnwrap(rows.first { $0.id == "frame" }).hidden)
    }

    /// Every node type gets its own glyph. The switch has no `default:`, so a
    /// type added to the contract stops the build here rather than rendering as
    /// whatever the fallback happened to be — which is how a component and a
    /// group become indistinguishable in a list.
    func testEveryNodeTypeHasItsOwnGlyph() {
        let types: [NodeType] = [
            .frame, .group, .rectangle, .ellipse, .line, .path, .text, .image,
            .component, .instance,
        ]
        let glyphs = types.map(JunoMobileDesignOutline.glyph(for:))
        XCTAssertEqual(Set(glyphs).count, types.count)
        XCTAssertFalse(glyphs.contains(where: \.isEmpty))
    }

    /// A body that is not a design document is refused with a reason, so a lost
    /// document cannot read as an empty one.
    func testANonDocumentIsRefusedWithAReason() {
        XCTAssertThrowsError(try DesignDocumentCodec.load(Data("{\"hello\":1}".utf8))) { error in
            XCTAssertEqual(error as? DesignDocumentCodec.Failure, .notADocument)
        }
    }

    /// A document from a newer build is refused rather than partially shown.
    func testAFutureSchemaIsRefused() {
        let future = Self.documentJSON.replacingOccurrences(
            of: "\"schemaVersion\": 1", with: "\"schemaVersion\": 99"
        )
        XCTAssertThrowsError(try DesignDocumentCodec.load(Data(future.utf8))) { error in
            XCTAssertEqual(
                error as? DesignDocumentCodec.Failure,
                .futureSchema(found: 99, supported: DesignSchema.version)
            )
        }
    }
}
