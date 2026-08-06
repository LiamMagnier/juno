import XCTest
@testable import JunoDesignKit

/// A design written before the effect stack still opens on the Mac.
///
/// `shadows`, `blur` and `noise` were three separate node properties until they
/// became one ordered `effects` list. Documents written under the old shape are
/// in people's accounts right now, and the Mac decodes a stored artifact body
/// directly — it does not pass through the website's parser — so if this fold
/// were missing, every pre-existing design would open with its shadows and
/// blurs silently gone. That reads as a rendering bug and is data loss.
///
/// The order is the one the old renderer used, so a folded document draws what
/// it always drew rather than being quietly rearranged.
final class DesignLegacyEffectsTests: XCTestCase {
    private func node(_ extra: String) throws -> DesignNode {
        // Built from the shape the real fixture writes, so this exercises the
        // fold rather than an incomplete node the decoder would reject first.
        let json = """
        {"id":"r","type":"rectangle","name":"R","parentId":null,"x":0,"y":0,
         "width":10,"height":10,"rotation":0,"opacity":1,"visible":true,"locked":false,
         "blendMode":"normal","fills":[],"strokes":[],"cornerRadius":0,
         "constraints":{"horizontal":"min","vertical":"min"},
         "widthMode":"fixed","heightMode":"fixed","boundVariables":{},
         "layoutChild":{"absolute":false,"grow":false},"limits":{},\(extra)}
        """
        return try JSONDecoder().decode(DesignNode.self, from: Data(json.utf8))
    }

    func testABlurAGrainAndTwoShadowsFoldInTheOrderTheOldRendererUsed() throws {
        let decoded = try node("""
        "blur":{"type":"background","radius":12,"saturation":1.4},
        "noise":{"opacity":0.2,"density":0.8,"seed":3,"monochrome":true,"blend":"overlay"},
        "shadows":[
          {"type":"drop","color":{"r":0,"g":0,"b":0,"a":0.2},"offsetX":0,"offsetY":8,"blur":24,"spread":-4},
          {"type":"inner","color":{"r":1,"g":1,"b":1,"a":0.5},"offsetX":0,"offsetY":1,"blur":0,"spread":0}
        ]
        """)

        XCTAssertEqual(decoded.effects.count, 4)
        guard case .backgroundBlur(let blur) = decoded.effects[0] else {
            return XCTFail("the backdrop blur is applied first, as it was")
        }
        XCTAssertEqual(blur.radius, 12)
        XCTAssertEqual(blur.saturation, 1.4)
        guard case .noise(let grain) = decoded.effects[1] else { return XCTFail("grain second") }
        XCTAssertEqual(grain.blend, .overlay)
        guard case .dropShadow = decoded.effects[2] else { return XCTFail("shadows in stored order") }
        guard case .innerShadow = decoded.effects[3] else { return XCTFail("inner shadow last") }
    }

    func testAStoredEffectStackIsNotFoldedOver() throws {
        // A document already in the new shape must be taken at its word, even if
        // a stale legacy key rides along beside it.
        let decoded = try node("""
        "effects":[{"type":"layer-blur","radius":4}],
        "shadows":[{"type":"drop","color":{"r":0,"g":0,"b":0,"a":1},"offsetX":0,"offsetY":0,"blur":1,"spread":0}]
        """)
        XCTAssertEqual(decoded.effects.count, 1)
        guard case .layerBlur = decoded.effects[0] else { return XCTFail("kept the stored stack") }
    }

    func testANodeWithNoEffectsAtAllDecodes() throws {
        XCTAssertEqual(try node("\"effects\":[]").effects, [])
    }
}
