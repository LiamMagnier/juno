import Foundation

/// Breadth-first traversal with bounded memory and time for cyclic or huge
/// accessibility trees. Individual IPC calls must also have a timeout.
struct BoundedAXTraversal<Node: Hashable> {
    enum Completion: Equatable { case complete, nodeLimit, timeLimit }
    var maximumNodes = 1_500
    var timeLimit: Duration = .seconds(3)
    var now: () -> ContinuousClock.Instant = { ContinuousClock.now }
    var checkCancellation: () throws -> Void = { try Task.checkCancellation() }

    func walk(root: Node, maxDepth: Int, visit: (Node, Int) throws -> [Node]) throws -> Completion {
        let deadline = now().advanced(by: timeLimit)
        var queue = [(root, 0)]
        var seen: Set<Node> = [root]
        var cursor = 0
        var limited = false
        while cursor < queue.count {
            try checkCancellation()
            guard now() < deadline else { return .timeLimit }
            let (node, depth) = queue[cursor]
            cursor += 1
            let children = try visit(node, depth)
            guard depth < maxDepth else { continue }
            for child in children {
                guard !seen.contains(child) else { continue }
                guard queue.count < maximumNodes else { limited = true; continue }
                seen.insert(child)
                queue.append((child, depth + 1))
            }
        }
        return limited ? .nodeLimit : .complete
    }
}
