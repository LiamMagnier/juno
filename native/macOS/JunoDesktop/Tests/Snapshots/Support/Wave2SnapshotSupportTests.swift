import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI
import Testing

/// Regression tests for the macOS snapshot support: the matrix it renders,
/// the environment each variant applies, and the geometry JSON the web parity
/// gate reads.
@MainActor
struct Wave2SnapshotSupportTests {
    @Test func variantsAreTheSpecMatrix() {
        #expect(Wave2SnapshotVariant.allCases == [.light, .dark, .xxl, .increaseContrast, .reduceTransparency])
        let stems = Wave2SnapshotVariant.allCases.map { "\($0.fileStem("bubble"))-\($0.isDark ? "dark" : "light")" }
        #expect(Set(stems).count == stems.count, "every variant writes its own file: \(stems)")
        #expect(stems.contains("bubble-xxl-light"))
    }

    @Test(arguments: Wave2SnapshotVariant.allCases)
    func environmentAppliesTheVariant(_ variant: Wave2SnapshotVariant) {
        let seen = Wave2EnvironmentBox()
        let renderer = ImageRenderer(content: Wave2EnvironmentProbe(box: seen).wave2Snapshot(variant).frame(width: 8, height: 8))
        _ = renderer.nsImage
        #expect(seen.scale == (variant == .xxl ? 1.25 : 1))
        #expect(seen.contrast == (variant == .increaseContrast ? .increased : .standard))
        #expect(seen.reducesTransparency == (variant == .reduceTransparency))
        #expect(seen.colorScheme == (variant == .dark ? .dark : .light))
        #expect(seen.opaqueGlass)
    }

    @Test func xxlEnlargesTheRenderedSample() throws {
        let regular = ImageRenderer(content: Wave2MatrixSampleBubble().fixedSize().wave2Snapshot(.light))
        let enlarged = ImageRenderer(content: Wave2MatrixSampleBubble().fixedSize().wave2Snapshot(.xxl))
        let regularSize = try #require(regular.nsImage).size
        let enlargedSize = try #require(enlarged.nsImage).size
        #expect(enlargedSize.width > regularSize.width * 1.1)
        #expect(enlargedSize.height > regularSize.height)
    }

    @Test func geometryExportWritesTheParityGateShape() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wave2-geometry-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let geometry = Wave2Geometry(
            context: "macos-chat",
            platform: Wave2Geometry.currentPlatform,
            bubble: .init(radii: .init(startStart: 12, startEnd: 12, endEnd: 8, endStart: 12), fill: "#EFF0F1", tokenFill: "#EFF0F1"),
            composer: .init(radius: 22),
            disc: .init(radius: 12, size: 36)
        )
        let url = try #require(try Wave2GeometryExport.write(geometry, into: directory))
        #expect(url.lastPathComponent == "macos-chat.json")
        #expect(try JSONDecoder().decode(Wave2Geometry.self, from: Data(contentsOf: url)) == geometry)
        let object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        #expect(object["platform"] as? String == "macos")
        let radii = (object["bubble"] as? [String: Any])?["radii"] as? [String: Double]
        #expect(radii?["endEnd"] == 8)
        #expect(try Wave2GeometryExport.write(geometry, into: nil) == nil)
    }

    @Test func hexResolvesColoursInBothAppearances() {
        #expect(Wave2GeometryExport.hex(Color(red: 1, green: 0, blue: 0), dark: false) == "#FF0000")
        #expect(Wave2GeometryExport.hex(Color(red: 0, green: 0, blue: 1), dark: true) == "#0000FF")
    }
}

/// Renders the matrix for real when JUNO_SNAPSHOT_DIR is set (native-perf.sh
/// --suite snapshots, or npm run native:snapshots:*), like the other suites.
@MainActor
@Suite(
    .enabled(if: Wave2Snapshot.directory != nil, "Set JUNO_SNAPSHOT_DIR to render the wave-2 matrix sample."),
    .serialized
)
struct Wave2SupportSnapshotTests {
    @Test func rendersEveryVariant() async throws {
        let directory = try #require(Wave2Snapshot.directory)
        let sample = HStack {
            Spacer()
            Wave2MatrixSampleBubble()
        }
        .padding(24)
        let urls = try await Wave2Snapshot.render(sample, name: "wave2-matrix-sample", width: 480, into: directory)
        #expect(urls.count == Wave2SnapshotVariant.allCases.count)
        for url in urls { #expect(FileManager.default.fileExists(atPath: url.path)) }
    }
}

private struct Wave2MatrixSampleBubble: View {
    var body: some View {
        Text("The one bubble, in every variant")
            .junoType(.body)
            .junoMatrixSampleBubble()
    }
}

private extension View {
    /// A stand-in bubble (12/12/12/8, a tonal fill) for the sample only; the
    /// real one is JunoUserBubble (P3).
    func junoMatrixSampleBubble() -> some View {
        padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12, bottomTrailingRadius: 8, topTrailingRadius: 12)
                    .fill(Color.secondary.opacity(0.15))
            )
    }
}

final class Wave2EnvironmentBox {
    var scale: CGFloat = -1
    var contrast: ColorSchemeContrast?
    var reducesTransparency: Bool?
    var colorScheme: ColorScheme?
    var opaqueGlass = false
}

private struct Wave2EnvironmentProbe: View {
    let box: Wave2EnvironmentBox
    @Environment(\.junoTextScale) private var scale
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reducesTransparency
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.junoSnapshotOpaqueGlass) private var opaqueGlass

    var body: some View {
        box.scale = scale
        box.contrast = contrast
        box.reducesTransparency = reducesTransparency
        box.colorScheme = colorScheme
        box.opaqueGlass = opaqueGlass
        return Color.clear
    }
}
