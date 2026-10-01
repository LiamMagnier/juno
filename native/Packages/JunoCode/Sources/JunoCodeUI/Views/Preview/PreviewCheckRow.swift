import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// A UI check in the thread: a Preview route, a Simulator screen or a Mac app.
//
// Owned by Lane D (Preview and browser). A placeholder from the seams commit
// (CODE_AGENT_SPEC §6.0): plain words in the Studio style, which Lane D
// replaces with the designed row (§4.6: thumbnails, failures in words).

/// "Checked /settings at desktop: no errors", or what failed.
struct PreviewCheckRow: View {
    let record: UIVerificationRecord

    var body: some View {
        Text(Self.caption(for: record))
            .font(Studio.Font.meta)
            .foregroundStyle(record.passed ? Studio.Ink.secondary : Studio.Ink.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 17)
    }

    static func caption(for record: UIVerificationRecord) -> String {
        let place = record.viewport.map { "\(record.target) at \($0)" } ?? record.target
        guard !record.passed else { return "Checked \(place): no errors" }
        let failed = record.checks.filter { !$0.passed }
        guard let first = failed.first else { return "\(place): the check failed" }
        let detail = first.detail.map { " — \($0)" } ?? ""
        return "\(place): \(first.name)\(detail)"
    }
}
