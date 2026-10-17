import Foundation
import SwiftUI
import UIKit

/// Renders a view in every iOS matrix variant (``Wave2SnapshotVariant``) in a
/// real window of the test host's scene, the way JunoMobileOwnerSnapshotTests
/// does, so UIKit-backed pieces draw for real.
@MainActor
enum Wave2Snapshot {
    enum Failure: Error, CustomStringConvertible {
        case noScene
        case blank(String)

        var description: String {
            switch self {
            case .noScene: "The test host has no window scene to render into."
            case .blank(let name): "\(name) rendered blank."
            }
        }
    }

    /// iPhone 14/15/16 points, the size of the web's 390×844 phone project.
    static let phone = CGSize(width: 390, height: 844)

    /// `$JUNO_SNAPSHOT_DIR/wave2`; nil when unset, so a suite can
    /// `.enabled(if:)` on it like the others do.
    nonisolated static var directory: URL? {
        ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"].map {
            URL(fileURLWithPath: $0, isDirectory: true).appendingPathComponent("wave2", isDirectory: true)
        }
    }

    /// Renders `view` once per variant and returns the PNG data by variant;
    /// with a directory, also writes `ios-<name>-<variant>.png` there.
    @discardableResult
    static func render<V: View>(
        _ view: V,
        name: String,
        size: CGSize = Wave2Snapshot.phone,
        variants: [Wave2SnapshotVariant] = Wave2SnapshotVariant.allCases,
        settle: Duration = .milliseconds(300),
        into directory: URL? = Wave2Snapshot.directory
    ) async throws -> [Wave2SnapshotVariant: Data] {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            throw Failure.noScene
        }
        var out: [Wave2SnapshotVariant: Data] = [:]
        for variant in variants {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(origin: .zero, size: size)
            window.overrideUserInterfaceStyle = variant.interfaceStyle
            window.traitOverrides.accessibilityContrast = variant.accessibilityContrast
            window.traitOverrides.preferredContentSizeCategory = variant.contentSizeCategory
            window.rootViewController = UIHostingController(rootView: view.wave2Snapshot(variant))
            window.isHidden = false
            try await Task.sleep(for: settle)
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            window.isHidden = true
            window.rootViewController = nil
            guard let data = image.pngData(), data.count > 1_000 else { throw Failure.blank(variant.fileName(name)) }
            out[variant] = data
            if let directory {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: directory.appendingPathComponent(variant.fileName(name)))
            }
        }
        return out
    }
}
