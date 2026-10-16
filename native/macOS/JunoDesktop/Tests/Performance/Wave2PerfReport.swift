// Wave-2 native performance support (spec §9, P0 (7)), shared by the macOS
// and iOS test targets. This file is byte-identical in
// native/macOS/JunoDesktop/Tests/Performance and
// native/iOS/JunoMobile/Tests/Performance; tests/wave2-p0-native-support.test.ts
// fails if they drift.

import Darwin
import Foundation

/// The process's memory as Xcode's memory gauge and `XCTMemoryMetric` count it:
/// `phys_footprint` from `task_vm_info`.
enum Wave2Memory {
    /// Bytes, or nil if the kernel refused the query.
    static func physicalFootprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), raw, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return info.phys_footprint
    }

    static func physicalFootprintMegabytes() -> Double? {
        physicalFootprintBytes().map { Double($0) / 1_048_576 }
    }
}

/// p50/p95 with the same linear interpolation the web harness uses
/// (e2e/support/perf-marks.ts), so a native and a web p95 mean the same thing.
enum Wave2Stats {
    static func percentile(_ samples: [Double], _ p: Double) -> Double? {
        guard !samples.isEmpty, (0...100).contains(p), samples.allSatisfy(\.isFinite) else { return nil }
        let sorted = samples.sorted()
        let rank = p / 100 * Double(sorted.count - 1)
        let lower = Int(rank.rounded(.down))
        let upper = Int(rank.rounded(.up))
        if lower == upper { return sorted[lower] }
        return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - Double(lower))
    }
}

/// One measurement as the gate registry reads it (`scripts/qa/gates.ts
/// evaluate`): a gate id from e2e/support/budgets.ts plus raw samples. The
/// registry applies the budget, so the budget lives in one place.
struct Wave2PerfRecord: Codable, Equatable, Sendable {
    struct Measurement: Codable, Equatable, Sendable {
        var samples: [Double]
        var unit: String
        var detail: String?
    }

    var name: String
    /// Nil for a measurement that is not a §9 gate (a sample or a probe); the
    /// registry ignores those.
    var gate: String?
    var measurement: Measurement
    var p50: Double?
    var p95: Double?
    var test: String
    var platform: String
    var recordedAt: String
}

enum Wave2PerfReport {
    /// `ALEVR_PERF_REPORT_DIR`, which scripts/qa/native-perf.sh sets through
    /// `TEST_RUNNER_ALEVR_PERF_REPORT_DIR`. Unset in an ordinary test run.
    static var directory: URL? {
        ProcessInfo.processInfo.environment["ALEVR_PERF_REPORT_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    static var platform: String {
        #if os(macOS)
        "macos"
        #else
        "ios"
        #endif
    }

    static func record(name: String, gate: String?, unit: String, samples: [Double], test: String, detail: String? = nil) -> Wave2PerfRecord {
        Wave2PerfRecord(
            name: name,
            gate: gate,
            measurement: .init(samples: samples, unit: unit, detail: detail),
            p50: Wave2Stats.percentile(samples, 50),
            p95: Wave2Stats.percentile(samples, 95),
            test: test,
            platform: platform,
            recordedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    /// Writes `<dir>/<name>.json` and returns it; returns nil when no report
    /// directory is configured (an ordinary unit-test run).
    @discardableResult
    static func write(_ record: Wave2PerfRecord, into directory: URL? = Wave2PerfReport.directory) throws -> URL? {
        guard let directory else { return nil }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safe = record.name.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "-" }
        let url = directory.appendingPathComponent(String(safe) + ".json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(record).write(to: url)
        return url
    }
}
