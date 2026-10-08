import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

// MARK: - The summary panel

/// The summary: the page's one raised surface, because it is the one thing
/// on it written to be read top to bottom (`summary-panel.tsx`). It shows its
/// opening sections and unfolds the rest in place — never a scroller inside
/// the page — and carries the prompt dock at its foot, inset 8 so the dock's
/// field radius (12) sits concentric in the panel's (20).
struct DesktopMemorySummaryPanel: View {
    let page: NativeMemoryPageModel
    let summary: NativeMemoryPageSummary?
    let project: DesktopMemoryProject?
    let enabled: Bool
    let rebuild: () -> Void
    let openActivity: () -> Void
    let post: (NativeMemoryNotice?) -> Void

    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var sections: [NativeMemoryPresentation.SummarySection] {
        guard let summary else { return [] }
        return NativeMemoryPresentation.summarySections(
            summary.content, preambleTitle: project == nil ? "About you" : "About this project"
        )
    }

    var body: some View {
        let sections = sections
        let previewCount = NativeMemoryPresentation.summaryPreviewCount(sections)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                headerRow(hasSummary: !sections.isEmpty)
                if !sections.isEmpty {
                    DesktopMemorySections(sections: Array(sections.prefix(previewCount)))
                        .overlay(alignment: .bottom) {
                            if previewCount < sections.count, !expanded {
                                LinearGradient(
                                    colors: [Color.junoCard.opacity(0), Color.junoCard],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                                .frame(height: 40)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                            }
                        }
                    if previewCount < sections.count {
                        if expanded {
                            DesktopMemorySections(sections: Array(sections.dropFirst(previewCount)))
                                .padding(.top, JunoSpace.regular)
                                .transition(.opacity)
                        }
                        Button {
                            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                                expanded.toggle()
                            }
                        } label: {
                            HStack(spacing: JunoSpace.tight) {
                                Text(expanded ? "Show less" : "Read the whole summary")
                                JunoIconView(expanded ? .chevronUp : .chevronDown, size: 12)
                            }
                            .junoType(JunoType.ui.weight(.medium))
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(minHeight: 28)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                    }
                } else if page.isRebuilding {
                    HStack(spacing: JunoSpace.snug) {
                        ProgressView().controlSize(.small)
                        Text(project == nil ? "Reading your chats and projects…" : "Reading this project’s chats…")
                    }
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.bottom, JunoSpace.snug)
                } else {
                    Text(project == nil
                        ? "Juno writes a short summary of what it knows once it has a few things to go on. Everything it remembers is listed below either way."
                        : "Juno writes this from the chats in this project as you go. Only those chats read it, and they read nothing else Juno remembers about you.")
                        .junoType(.body)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: JunoPageMetrics.ledeMeasure, alignment: .leading)
                        .padding(.bottom, JunoSpace.snug)
                }
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.top, JunoSpace.regular)
            .padding(.bottom, project == nil ? JunoSpace.hairline : JunoSpace.regular)
            if project == nil {
                DesktopMemoryPromptDock(page: page, enabled: enabled, post: post)
                    .padding(JunoSpace.snug)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(project == nil ? "Summary" : "Project summary")
    }

    private func headerRow(hasSummary: Bool) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Text(project == nil ? "Summary" : "Project summary")
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: JunoSpace.snug)
            if hasSummary, let summary {
                Text("Updated \(NativeMemoryPresentation.relativeTime(summary.updatedAt))")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            Button(action: rebuild) {
                HStack(spacing: JunoSpace.tight) {
                    if page.isRebuilding {
                        ProgressView().controlSize(.mini)
                    } else {
                        JunoIconView(.refresh, size: 13)
                    }
                    Text(hasSummary ? "Rebuild" : "Write summary")
                }
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.horizontal, JunoSpace.snug)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(page.isRebuilding)
            .help("Rewrite it from everything Juno remembers")
            .accessibilityLabel(hasSummary ? "Rebuild the summary" : "Write the summary")
            Button(action: openActivity) {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.history, size: 13)
                    Text("Activity")
                }
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .padding(.horizontal, JunoSpace.snug)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Your edits and a recap of what changed")
            .accessibilityLabel("Activity")
        }
    }
}

