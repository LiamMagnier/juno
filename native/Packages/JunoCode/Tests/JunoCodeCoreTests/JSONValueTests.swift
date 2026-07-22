import XCTest
@testable import JunoCodeCore

final class JSONValueTests: XCTestCase {
    func testCodableRoundTrip() throws {
        let value: JSONValue = [
            "name": "read_file",
            "count": 3,
            "ratio": 0.5,
            "enabled": true,
            "nothing": nil,
            "items": ["a", "b"],
        ]
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, value)
        XCTAssertEqual(decoded["name"]?.stringValue, "read_file")
        XCTAssertEqual(decoded["count"]?.intValue, 3)
        XCTAssertEqual(decoded["enabled"]?.boolValue, true)
        XCTAssertEqual(decoded["nothing"]?.isNull, true)
        XCTAssertEqual(decoded["items"]?.arrayValue?.count, 2)
    }

    func testCanonicalEncodingIsDeterministicAndSorted() {
        let first: JSONValue = ["b": 1, "a": "x", "c": [true, nil]]
        let second: JSONValue = ["c": [true, nil], "a": "x", "b": 1]
        XCTAssertEqual(first.canonicalJSONString(), second.canonicalJSONString())
        XCTAssertEqual(first.canonicalJSONString(), "{\"a\":\"x\",\"b\":1,\"c\":[true,null]}")
    }

    func testCanonicalEncodingEscapesControlCharacters() {
        let value: JSONValue = .string("line\nbreak\t\"quoted\"\\\u{01}")
        XCTAssertEqual(
            value.canonicalJSONString(),
            "\"line\\nbreak\\t\\\"quoted\\\"\\\\\\u0001\""
        )
    }

    func testIntValueRejectsFractions() {
        XCTAssertEqual(JSONValue.number(4).intValue, 4)
        XCTAssertNil(JSONValue.number(4.5).intValue)
        XCTAssertNil(JSONValue.string("4").intValue)
    }
}
