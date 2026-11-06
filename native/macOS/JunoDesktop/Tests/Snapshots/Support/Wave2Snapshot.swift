import AppKit
import Foundation
import SwiftUI

/// Renders a view in every macOS matrix variant (``Wave2SnapshotVariant``).
@MainActor
enum Wave2Snapshot {
    /// `$JUNO_SNAPSHOT_DIR/wave2`, the directory scripts/qa/native-perf.sh and
    /// the existing snapshot script point the suites at; nil when unset, so a
    /// snapshot suite can `.enabled(if:)` on it like the others do.
    nonisolated static var directory: URL? {
        ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"].map {
            URL(fileURLWithPath: $0, isDirectory: true).appendingPathComponent("wave2", isDirectory: true)
        }
    }

    @discardableResult
    static func render<V: View>(
        _ view: V,
        name: String,
        width: CGFloat = TranscriptSnapshotRenderer.columnWidth,
        variants: [Wave2SnapshotVariant] = Wave2SnapshotVariant.allCases,
        into dir: URL
    ) async throws -> [URL] {
        var urls: [URL] = []
        for variant in variants {
            let url = try await TranscriptSnapshotRenderer.render(
                view.wave2Snapshot(variant),
                name: variant.fileStem(name),
                width: width,
                appearance: variant.appearance,
                into: dir
            )
            urls.append(url)
        }
        return urls
    }
}