/// The summary's sections: a 13pt semibold title over the section's prose.
private struct DesktopMemorySections: View {
    let sections: [NativeMemoryPresentation.SummarySection]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            ForEach(sections, id: \.title) { section in
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(section.title)
                        .junoType(JunoType.ui.weight(.semibold))
                        .foregroundStyle(Color.junoForeground)
                        .accessibilityAddTraits(.isHeader)
                    JunoMarkdownText(section.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

// MARK: - The prompt dock

/// The one way to change memory in words, and the place its answer lands
/// (`prompt-dock.tsx`): ask, read the diff, apply, all without the eye
/// leaving the spot. Drafting writes nothing, so the diff is a question:
/// Discard costs nothing and Apply Change is the only write.
struct DesktopMemoryPromptDock: View {
    let page: NativeMemoryPageModel
    let enabled: Bool
    let post: (NativeMemoryNotice?) -> Void
    var focusOnAppear = false

    @State private var text = ""
    @FocusState private var focused: Bool
    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let placeholder = "Tell Juno what to remember, change or forget"

    private var drafting: Bool { page.draftingInstruction != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            field
            if let instruction = page.draftingInstruction {
                Text("Drafting from \(Text(verbatim: "“\(instruction)”").foregroundStyle(Color.junoForeground))")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.comfy)
                    .transition(.opacity)
            }
            ForEach(page.pendingEdits) { edit in
                DesktopMemoryProposal(
                    edit: edit,
                    busy: page.busyEditIDs.contains(edit.id),
                    apply: { Task { await accept(edit) } },
                    discard: { Task { post(await page.deleteEdit(edit.id)) } }
                )
                .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : JunoMotion.riseDistance)))
            }
            ForEach(page.recentlyApplied()) { edit in
                appliedRow(edit)
                    .transition(.opacity)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: page.pendingEdits.map(\.id))
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: page.draftingInstruction)
        .onAppear { if focusOnAppear { focused = true } }
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: JunoSpace.snug) {
            ZStack(alignment: .leading) {
                TextField(
                    drafting ? "" : (enabled ? Self.placeholder : "Memory is off. Turn it on to make changes."),
                    text: $text,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .junoType(.ui)
                .lineLimit(1...5)
                .focused($focused)
                .disabled(!enabled)
                .onSubmit(submit)
                .onExitCommand { text = "" }
                .opacity(drafting ? 0 : 1)
                .accessibilityLabel(Self.placeholder)
                if drafting {
                    Text("Drafting the change…")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .transition(.opacity)
                }
            }
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            ComposerPrimaryDisc(
                face: drafting ? .busy("Drafting the change…")
                    : (enabled && !trimmed.isEmpty ? .send : .disabled("Draft this change")),
                label: "Draft this change",
                help: "Draft this change",
                identifier: "juno.desktop.memory.draft",
                action: submit
            )
        }
        .padding(.leading, JunoSpace.comfy)
        .padding(.trailing, JunoSpace.tight)
        .padding(.vertical, JunoSpace.tight)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(edge, lineWidth: 1)
        )
        .onHover { isHovering = $0 }
    }

    private var edge: Color {
        guard enabled else { return Color.junoInput }
        if focused { return Color.junoForeground.opacity(0.6) }
        return isHovering ? Color.junoForeground.opacity(0.4) : Color.junoInput
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func appliedRow(_ edit: NativeMemoryEdit) -> some View {
        HStack(spacing: JunoSpace.close) {
            JunoIconView(.circleCheck, size: 15)
                .foregroundStyle(Color.junoSuccessInk)
                .accessibilityHidden(true)
            Text("Applied")
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
            Text(edit.summary ?? edit.instruction)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { post(await page.undo(edit)) }
            } label: {
                Label("Undo", icon: .undo)
            }
            .buttonStyle(.borderless)
            .tint(nil)
            .disabled(page.busyEditIDs.contains(edit.id))
            .contentShape(.rect)
        }
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, JunoSpace.tight)
        .frame(minHeight: 36)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoSecondary)
        )
        .accessibilityElement(children: .contain)
    }

    private func submit() {
        let instruction = trimmed
        guard enabled, !instruction.isEmpty, !drafting else { return }
        text = ""
        Task {
            let outcome = await page.instruct(instruction)
            if !outcome.drafted {
                // Nothing was drafted: the sentence comes back so it can be fixed.
                text = instruction
                focused = true
            }
            post(outcome.notice)
        }
    }

    private func accept(_ edit: NativeMemoryEdit) async {
        post(await page.accept(edit, fromDock: true))
        try? await Task.sleep(for: .seconds(NativeMemoryPageModel.appliedHold + 0.1))
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            page.expireApplied()
        }
    }
}

