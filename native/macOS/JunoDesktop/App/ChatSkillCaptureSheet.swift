import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// What "Save this as a skill" opens with: the draft built from the run at
/// the moment of the press, and where the skill is filed.
struct ChatSkillCaptureDraft: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var description: String
    var instructions: String
    /// The task's project: a skill captured from a project's task is about
    /// that project's work, so it is filed there.
    var projectID: String?

    /// Drafted from the task as it stands (`capture-skill.tsx`).
    static func from(
        session: WorkSessionSummary, plan: [WorkEventLog.PlanStep], performed: WorkEventLog.PerformedActions
    ) -> ChatSkillCaptureDraft {
        ChatSkillCaptureDraft(
            name: WorkSkillDraft.name(title: session.title, goal: session.goal),
            description: WorkSkillDraft.description(goal: session.goal),
            instructions: WorkSkillDraft.instructions(goal: session.goal, plan: plan, performed: performed),
            projectID: session.projectID
        )
    }
}

/// "Save this task as a skill" (the web's `CaptureSkillDialog`, B3): a draft
/// the reader edits and saves, nothing created until they press.
///
/// An opaque sheet at 640pt: the title, the web's sentence about what will
/// happen, then Name (with the slug it will answer to), What it is for, and
/// the Instructions in SF — prose, not code (register #66). A refusal is said
/// under the fields in the error recipe; nothing is bound to Return, since
/// Return belongs to the editor.
struct ChatSkillCaptureSheet: View {
    @State var draft: ChatSkillCaptureDraft
    /// Saves; returns nil on success or the sentence to show.
    let save: (ChatSkillCaptureDraft) async -> String?
    let close: () -> Void

    @State private var saving = false
    @State private var refusal: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var slug: String? { WorkSkillDraft.slug(fromName: draft.name) }

    private var canSave: Bool {
        !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && slug != nil && !saving
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text(WorkSkillDraft.sheetTitle)
                    .junoFont(size: 18, relativeTo: .title3, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text(WorkSkillDraft.sheetDescription)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            field("Name") {
                TextField("Name", text: $draft.name, prompt: Text("Name"))
                    .junoFieldChrome(fill: Color.junoCard)
                    .labelsHidden()
                    .accessibilityIdentifier("juno.skill-capture.name")
                slugHint
            }

            field("What it is for") {
                TextField("What it is for", text: $draft.description)
                    .junoFieldChrome(fill: Color.junoCard)
                    .labelsHidden()
                    .accessibilityIdentifier("juno.skill-capture.description")
                Text(WorkSkillDraft.descriptionHint)
                    .junoFont(size: 12, relativeTo: .footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            field("Instructions") {
                TextEditor(text: $draft.instructions)
                    .junoFont(size: 13, relativeTo: .callout)
                    .scrollContentBackground(.hidden)
                    .padding(JunoSpace.snug)
                    // Twelve lines of 13pt text.
                    .frame(height: 12 * 17 + 2 * JunoSpace.snug)
                    .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .accessibilityLabel("Instructions")
                    .accessibilityIdentifier("juno.skill-capture.instructions")
            }

            if let refusal {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                    JunoIconView(.error, size: 13)
                        .accessibilityHidden(true)
                    Text(refusal)
                        .junoFont(size: 13, relativeTo: .callout)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .foregroundStyle(Color.junoDestructiveInk)
                .transition(.opacity)
                .accessibilityIdentifier("juno.skill-capture.refusal")
            }

            HStack(spacing: JunoSpace.cozy) {
                Spacer(minLength: 0)
                Button("Cancel", role: .cancel, action: close)
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .keyboardShortcut(.cancelAction)
                    .disabled(saving)
                    .contentShape(.rect)
                Button {
                    Task { await commit() }
                } label: {
                    Text(saving ? "Saving…" : "Save the skill")
                }
                .buttonStyle(.junoProminent)
                .disabled(!canSave)
                .contentShape(.rect)
                .accessibilityIdentifier("juno.skill-capture.save")
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 640)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: refusal)
        .junoSheetSurface(.fitted)
    }

    /// "You will type /slug to use it." — the slug an identifier, so mono.
    @ViewBuilder
    private var slugHint: some View {
        Group {
            if let slug {
                Text("You will type ") + Text("/\(slug)").monospaced()
                    + Text(" to use it.")
            } else {
                Text(WorkSkillDraft.slugHint(nil))
            }
        }
        .junoFont(size: 12, relativeTo: .footnote)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityLabel(WorkSkillDraft.slugHint(slug))
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(label)
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoForeground)
            content()
        }
    }

    private func commit() async {
        saving = true
        refusal = nil
        var trimmed = draft
        trimmed.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        trimmed.description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        trimmed.instructions = draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let failure = await save(trimmed)
        saving = false
        if let failure { refusal = failure } else { close() }
    }
}
