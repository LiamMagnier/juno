import Foundation
import JunoDesignSystem
import SwiftUI
import Testing
import UIKit

/// Regression tests for the iOS snapshot support: the matrix it renders, the
/// environment each variant applies, and the geometry JSON the web parity
/// gate reads.
@MainActor
struct Wave2SnapshotSupportTests {
    @Test func variantsAreTheSpecMatrix() {
        #expect(Wave2SnapshotVariant.allCases == [.light, .dark, .increaseContrast, .reduceTransparency, .ax3])
        let files = Wave2SnapshotVariant.allCases.map { $0.fileName("bubble") }
        #expect(Set(files).count == files.count)
        #expect(Wave2SnapshotVariant.ax3.dynamicTypeSize == .accessibility3)
        #expect(Wave2SnapshotVariant.ax3.contentSizeCategory == .accessibilityExtraLarge)
    }

    @Test(arguments: Wave2SnapshotVariant.allCases)
    func environmentAppliesTheVariant(_ variant: Wave2SnapshotVariant) {
        let seen = Wave2EnvironmentBox()
        let renderer = ImageRenderer(content: Wave2EnvironmentProbe(box: seen).wave2Snapshot(variant).frame(width: 8, height: 8))
        _ = renderer.uiImage
        #expect(seen.dynamicTypeSize == (variant == .ax3 ? .accessibility3 : .large))
        #expect(seen.contrast == (variant == .increaseContrast ? .increased : .standard))
        #expect(seen.reducesTransparency == (variant == .reduceTransparency))
        #expect(seen.colorScheme == (variant == .dark ? .dark : .light))
        #expect(seen.opaqueGlass)
    }

    @Test func geometryExportWritesTheParityGateShape() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wave2-geometry-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let geometry = Wave2Geometry(
            context: "ios-chat",
            platform: Wave2Geometry.currentPlatform,
            bubble: .init(radii: .init(startStart: 12, startEnd: 12, endEnd: 8, endStart: 12), fill: "#EFF0F1", tokenFill: "#EFF0F1"),
            composer: .init(radius: 22),
            disc: .init(radius: 12, size: 36)
        )
        let url = try #require(try Wave2GeometryExport.write(geometry, into: directory))
        #expect(url.lastPathComponent == "ios-chat.json")
        #expect(try JSONDecoder().decode(Wave2Geometry.self, from: Data(contentsOf: url)) == geometry)
        let object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        #expect(object["platform"] as? String == "ios")
        #expect(try Wave2GeometryExport.write(geometry, into: nil) == nil)
    }

    @Test func hexResolvesColoursInBothAppearances() {
        #expect(Wave2GeometryExport.hex(Color(red: 1, green: 0, blue: 0), dark: false) == "#FF0000")
        #expect(Wave2GeometryExport.hex(Color(red: 0, green: 0, blue: 1), dark: true) == "#0000FF")
    }
}

/// Renders the matrix for real when JUNO_SNAPSHOT_DIR is set (native-perf.sh
/// --suite snapshots), like the other suites.
@MainActor
@Suite(
    .enabled(if: Wave2Snapshot.directory != nil, "Set JUNO_SNAPSHOT_DIR to render the wave-2 matrix sample."),
    .serialized
)
struct Wave2SupportSnapshotTests {
    @Test func rendersEveryVariant() async throws {
        let sample = VStack {
            Spacer()
            HStack {
                Spacer()
                Text("The one bubble, in every variant")
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(
                        UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12, bottomTrailingRadius: 8, topTrailingRadius: 12)
                            .fill(Color.secondary.opacity(0.15))
                    )
            }
            .padding(16)
        }
        let shots = try await Wave2Snapshot.render(sample, name: "wave2-matrix-sample")
        #expect(shots.count == Wave2SnapshotVariant.allCases.count)
    }
}

final class Wave2EnvironmentBox {
    var dynamicTypeSize: DynamicTypeSize?
    var contrast: ColorSchemeContrast?
    var reducesTransparency: Bool?
    var colorScheme: ColorScheme?
    var opaqueGlass = false
}

private struct Wave2EnvironmentProbe: View {
    let box: Wave2EnvironmentBox
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reducesTransparency
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.junoSnapshotOpaqueGlass) private var opaqueGlass

    var body: some View {
        box.dynamicTypeSize = dynamicTypeSize
        box.contrast = contrast
        box.reducesTransparency = reducesTransparency
        box.colorScheme = colorScheme
        box.opaqueGlass = opaqueGlass
        return Color.clear
    }
}