/// A drafted change, waiting for a decision: the reader's own words, what
/// Juno made of them, the lines themselves, then Discard and Apply Change —
/// the panel's one prominent button.
struct DesktopMemoryProposal: View {
    let edit: NativeMemoryEdit
    let busy: Bool
    let apply: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("“\(edit.instruction)”")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                if let summary = edit.summary, !summary.isEmpty {
                    Text(summary)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                }
            }
            .padding(.horizontal, JunoSpace.comfy)
            .padding(.vertical, JunoSpace.cozy)
            DesktopMemoryDiff(operations: edit.operations)
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Discard", action: discard)
                    .buttonStyle(.borderless)
                    .tint(nil)
                    .disabled(busy)
                    .contentShape(.rect)
                Button("Apply change", action: apply)
                    .buttonStyle(.junoProminent)
                    .disabled(busy)
                    .contentShape(.rect)
            }
            .controlSize(.small)
            .padding(JunoSpace.snug)
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .fill(Color.junoCanvas)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Proposed change")
    }
}

/// What a change would do, as lines a reader can check (`operation-diff.tsx`):
/// an added line on the secondary fill behind a `+`, a removed one struck
/// through in the secondary ink behind a `−`. Neutral fills, never coral
/// (register #74); the glyph and the strike carry the difference, and each
/// line says it in words to VoiceOver.
struct DesktopMemoryDiff: View {
    let operations: [NativeMemoryOperation]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                if index > 0 { DesktopRowDivider() }
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.close) {
                    Text(line.added ? "+" : "−")
                        .junoType(JunoType.ui.weight(.semibold))
                        .foregroundStyle(line.added ? Color.junoSuccessInk : Color.junoSecondaryInk)
                        .frame(width: 10)
                        .accessibilityHidden(true)
                    Text(line.text)
                        .junoType(.ui)
                        .strikethrough(!line.added, color: Color.junoSecondaryInk.opacity(0.5))
                        .foregroundStyle(line.added ? Color.junoForeground : Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, JunoSpace.snug)
                .background(line.added ? Color.junoSecondary : Color.junoMuted.opacity(0.6))
                .accessibilityElement(children: .combine)
                .accessibilityLabel((line.added ? "Adds: " : "Removes: ") + line.text)
            }
        }
        .overlay(alignment: .top) { DesktopRowDivider() }
        .overlay(alignment: .bottom) { DesktopRowDivider() }
    }

    private var lines: [(added: Bool, text: String)] {
        operations.flatMap { operation -> [(added: Bool, text: String)] in
            switch operation {
            case let .update(_, before, content): [(false, before), (true, content)]
            case let .remove(_, before): [(false, before)]
            // A suppression reads as "forget", though it is mechanically an add.
            case let .add(content, suppress, _): [(!suppress, content)]
            }
        }
    }
}

// MARK: - The welcome

