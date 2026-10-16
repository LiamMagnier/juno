// Wave-2 snapshot support (spec §9 "Bubble and composer parity", P0 (5) and
// (7)), shared by the macOS and iOS test targets. This file is byte-identical
// in native/macOS/JunoDesktop/Tests/Snapshots/Support and
// native/iOS/JunoMobile/Tests/Snapshots/Support;
// tests/wave2-p0-native-support.test.ts fails if they drift.

import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// One native context's bubble and composer geometry, in the JSON shape the
/// web parity gate reads (e2e/support/parity.ts `GeometryRecord`).
///
/// The surface packages fill it from their real components (P2/P3 for the
/// shared bubble and composer, P8/P9/P10 per surface) and write it from a
/// snapshot test; the parity gate compares every context with the spec:
/// bubble radii 12/12/12/8 with the 8 on the logical end-end corner, the
/// user-bubble fill, composer radius 22 and a radius-12 disc.
struct Wave2Geometry: Codable, Equatable, Sendable {
    struct Radii: Codable, Equatable, Sendable {
        var startStart: Double
        var startEnd: Double
        var endEnd: Double
        var endStart: Double
    }

    struct Bubble: Codable, Equatable, Sendable {
        var radii: Radii
        /// The fill the component actually draws, as #RRGGBB.
        var fill: String?
        /// The user-bubble token in the same appearance, as #RRGGBB.
        var tokenFill: String?
    }

    struct Composer: Codable, Equatable, Sendable {
        var radius: Double
    }

    struct Disc: Codable, Equatable, Sendable {
        var radius: Double
        var size: Double?
    }

    /// e.g. "macos-chat", "ios-code".
    var context: String
    var platform: String
    var bubble: Bubble?
    var composer: Composer?
    var disc: Disc?

    static var currentPlatform: String {
        #if os(macOS)
        "macos"
        #else
        "ios"
        #endif
    }
}

enum Wave2GeometryExport {
    /// `ALEVR_NATIVE_GEOMETRY_DIR`, which scripts/qa/native-perf.sh sets via
    /// `TEST_RUNNER_ALEVR_NATIVE_GEOMETRY_DIR`. Unset in an ordinary run.
    static var directory: URL? {
        ProcessInfo.processInfo.environment["ALEVR_NATIVE_GEOMETRY_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    /// Writes `<dir>/<context>.json`; nil when no directory is configured.
    @discardableResult
    static func write(_ geometry: Wave2Geometry, into directory: URL? = Wave2GeometryExport.directory) throws -> URL? {
        guard let directory else { return nil }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safe = geometry.context.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" }
        let url = directory.appendingPathComponent(String(safe) + ".json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(geometry).write(to: url)
        return url
    }

    /// A SwiftUI colour as #RRGGBB in sRGB, resolved for a light or dark appearance.
    @MainActor
    static func hex(_ color: Color, dark: Bool) -> String? {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        #if os(macOS)
        var resolved: NSColor?
        NSAppearance(named: dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance {
            resolved = NSColor(color).usingColorSpace(.sRGB)
        }
        guard let resolved else { return nil }
        red = resolved.redComponent
        green = resolved.greenComponent
        blue = resolved.blueComponent
        #else
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        var alpha: CGFloat = 0
        guard UIColor(color).resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
        #endif
        let byte = { (value: CGFloat) in Int((min(1, max(0, value)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
    }
}
