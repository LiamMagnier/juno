import XCTest
@testable import JunoScreenControl

final class ObservationReliabilityTests: XCTestCase {
    func testExtremeCoordinatesAreClampedOrReportedWithoutIntegerTraps() {
        let geometry = FrameGeometry(
            origin: ScreenPoint(x: 0, y: 0), pointWidth: 800, pointHeight: 600,
            backingScale: 2, scale: 1, frameSize: PixelSize(width: 1600, height: 1200)
        )
        let rect = geometry.sourcePixelRect(frameRegion: [0, 0, 1e100, 1e100])
        XCTAssertEqual(rect?.width, 1600)
        XCTAssertEqual(rect?.height, 1200)
        XCTAssertNil(geometry.sourcePixelRect(frameRegion: [.nan, 0, 100, 100]))
        XCTAssertFalse(ScreenControlError.coordinateOutOfFrame(x: 1e100, y: .infinity, frame: geometry.frameSize).errorDescription!.isEmpty)
        let element = AXElementInfo(id: "e1", role: "AXButton", frame: ScreenRect(x: .infinity, y: 0, width: 10, height: 10))
        XCTAssertTrue(element.line(in: geometry).contains("bounds unavailable"))
    }

    func testTraversalHandlesCyclesAndKeepsBreadthFirstOrder() throws {
        var visited: [Int] = []
        let graph = [0: [1, 2, 1], 1: [0, 3], 2: [3], 3: [0]]
        let result = try BoundedAXTraversal<Int>().walk(root: 0, maxDepth: 12) { node, _ in
            visited.append(node)
            return graph[node] ?? []
        }
        XCTAssertEqual(result, .complete)
        XCTAssertEqual(visited, [0, 1, 2, 3])
    }

    func testTraversalBoundsWideTreesAndRespectsDepth() throws {
        var walker = BoundedAXTraversal<Int>()
        walker.maximumNodes = 4
        var visited: [Int] = []
        let result = try walker.walk(root: 0, maxDepth: 2) { node, _ in
            visited.append(node)
            return node == 0 ? Array(1...10_000) : []
        }
        XCTAssertEqual(result, .nodeLimit)
        XCTAssertEqual(visited, [0, 1, 2, 3])
        visited = []
        let shallow = try walker.walk(root: 0, maxDepth: 0) { node, _ in
            visited.append(node)
            return [node + 1]
        }
        XCTAssertEqual(shallow, .complete)
        XCTAssertEqual(visited, [0])
    }

    func testSlowTraversalReturnsPartialAndCancellationThrows() throws {
        var instant = ContinuousClock.now
        var walker = BoundedAXTraversal<Int>()
        walker.timeLimit = .seconds(1)
        walker.now = { instant }
        var visited: [Int] = []
        let result = try walker.walk(root: 0, maxDepth: 20) { node, _ in
            visited.append(node)
            instant = instant.advanced(by: .milliseconds(600))
            return [node + 1]
        }
        XCTAssertEqual(result, .timeLimit)
        XCTAssertEqual(visited, [0, 1])
        walker.checkCancellation = { throw CancellationError() }
        XCTAssertThrowsError(try walker.walk(root: 0, maxDepth: 1) { _, _ in [] }) {
            XCTAssertTrue($0 is CancellationError)
        }
        let partial = AXSnapshot(bundleID: "test", appName: "Test", windowTitle: nil, elements: [], truncationReason: "read budget exceeded")
        XCTAssertTrue(partial.text(in: nil, filter: .all).contains("Partial accessibility tree"))
    }

    private actor Loader {
        var calls = 0
        var pending: [CheckedContinuation<Int, Never>] = []
        var observers: [(Int, CheckedContinuation<Void, Never>)] = []
        func load() async -> Int {
            calls += 1
            return await withCheckedContinuation { continuation in
                pending.append(continuation)
                let ready = observers.filter { $0.0 <= calls }
                observers.removeAll { $0.0 <= calls }
                for (_, observer) in ready { observer.resume() }
            }
        }
        func waitForCalls(_ count: Int) async {
            if calls >= count { return }
            await withCheckedContinuation { observers.append((count, $0)) }
        }
        func finish(_ index: Int, _ value: Int) { pending[index].resume(returning: value) }
    }

    func testConcurrentCaptureDiscoveryIsSharedAndInvalidationRefreshes() async throws {
        let loader = Loader()
        let cache = CaptureContentCache { await loader.load() }
        let first = Task { try await cache.value() }
        let second = Task { try await cache.value() }
        await loader.waitForCalls(1)
        await loader.finish(0, 10)
        let values = try await [first.value, second.value]
        XCTAssertEqual(values, [10, 10])
        let cached = try await cache.value()
        XCTAssertEqual(cached, 10)
        let calls = await loader.calls
        XCTAssertEqual(calls, 1)
        await cache.invalidate()
        let refreshed = Task { try await cache.value() }
        await loader.waitForCalls(2)
        await loader.finish(1, 20)
        let fresh = try await refreshed.value
        XCTAssertEqual(fresh, 20)
    }

    func testInvalidatedInFlightDiscoveryCannotOverwriteNewContent() async throws {
        let loader = Loader()
        let cache = CaptureContentCache { await loader.load() }
        let old = Task { try await cache.value() }
        await loader.waitForCalls(1)
        await cache.invalidate()
        let new = Task { try await cache.value() }
        await loader.waitForCalls(2)
        await loader.finish(1, 20)
        _ = try await new.value
        await loader.finish(0, 10)
        _ = try await old.value
        let cached = try await cache.value()
        XCTAssertEqual(cached, 20)
    }

    func testExpiredAndFailedDiscoveryCanBeLoadedAgain() async throws {
        actor Counter {
            var calls = 0
            func load() throws -> Int {
                calls += 1
                if calls == 1 { throw CancellationError() }
                return calls
            }
        }
        let counter = Counter()
        let cache = CaptureContentCache(lifetime: .zero) { try await counter.load() }
        do {
            _ = try await cache.value()
            XCTFail("the loader failure was swallowed")
        } catch { XCTAssertTrue(error is CancellationError) }
        let second = try await cache.value()
        let third = try await cache.value()
        XCTAssertEqual(second, 2)
        XCTAssertEqual(third, 3)
    }
}