/// An account with nothing remembered yet (`memory-welcome.tsx`): one panel
/// in the place the summary will take, with the ways memory starts.
struct DesktopMemoryWelcome: View {
    let page: NativeMemoryPageModel
    let enabled: Bool
    @Binding var composing: Bool
    let importMemory: () -> Void
    let learn: () -> Void
    let post: (NativeMemoryNotice?) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let unread = page.backfillRemaining ?? 0
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                JunoIconView(.memory, size: 24)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 48, height: 48)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .fill(Color.junoCanvas)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .accessibilityHidden(true)
                Text("Juno hasn’t remembered anything yet")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, JunoSpace.regular)
                Text("As you chat, Juno keeps the details worth carrying over, like your work, your preferences and how you like answers. You can also start it off yourself.")
                    .junoType(.body)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 448)
                    .padding(.top, JunoSpace.tight)
                HStack(spacing: JunoSpace.snug) {
                    Button("Tell Juno something") {
                        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                            composing = true
                        }
                    }
                    .buttonStyle(.junoProminent)
                    .disabled(!enabled)
                    .contentShape(.rect)
                    Button(action: importMemory) {
                        Label("Import from ChatGPT or Claude", icon: .upload)
                    }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .disabled(!enabled)
                    .contentShape(.rect)
                    if unread > 0 {
                        Button(action: learn) {
                            Label {
                                if unread == 1 {
                                    Text("Learn from 1 past chat")
                                } else {
                                    Text("Learn from past chats \(Text(unread, format: .number).foregroundStyle(Color.junoSecondaryInk))")
                                }
                            } icon: {
                                JunoIconView(.chats, size: 14)
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .disabled(!enabled || page.isBackfilling)
                        .contentShape(.rect)
                    }
                }
                .padding(.top, JunoSpace.roomy)
            }
            .padding(.horizontal, JunoSpace.section)
            .padding(.top, JunoSpace.region + JunoSpace.snug)
            .padding(.bottom, JunoSpace.wide)
            if composing || !page.pendingEdits.isEmpty {
                DesktopMemoryPromptDock(page: page, enabled: enabled, post: post, focusOnAppear: true)
                    .padding([.horizontal, .bottom], JunoSpace.snug)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
        )
    }
}

// MARK: - Suggested skills


/// **Suggested skills** on the memory page (`skill-candidates.tsx`): methods
/// the person's own runs repeated, proposed as skills. A heading, one line on
/// what a skill is, then hairline-separated proposals — absent entirely when
/// there is nothing to propose.
///
/// A proposal is a question, not a change: nothing happens until the person
/// adds it as a skill (it opens in Skills with auto-selection off) or
/// dismisses it (it is never proposed again).
struct DesktopMemorySkillCandidates: View {
    let page: NativeMemoryPageModel
    let post: (NativeMemoryNotice?) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text("Suggested skills")
                    .junoType(.heading)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("From your own runs. A skill is how Alevr does something; memory stays what it knows.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(page.skillCandidates.enumerated()), id: \.element.id) { index, candidate in
                    if index > 0 {
                        Rectangle()
                            .fill(Color.junoBorder)
                            .frame(height: 1)
                            .accessibilityHidden(true)
                    }
                    row(candidate)
                        .padding(.vertical, JunoSpace.cozy)
                        .transition(.opacity)
                }
            }
            .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: page.skillCandidates.map(\.id))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.memory.skill-candidates")
    }

    private func row(_ candidate: NativeSkillCandidate) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(candidate.title)
                .junoType(JunoType.ui.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
            Text(candidate.detailLine())
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
            if !candidate.examples.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    ForEach(Array(candidate.examples.enumerated()), id: \.offset) { _, example in
                        Text("“\(example)”")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(2)
                    }
                }
                .padding(.top, JunoSpace.hairline)
            }
            actions(candidate)
                .padding(.top, JunoSpace.tight)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func actions(_ candidate: NativeSkillCandidate) -> some View {
        let busy = page.busyCandidateIDs.contains(candidate.id)
        HStack(spacing: JunoSpace.snug) {
            if let made = page.madeSkills[candidate.id] {
                Label("Added to your skills", icon: .check)
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                if let skillID = made.skillID {
                    Button("Open the new skill") {
                        DesktopPageRouter.shared.open(.skills, route: .skill(skillID))
                    }
                    .buttonStyle(DesktopUnderlineLinkStyle())
                    .contentShape(.rect)
                }
            } else {
                Button {
                    Task { post(await page.decide(candidate, .accept)) }
                } label: {
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Add as skill")
                    }
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .controlSize(.small)
                .disabled(busy)
                .accessibilityIdentifier("juno.desktop.memory.skill-candidate.accept.\(candidate.id)")
                .contentShape(.rect)
                Button("Dismiss") {
                    Task { post(await page.decide(candidate, .dismiss)) }
                }
                .buttonStyle(.borderless)
                .tint(nil)
                .controlSize(.small)
                .disabled(busy)
                .help("Not a skill. Alevr won’t propose it again.")
                .accessibilityIdentifier("juno.desktop.memory.skill-candidate.dismiss.\(candidate.id)")
                .contentShape(.rect)
            }
        }
    }
}
