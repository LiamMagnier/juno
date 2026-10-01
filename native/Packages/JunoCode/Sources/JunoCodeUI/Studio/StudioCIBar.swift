import SwiftUI
import JunoCodeCore
import JunoDesignSystem

// CI for the session's pull request.
//
// Owned by Lane E (review, ship, sessions and away). A placeholder from the
// seams commit (CODE_AGENT_SPEC §6.0): the thread row in plain words, which
// Lane E replaces, and beside which it builds the CI bar (§5.3).

/// "CI: 3 of 4 checks passed; `test (ubuntu)` failed".
struct StudioCIStatusRow: View {
    let event: CIStatusEvent

    var body: some View {
        Text(Self.caption(for: event))
            .font(Studio.Font.meta)
            .foregroundStyle(Studio.Ink.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 17)
    }

    static func caption(for event: CIStatusEvent) -> String {
        let checks = event.checks
        guard !checks.isEmpty else { return "CI: no checks yet" }
        let passed = checks.filter { $0.state == .passed }.count
        let failed = checks.filter { $0.state == .failed }.map(\.name)
        let running = checks.filter { !$0.state.isSettled }.count
        var text = "CI: \(passed) of \(checks.count) checks passed"
        if !failed.isEmpty {
            text += "; \(failed.joined(separator: ", ")) failed"
        }
        if running > 0 {
            text += "; \(running) still running"
        }
        return text
    }
}
