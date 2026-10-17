// Wave-2 native performance support (spec §9, P0 (7)), shared by the macOS
// and iOS test targets. This file is byte-identical in
// native/macOS/JunoDesktop/Tests/Performance and
// native/iOS/JunoMobile/Tests/Performance; tests/wave2-p0-native-support.test.ts
// fails if they drift.

import Foundation
import Testing

/// Regression tests for the helpers themselves: a gate built on a clock that
/// fires early, or a report the registry cannot read, would pass for the
/// wrong reason.
struct Wave2PerformanceSupportTests {
    @Test func clockMovesOnlyWhenAdvanced() async throws {
        let clock = Wave2TestClock()
        let woke = Wave2Flag()
        let sleeper = Task {
            try await clock.sleep(until: clock.now.advanced(by: .seconds(600)))
            woke.set()
        }
        while clock.pendingSleepers == 0 { await Task.yield() }
        clock.advance(by: .seconds(599))
        for _ in 0..<20 { await Task.yield() }
        #expect(!woke.value)
        clock.advance(by: .seconds(1))
        try await sleeper.value
        #expect(woke.value)
        #expect(clock.pendingSleepers == 0)
    }

    @Test func clockWakesSleepersInDeadlineOrder() async throws {
        let clock = Wave2TestClock()
        let order = Wave2Order()
        let late = Task {
            try await clock.sleep(until: clock.now.advanced(by: .seconds(60)))
            order.append(60)
        }
        let early = Task {
            try await clock.sleep(until: clock.now.advanced(by: .seconds(15)))
            order.append(15)
        }
        while clock.pendingSleepers < 2 { await Task.yield() }
        clock.advance(by: .seconds(15))
        try await early.value
        #expect(order.values == [15])
        clock.advance(by: .seconds(45))
        try await late.value
        #expect(order.values == [15, 60])
    }

    @Test func cancellingASleeperThrowsCancellation() async {
        let clock = Wave2TestClock()
        let sleeper = Task { try await clock.sleep(until: clock.now.advanced(by: .seconds(60))) }
        while clock.pendingSleepers == 0 { await Task.yield() }
        sleeper.cancel()
        let result = await sleeper.result
        #expect(throws: CancellationError.self) { try result.get() }
        #expect(clock.pendingSleepers == 0)
    }

    @Test func clockDateFollowsTheOffset() {
        let epoch = Date(timeIntervalSince1970: 1_000)
        let clock = Wave2TestClock(epoch: epoch)
        clock.advance(by: .seconds(120))
        #expect(clock.date == epoch.addingTimeInterval(120))
    }

    @Test func percentilesMatchTheWebHarness() throws {
        let samples = (1...20).map(Double.init)
        #expect(try #require(Wave2Stats.percentile(samples, 50)) == 10.5)
        #expect(abs(try #require(Wave2Stats.percentile(samples, 95)) - 19.05) < 1e-9)
        #expect(Wave2Stats.percentile([], 50) == nil)
        #expect(Wave2Stats.percentile([1, .nan], 50) == nil)
    }

    @Test func occlusionMockStreamsTheCurrentValueThenChanges() async {
        let mock = Wave2OcclusionMock(visible: true)
        let stream = mock.visibilityChanges()
        let reader = Task {
            var seen: [Bool] = []
            for await value in stream {
                seen.append(value)
                if seen.count == 3 { break }
            }
            return seen
        }
        mock.setOccluded(true)
        mock.setOccluded(false)
        let seen = await reader.value
        #expect(seen.first == true)
        #expect(seen.count == 3)
        #expect(mock.transitions == [false, true])
        #expect(mock.isVisible)
    }

    @Test func perfReportWritesARecordTheRegistryCanRead() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wave2-perf-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let record = Wave2PerfReport.record(name: "idle rss/probe", gate: "mac.idle-rss", unit: "MB", samples: [180, 190, 200], test: "probe")
        let url = try #require(try Wave2PerfReport.write(record, into: directory))
        #expect(url.lastPathComponent == "idle-rss-probe.json")
        let decoded = try JSONDecoder().decode(Wave2PerfRecord.self, from: Data(contentsOf: url))
        #expect(decoded == record)
        #expect(decoded.p50 == 190)
        let object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        #expect(object["gate"] as? String == "mac.idle-rss")
        #expect((object["measurement"] as? [String: Any])?["samples"] as? [Double] == [180, 190, 200])
    }

    @Test func perfReportIsSilentWithoutADirectory() throws {
        let record = Wave2PerfReport.record(name: "probe", gate: nil, unit: "MB", samples: [1], test: "probe")
        #expect(try Wave2PerfReport.write(record, into: nil) == nil)
    }

    @Test func memoryFootprintIsReadable() throws {
        let megabytes = try #require(Wave2Memory.physicalFootprintMegabytes())
        #expect(megabytes > 0)
    }
}

/// A thread-safe flag and list for the tests above.
final class Wave2Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.withLock { flag } }
    func set() { lock.withLock { flag = true } }
}

final class Wave2Order: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [Int] = []
    var values: [Int] { lock.withLock { list } }
    func append(_ value: Int) { lock.withLock { list.append(value) } }
}
