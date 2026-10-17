// Wave-2 native performance support (spec §9, P0 (7)), shared by the macOS
// and iOS test targets. This file is byte-identical in
// native/macOS/JunoDesktop/Tests/Performance and
// native/iOS/JunoMobile/Tests/Performance; tests/wave2-p0-native-support.test.ts
// fails if they drift.

import Foundation
import XCTest

/// The P0 acceptance sample: an `XCTMemoryMetric` run that reports a value.
///
/// It measures this test process allocating and touching 8MB per iteration,
/// which is enough to move `phys_footprint`. It is not a §9 gate (gate: nil),
/// so the registry ignores its JSON; Xcode still shows the metric and its
/// baseline in the xcresult. scripts/qa/native-perf.sh runs it with the other
/// `*PerformanceTests` suites on a Release build.
final class Wave2SamplePerformanceTests: XCTestCase {
    func testMemoryMetricReportsAValue() {
        let iterations = 5
        var retained: [[UInt8]] = []
        let samples = wave2MeasureMemory(name: "wave2-sample-memory", gate: nil, iterations: iterations) {
            var block = [UInt8](repeating: 0, count: 8 * 1_048_576)
            for index in stride(from: 0, to: block.count, by: 4096) { block[index] = 1 }
            retained.append(block)
        }
        XCTAssertGreaterThanOrEqual(samples.count, iterations, "every iteration recorded a footprint")
        XCTAssertTrue(samples.allSatisfy { $0 > 0 }, "the footprint is a positive number of MB: \(samples)")
        XCTAssertNotNil(Wave2Stats.percentile(samples, 95))
        retained.removeAll()
    }

    func testSignpostMetricReportsAValue() {
        let signposter = Wave2Signposter(subsystem: "com.alevr.qa", category: "wave2")
        let samples = wave2MeasureSignpost(
            name: "wave2-sample-signpost",
            subsystem: "com.alevr.qa",
            category: "wave2",
            signpost: "sample",
            iterations: 3
        ) {
            signposter.interval("sample") {
                _ = (0..<50_000).reduce(0, &+)
            }
        }
        XCTAssertGreaterThanOrEqual(samples.count, 3)
        XCTAssertTrue(samples.allSatisfy { $0 >= 0 })
    }
}
