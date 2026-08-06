import XCTest
@testable import JunoDesignKit

/// The fixture is produced by the WEBSITE's operation layer
/// (`scripts/emit-design-fixture.ts`), so these tests prove the Mac reads and
/// rewrites a document the browser actually wrote — not that Swift agrees with
/// itself.
final class DesignRoundTripTests: XCTestCase {
    private func fixtureData() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "Fixtures/sign-in.juno.design", withExtension: "json"),
            "the cross-platform design fixture is missing; run `npx tsx scripts/emit-design-fixture.ts`"
        )
        return try Data(contentsOf: url)
    }

    func testDecodesAWebsiteAuthoredDocument() throws {
        let document = try DesignDocumentCodec.load(fixtureData())

        XCTAssertEqual(document.schemaVersion, DesignSchema.version)
        XCTAssertEqual(document.pages.count, 1)
        XCTAssertEqual(document.nodes.count, 8)

        let button = try XCTUnwrap(document.nodes["button"])
        XCTAssertEqual(button.type, .component)
        XCTAssertEqual(button.componentId, "cmp-primary")
        XCTAssertEqual(button.boundVariables["fills.0.color"], "var-primary")

        let label = try XCTUnwrap(document.nodes["buttonLabel"])
        XCTAssertEqual(label.type, .text)
        XCTAssertEqual(label.characters, "Sign in")
        XCTAssertEqual(label.typography?.fontSize, 16)
        if case .percent(let value) = label.typography?.lineHeight {
            XCTAssertEqual(value, 140)
        } else {
            XCTFail("expected a percentage line height")
        }

        let card = try XCTUnwrap(document.nodes["card"])
        XCTAssertEqual(card.layout?.direction, .vertical)
        XCTAssertEqual(card.layout?.padding.top, 24)
        XCTAssertEqual(card.limits.maxWidth, 480)
        if case .corners(let a, _, _, let d) = card.cornerRadius {
            XCTAssertEqual(a, 16)
            XCTAssertEqual(d, 8)
        } else {
            XCTFail("expected per-corner radii")
        }
        guard case .linearGradient(let stops, _, _, _, _) = card.fills.first else {
            return XCTFail("expected a linear gradient fill")
        }
        XCTAssertEqual(stops.count, 2)
        XCTAssertEqual(card.strokes.first?.dash, [4, 2])
        XCTAssertEqual(card.shadows.first?.blur, 24)

        XCTAssertEqual(document.components["cmp-primary"]?.properties.first?.name, "Label")
        XCTAssertEqual(document.collections["col1"]?.modes.map(\.name), ["Light", "Dark"])
        XCTAssertEqual(document.interactions["int-signin"]?.sourceNodeId, "button")
        XCTAssertEqual(document.animations["anim-hover"]?.tracks.count, 2)
        XCTAssertEqual(document.comments.first?.nodeId, "button")
        XCTAssertEqual(document.assets["asset-logo"]?.mimeType, "image/svg+xml")

        let instance = try XCTUnwrap(document.nodes["inst-secondary"])
        XCTAssertEqual(instance.type, .instance)
        XCTAssertEqual(instance.variantProperties, [:])
    }

    /// The property that makes "open it on either machine" real: decode →
    /// encode must produce the same bytes the website wrote.
    func testReEncodesByteIdenticallyToTheWebsite() throws {
        let data = fixtureData_orFail()
        let document = try DesignDocumentCodec.load(data)
        let reencoded = try DesignDocumentCodec.encode(document)

        // The fixture is written with a trailing newline for tidiness; compare
        // the JSON itself.
        let original = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let round = String(decoding: reencoded, as: UTF8.self)

        if original != round {
            // A diff of the first divergence is far more useful than "not equal".
            let a = Array(original)
            let b = Array(round)
            var index = 0
            while index < min(a.count, b.count), a[index] == b[index] { index += 1 }
            let start = max(0, index - 60)
            XCTFail(
                """
                Swift re-encoding diverged from the website's bytes at offset \(index).
                website: …\(String(a[start..<min(a.count, index + 60)]))
                swift:   …\(String(b[start..<min(b.count, index + 60)]))
                """
            )
        }
    }

    private func fixtureData_orFail() -> Data {
        (try? fixtureData()) ?? Data()
    }

    func testRefusesADocumentFromANewerBuild() throws {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any]
        )
        object["schemaVersion"] = DesignSchema.version + 5
        let data = try JSONSerialization.data(withJSONObject: object)

        XCTAssertThrowsError(try DesignDocumentCodec.load(data)) { error in
            guard case DesignDocumentCodec.Failure.futureSchema(let found, let supported) = error else {
                return XCTFail("expected futureSchema, got \(error)")
            }
            XCTAssertEqual(found, DesignSchema.version + 5)
            XCTAssertEqual(supported, DesignSchema.version)
            XCTAssertTrue("\(error)".contains("newer version of Juno"))
        }
    }

    func testRefusesNonDocuments() {
        XCTAssertThrowsError(try DesignDocumentCodec.decode(Data("not json".utf8))) { error in
            XCTAssertEqual(error as? DesignDocumentCodec.Failure, .notJSON)
        }
        XCTAssertThrowsError(try DesignDocumentCodec.decode(Data(#"{"hello":"world"}"#.utf8))) { error in
            XCTAssertEqual(error as? DesignDocumentCodec.Failure, .notADocument)
        }
    }

    func testHierarchyValidationMirrorsTheWebsite() throws {
        var document = try DesignDocumentCodec.load(fixtureData())
        XCTAssertEqual(DesignDocumentCodec.validateHierarchy(document), [])

        // A child that claims a different parent.
        var orphan = document
        orphan.nodes["title"]?.parentId = "screen"
        XCTAssertTrue(DesignDocumentCodec.validateHierarchy(orphan).contains { $0.contains("claims parent") })

        // A dangling child reference.
        document.nodes["card"]?.children?.append("ghost")
        XCTAssertTrue(DesignDocumentCodec.validateHierarchy(document).contains { $0.contains("missing child") })
    }

    func testRefusesAMalformedNode() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any])
        var nodes = try XCTUnwrap(object["nodes"] as? [String: Any])
        var text = try XCTUnwrap(nodes["buttonLabel"] as? [String: Any])
        text.removeValue(forKey: "characters")
        nodes["buttonLabel"] = text
        object["nodes"] = nodes

        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try DesignDocumentCodec.load(data)) { error in
            guard case DesignDocumentCodec.Failure.invalid(let reason) = error else {
                return XCTFail("expected .invalid, got \(error)")
            }
            XCTAssertTrue(reason.contains("characters"), reason)
        }
    }
}
