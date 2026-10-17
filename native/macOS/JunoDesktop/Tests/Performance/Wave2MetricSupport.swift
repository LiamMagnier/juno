// Wave-2 native performance support (spec §9, P0 (7)), shared by the macOS
// and iOS test targets. This file is byte-identical in
// native/macOS/JunoDesktop/Tests/Performance and
// native/iOS/JunoMobile/Tests/Performance; tests/wave2-p0-native-support.test.ts
// fails if they drift.

import Foundation
import os
import XCTest

extension XCTestCase {
    /// Runs `block` under `XCTMemoryMetric` (the value Xcode shows and
    /// baselines in the xcresult) and also samples `phys_footprint` after
    /// each iteration, so the run leaves a JSON record the gate registry reads
    /// (`gate` is a budgets.ts id such as "mac.idle-rss", or nil for a probe).
    ///
    /// Returns the footprint samples in MB.
    @discardableResult
    func wave2MeasureMemory(
        name: String,
        gate: String? = nil,
        iterations: Int = 5,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ block: () -> Void
    ) -> [Double] {
        var samples: [Double] = []
        let options = XCTMeasureOptions()
        options.iterationCount = iterations
        measure(metrics: [XCTMemoryMetric()], options: options) {
            block()
            if let megabytes = Wave2Memory.physicalFootprintMegabytes() { samples.append(megabytes) }
        }
        do {
            try Wave2PerfReport.write(Wave2PerfReport.record(name: name, gate: gate, unit: "MB", samples: samples, test: self.name))
        } catch {
            XCTFail("Could not write the perf report for \(name): \(error)", file: file, line: line)
        }
        return samples
    }

    /// Runs `block` under `XCTOSSignpostMetric` for the interval the code
    /// under test emits (subsystem, category, name), and records each
    /// iteration's wall-clock duration in ms as the JSON sample.
    @discardableResult
    func wave2MeasureSignpost(
        name: String,
        gate: String? = nil,
        subsystem: String,
        category: String,
        signpost: StaticString,
        iterations: Int = 5,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ block: () -> Void
    ) -> [Double] {
        var samples: [Double] = []
        let options = XCTMeasureOptions()
        options.iterationCount = iterations
        let clock = ContinuousClock()
        let metric = XCTOSSignpostMetric(subsystem: subsystem, category: category, name: "\(signpost)")
        measure(metrics: [metric], options: options) {
            let elapsed = clock.measure { block() }
            let parts = elapsed.components
            samples.append(Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15)
        }
        do {
            try Wave2PerfReport.write(Wave2PerfReport.record(name: name, gate: gate, unit: "ms", samples: samples, test: self.name))
        } catch {
            XCTFail("Could not write the perf report for \(name): \(error)", file: file, line: line)
        }
        return samples
    }
}

/// Emits the signpost intervals `wave2MeasureSignpost` measures. App code
/// uses its own `OSSignposter`; tests and probes can use this one.
struct Wave2Signposter: Sendable {
    let signposter: OSSignposter

    init(subsystem: String, category: String) {
        signposter = OSSignposter(subsystem: subsystem, category: category)
    }

    func interval<T>(_ name: StaticString, _ body: () throws -> T) rethrows -> T {
        let state = signposter.beginInterval(name, id: signposter.makeSignpostID())
        defer { signposter.endInterval(name, state) }
        return try body()
    }
}
