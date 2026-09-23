import Foundation
import JunoChatKit
import JunoDesignSystem
import Testing

@testable import JunoDesktop

/// The Mac's pieces of the tools rework's run UI (Tool calls & research SPEC
/// §7–§9) that are decisions rather than drawing.
@MainActor
struct RunBlockTests {
    /// A receipt shows under a call once its approval is decided — never
    /// while the card is the live state, and never where the call's own
    /// words already say it.
    @Test
    func approvalReceipts() {
        let decided = Date(timeIntervalSince1970: 1_758_000_000)
        func call(_ status: NativeToolCall.Status, _ approval: String, decision: String? = nil) -> NativeToolCall {
            NativeToolCall(
                callID: "c", tool: "mcp", connectorLabel: "GitHub", toolTitle: "Create issue", status: status,
                approval: .init(id: "a", status: approval, decision: decision, decidedAt: decided)
            )
        }
        let time = decided.formatted(date: .omitted, time: .shortened)
        #expect(DesktopApprovalReceipt.words(for: call(.succeeded, "executed", decision: "allow_once")) == "Allowed once · \(time)")
        #expect(DesktopApprovalReceipt.words(for: call(.succeeded, "executed", decision: "allow_scope")) == "Always allowed · \(time)")
        #expect(DesktopApprovalReceipt.words(for: call(.awaitingApproval, "pending")) == nil)
        #expect(DesktopApprovalReceipt.words(for: call(.denied, "denied")) == nil)
        #expect(DesktopApprovalReceipt.words(for: call(.cancelled, "superseded")) == "Cancelled")
    }

    /// Research phases wear the run signature's patterns (SPEC §9.11.1).
    @Test
    func researchPhasesMapToTheSignature() {
        #expect(DesktopResearchPhase.glyph(.planning) == .thinking)
        #expect(DesktopResearchPhase.glyph(.awaitingStart) == .waiting)
        #expect(DesktopResearchPhase.glyph(.searching) == .searching)
        #expect(DesktopResearchPhase.glyph(.reading) == .reading)
        #expect(DesktopResearchPhase.glyph(.writing) == .writing)
        #expect(DesktopResearchPhase.glyph(.checking) == .writing)
        #expect(DesktopResearchPhase.glyph(.paused) == .paused)
        #expect(DesktopResearchPhase.glyph(.done) == .settled)
        #expect(DesktopResearchPhase.glyph(.failed) == .failed)
    }

    /// Activity and Research are one right-column shell: one width, and
    /// the dock holds one of canvas, Activity or Research at a time.
    @Test
    func activityAndResearchShareTheShell() {
        let activity = DesktopDockPanel.activity(messageID: "m", focusCallID: nil)
        let research = DesktopDockPanel.research(runID: "r")
        #expect(activity.widthKey == research.widthKey)
        #expect(activity.id != research.id)
        #expect(research.artifact == nil)
    }

    /// The signature's still frames are the SPEC's reduced-motion block.
    @Test
    func staticSignatures() {
        #expect(JunoRunSignature.staticSignature(.thinking, row: 1, column: 1) == 1)
        #expect(JunoRunSignature.staticSignature(.thinking, row: 0, column: 0) == 0)
        #expect(JunoRunSignature.staticSignature(.searching, row: 2, column: 1) == 1)
        #expect(JunoRunSignature.staticSignature(.reading, row: 1, column: 0) == 1)
        #expect(JunoRunSignature.staticSignature(.tool, row: 0, column: 2) == 1)
        #expect(JunoRunSignature.staticSignature(.tool, row: 1, column: 1) == 0.6)
        #expect(JunoRunSignature.staticSignature(.writing, row: 2, column: 0) == 1)
        #expect(JunoRunSignature.staticSignature(.paused, row: 1, column: 1) == 0)
        // `run-lit`: dark, lit at 6%, 0.3 at 30%, dark from 42%.
        #expect(JunoRunSignature.keyframes(JunoRunSignature.lit, at: 0.06) == 1)
        #expect(abs(JunoRunSignature.keyframes(JunoRunSignature.lit, at: 0.30) - 0.3) < 0.0001)
        #expect(JunoRunSignature.keyframes(JunoRunSignature.lit, at: 0.5) == 0)
    }
}
