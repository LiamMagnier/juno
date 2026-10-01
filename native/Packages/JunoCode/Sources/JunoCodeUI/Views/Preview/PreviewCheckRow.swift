import AppKit
import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// A UI check in the thread (CODE_AGENT_SPEC §4.6): one quiet row per check,
// "Checked /settings at desktop: no errors", with the screenshot Juno kept as
// evidence when it is still on this Mac; failures read in words
// ("/settings: 1 new console error — TypeError: menu is undefined"). No pill,
// no dot: a failed check is said in the danger ink, a passed one in secondary.
//
// Owned by Lane D (Preview and browser).

/// Screenshots kept as evidence this run, by hash (D-022: local, with the
/// session).
final class PreviewEvidenceIndex: @unchecked Sendable {
    static let shared = PreviewEvidenceIndex()
    private let lock = NSLock()
    private var urls: [String: URL] = [:]

    func register(hash: String, url: URL) {
        lock.withLock { urls[hash] = url }
    }

    func url(for hash: String) -> URL? {
        lock.withLock { urls[hash] }
    }
}

struct PreviewCheckRow: View {
    let record: UIVerificationRecord

    var body: some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            if let thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .interpolation(.medium)
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 56, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Studio.Radius.small, style: .continuous)
                            .strokeBorder(Studio.Surface.hairline)
                    )
                    .accessibilityLabel("Screenshot of \(record.target)")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.caption(for: record))
                    .font(Studio.Font.meta)
                    .foregroundStyle(record.passed ? Studio.Ink.secondary : Studio.Ink.danger)
                    .fixedSize(horizontal: false, vertical: true)
                if !record.passed, let detail = Self.secondLine(for: record) {
                    Text(detail)
                        .font(Studio.Font.caption)
                        .foregroundStyle(Studio.Ink.tertiary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, 17)
        .accessibilityElement(children: .combine)
    }

    private var thumbnail: NSImage? {
        guard let hash = record.screenshotHash, let url = PreviewEvidenceIndex.shared.url(for: hash) else { return nil }
        return NSImage(contentsOf: url)
    }

    /// "Checked /settings at desktop: no errors", or what failed first.
    nonisolated static func caption(for record: UIVerificationRecord) -> String {
        let place = record.viewport.map { "\(record.target) at \($0)" } ?? record.target
        let surface: String
        switch record.surface {
        case .web: surface = ""
        case .ios: surface = " in the Simulator"
        case .mac: surface = " on the Mac"
        }
        guard !record.passed else {
            let status = record.checks.first { $0.name.hasPrefix("HTTP ") }?.name
            return "Checked \(place)\(surface): no errors\(status.map { " · \($0)" } ?? "")"
        }
        let failed = record.checks.filter { !$0.passed }
        guard let first = failed.first else { return "\(place)\(surface): the check failed" }
        let detail = first.detail.map { " — \($0)" } ?? ""
        return "\(place)\(surface): \(first.name)\(detail)"
    }

    /// The other failed checks, in words.
    nonisolated static func secondLine(for record: UIVerificationRecord) -> String? {
        let failed = record.checks.filter { !$0.passed }.dropFirst()
        guard !failed.isEmpty else { return nil }
        return "Also: " + failed.map { check in check.detail.map { "\(check.name) (\($0))" } ?? check.name }.joined(separator: "; ")
    }
}
