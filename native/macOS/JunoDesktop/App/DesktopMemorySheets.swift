import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

enum DesktopMemoryActivityTab: Hashable {
    case edits
    case recap
}

// MARK: - Activity

/// Activity: the history behind the page, one step aside from it
/// (`activity-sheet.tsx`, register #65). The web's side sheet is a sheet
/// here: the system presents it, no glass, an explicit frame.
struct DesktopMemoryActivitySheet: View {
    let page: NativeMemoryPageModel
    @Binding var tab: DesktopMemoryActivityTab
    /// The project the page is narrowed to, for the recap's rows.
    let scope: String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.junoToast) private var toast

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Activity")
                    .junoType(.heading)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .tint(nil)
                    .contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.top, JunoSpace.roomy)
            .padding(.bottom, JunoSpace.cozy)
            JunoSegmented(
                options: [
                    JunoSegmented<DesktopMemoryActivityTab>.Option(.edits, "Your edits", count: page.edits.count),
                    JunoSegmented<DesktopMemoryActivityTab>.Option(.recap, "Recap"),
                ],
                selection: $tab,
                accessibilityLabel: "Activity",
                fills: true
            )
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.bottom, JunoSpace.regular)
            Divider()
            ScrollView {
                Group {
                    switch tab {
                    case .edits:
                        DesktopMemoryEditHistory(page: page, post: post)
                    case .recap:
                        DesktopMemoryRecapView(page: page, scope: scope)
                    }
                }
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.vertical, JunoSpace.regular)
            }
        }
        .frame(width: 520, height: 600)
    }

    private func post(_ notice: NativeMemoryNotice?) {
        guard let notice else { return }
        switch notice.tone {
        case .success: toast(.success(notice.title, detail: notice.detail))
        case .error: toast(.error(notice.title, detail: notice.detail))
        case .info: toast(.info(notice.title))
        }
    }
}

/// Every instruction, what it changed, and its Undo.
struct DesktopMemoryEditHistory: View {
    let page: NativeMemoryPageModel
    let post: (NativeMemoryNotice?) -> Void

    var body: some View {
        if page.edits.isEmpty {
            Text("Changes you ask for under the summary are kept here, with an Undo for the ones you applied.")
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, JunoSpace.wide)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(page.edits.enumerated()), id: \.element.id) { index, edit in
                    if index > 0 { Divider().padding(.vertical, JunoSpace.regular) }
                    entry(edit)
                }
            }
        }
    }

    private func entry(_ edit: NativeMemoryEdit) -> some View {
        let busy = page.busyEditIDs.contains(edit.id)
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                Text("“\(edit.instruction)”")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DesktopMemoryStatusToken(status: edit.status)
            }
            if let note = edit.note ?? edit.summary, !note.isEmpty {
                Text(note)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !edit.operations.isEmpty {
                DesktopMemoryDiff(operations: edit.operations)
                    .clipShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
            }
            HStack(spacing: JunoSpace.snug) {
                Text(NativeMemoryPresentation.relativeTime(edit.createdAt))
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                Spacer()
                switch edit.status {
                case .applied:
                    Button {
                        Task { post(await page.undo(edit)) }
                    } label: { Label("Undo", icon: .undo) }
                    .buttonStyle(.borderless)
                    .disabled(busy)
                    .contentShape(.rect)
                case .pending:
                    Button("Discard") { Task { post(await page.deleteEdit(edit.id)) } }
                        .buttonStyle(.borderless)
                        .disabled(busy)
                        .contentShape(.rect)
                    Button("Apply Change") { Task { post(await page.accept(edit)) } }
                        .buttonStyle(.junoGlass)
                        .disabled(busy)
                        .contentShape(.rect)
                case .rejected:
                    Button("Remove") { Task { post(await page.deleteEdit(edit.id)) } }
                        .buttonStyle(.borderless)
                        .disabled(busy)
                        .contentShape(.rect)
                }
            }
            .tint(nil)
            .controlSize(.small)
        }
    }
}

/// An edit's state, in words and one quiet tone (`EditStatusToken`).
struct DesktopMemoryStatusToken: View {
    let status: NativeMemoryEdit.Status

    var body: some View {
        let (label, ink, fill): (String, Color, Color) = switch status {
        case .pending: ("Waiting for you", Color.junoWarningInk, Color.junoWarning.opacity(0.15))
        case .applied: ("Applied", Color.junoSuccessInk, Color.junoSecondary)
        case .rejected: ("Not applied", Color.junoSecondaryInk, Color.junoSecondary)
        }
        Text(label)
            .junoType(JunoType.caption.weight(.medium))
            .foregroundStyle(ink)
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 20)
            .background(Capsule(style: .continuous).fill(fill))
            .fixedSize()
    }
}

/// The recap: what changed in what Juno knows over a period
/// (`recap-view.tsx`) — one line of counts in words, then the sections as
/// headings over hairline rows.
struct DesktopMemoryRecapView: View {
    let page: NativeMemoryPageModel
    let scope: String?

    @State private var days = 30
    @State private var extras: NativeMemoryRecapExtras?
    @State private var showsAllLearned = false

    var body: some View {
        let rows = NativeMemoryPresentation.facts(page.facts, inScope: scope)
        let recap = NativeMemoryRecap.build(rows, days: days)
        let themes = extras?.themes ?? []
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            JunoSegmented(
                options: NativeMemoryRecap.periods.map { JunoSegmented<Int>.Option($0, "\($0) days") },
                selection: $days,
                accessibilityLabel: "Recap period",
                fills: true
            )
            HStack(spacing: JunoSpace.regular) {
                tally(recap.learned.count, "learned")
                tally(recap.changedCount, "changed")
                tally(recap.letGoCount, "let go")
                if let extras { tally(extras.conversations, "chats") }
            }
            if extras != nil, recap.isEmpty(themes: themes) {
                Text("Alevr didn’t learn, change or use anything in this stretch. Try a longer period.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, JunoSpace.roomy)
            } else {
                if !recap.learned.isEmpty {
                    section("What Alevr learned") {
                        let shown = showsAllLearned ? recap.learned : Array(recap.learned.prefix(6))
                        ForEach(shown) { row in
                            line(row.content, meta: NativeMemoryVocabulary.topicLabel(row.category), when: row.createdAt)
                        }
                        if recap.learned.count > 6 {
                            Button {
                                showsAllLearned.toggle()
                            } label: {
                                if showsAllLearned {
                                    Text("Show fewer")
                                } else {
                                    Text("Show all \(Text(recap.learned.count, format: .number))")
                                }
                            }
                            .buttonStyle(.borderless)
                            .tint(nil)
                            .contentShape(.rect)
                        }
                    }
                }
                if recap.changedCount > 0 {
                    section("What changed") {
                        ForEach(recap.replaced, id: \.before.id) { replacement in
                            Text("\(Text(replacement.before.content).strikethrough(color: Color.junoSecondaryInk.opacity(0.4)))  →  \(Text(replacement.after.content).foregroundStyle(Color.junoForeground))")
                                .foregroundStyle(Color.junoSecondaryInk)
                                .junoType(.ui)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.vertical, JunoSpace.snug)
                                .accessibilityLabel("\(replacement.before.content), replaced by \(replacement.after.content)")
                        }
                        ForEach(recap.conflicting) { row in
                            line(row.content, meta: row.reason ?? "It clashed with something you told Alevr, so it isn’t used.", when: nil)
                        }
                    }
                }
                if recap.letGoCount > 0 {
                    section("What Alevr let go of") {
                        ForEach(recap.forgotten) { row in
                            line(row.content, meta: "You asked Alevr to forget this", when: row.createdAt)
                        }
                        ForEach(recap.expired) { row in
                            line(row.content, meta: "Only true for a while", when: nil)
                        }
                    }
                }
                if extras == nil {
                    JunoSkeleton(height: 72, cornerRadius: JunoRadius.card)
                } else if !themes.isEmpty {
                    section("What you talked about") {
                        ForEach(themes, id: \.self) { theme in
                            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                                Text("•").foregroundStyle(Color.junoSecondaryInk).accessibilityHidden(true)
                                Text(theme).foregroundStyle(Color.junoForeground)
                            }
                            .junoType(.ui)
                        }
                    }
                }
                if !recap.leanedOn.isEmpty {
                    section("What Alevr leaned on") {
                        ForEach(recap.leanedOn) { row in
                            line(row.content, meta: "Last used", when: row.lastUsedAt ?? row.createdAt)
                        }
                    }
                }
            }
        }
        .task(id: days) {
            extras = nil
            showsAllLearned = false
            extras = await page.recapExtras(days: days)
        }
    }

    private func tally(_ value: Int, _ label: String) -> some View {
        Text("\(Text(value, format: .number).fontWeight(.medium).foregroundStyle(Color.junoForeground)) \(label)")
            .foregroundStyle(Color.junoSecondaryInk)
            .junoType(.ui)
            .monospacedDigit()
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func line(_ text: String, meta: String, when: Date?) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(text)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
            Text(when.map { "\(meta) · \(NativeMemoryPresentation.relativeTime($0))" } ?? meta)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
        }
        .padding(.vertical, JunoSpace.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Import

private enum DesktopMemoryImportStep: Int, CaseIterable {
    case copy, paste, review

    var label: String {
        switch self {
        case .copy: "Copy the prompt"
        case .paste: "Paste the answer"
        case .review: "Choose what to keep"
        }
    }
}

/// Import from another assistant, in three steps (`import-dialog.tsx`): copy
/// a prompt, paste the other assistant's answer, choose what to keep. Nothing
/// is written until Import.
struct DesktopMemoryImportSheet: View {
    let page: NativeMemoryPageModel
    /// Opens on a step, for a snapshot.
    var initialCandidates: [NativeMemoryImportCandidate]? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.junoToast) private var toast
    @State private var step = DesktopMemoryImportStep.copy
    @State private var text = ""
    @State private var candidates: [NativeMemoryImportCandidate] = []
    @State private var selected: Set<Int> = []
    @State private var working = false
    @State private var copied = false
    @State private var refusal: String?
    @State private var didSeed = false

    /// What the reader pastes into the assistant they are leaving
    /// (`MEMORY_IMPORT_PROMPT`, verbatim).
    static let prompt = """
        I'm moving to a different assistant and want to bring what you know about me. List every memory you have saved about me, plus anything durable you've learned about me from our conversations — my name, work, location, the tools and languages I use, my preferences, ongoing projects, goals, and how I like answers.

        Format it exactly like this:
        - One fact per line, each line starting with "- ".
        - Each fact a short sentence about me in the third person, starting with "The user".
        - No headings, no numbering, and nothing before or after the list.
        - Leave out anything you're unsure of.
        """

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Import memory")
                    .junoType(.heading)
                    .accessibilityAddTraits(.isHeader)
                Text("Bring what ChatGPT, Claude or Gemini knows about you. Nothing is saved until you choose.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                stepRail
                    .padding(.top, JunoSpace.cozy)
            }
            .padding(JunoSpace.roomy)
            Divider()
            ScrollView {
                stepBody
                    .padding(JunoSpace.roomy)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            footer
                .padding(.horizontal, JunoSpace.roomy)
                .padding(.vertical, JunoSpace.regular)
        }
        .frame(width: 640, height: 580)
        .onAppear {
            guard !didSeed, let initialCandidates else { return }
            didSeed = true
            candidates = initialCandidates
            selected = Set(initialCandidates.filter(\.selected).map(\.id))
            step = .review
        }
    }

    private var stepRail: some View {
        HStack(spacing: JunoSpace.snug) {
            ForEach(DesktopMemoryImportStep.allCases, id: \.self) { item in
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Capsule(style: .continuous)
                        .fill(item.rawValue <= step.rawValue ? Color.junoForeground : Color.junoMuted)
                        .frame(height: 4)
                        .accessibilityHidden(true)
                    Text(item.label)
                        .junoType(.caption)
                        .foregroundStyle(item == step ? Color.junoForeground : Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(item == step ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Import steps")
    }

    @ViewBuilder
    private var stepBody: some View {
        switch step {
        case .copy:
            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                Text("Paste this into the assistant you’re coming from, in a new chat. It asks for everything it remembers, written one fact per line so Alevr can read it back.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Self.prompt)
                    .junoType(.monoSmall)
                    .foregroundStyle(Color.junoForeground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(JunoSpace.regular)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .fill(Color.junoSecondary)
                    )
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(Self.prompt, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
                } label: {
                    Label(verbatim: copied ? "Copied" : "Copy Prompt", icon: copied ? .check : .copy)
                }
                .buttonStyle(.junoGlass)
                .tint(nil)
                .contentShape(.rect)
            }
        case .paste:
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text("Paste the whole answer here, list and all. Alevr picks out the facts. An Alevr memory export (.json) works too.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                TextEditor(text: $text)
                    .font(JunoType.monoSmall.font())
                    .scrollContentBackground(.hidden)
                    .padding(JunoSpace.snug)
                    .frame(height: 260)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .fill(Color.junoCanvas)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                            .strokeBorder(Color.junoInput, lineWidth: 1)
                    )
                    .accessibilityLabel("The other assistant’s answer")
                refusalLine
            }
        case .review:
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack {
                    Toggle(isOn: allBinding) {
                        Text("\(selected.count) of \(candidates.count) selected")
                            .junoType(.ui)
                            .monospacedDigit()
                    }
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Select every fact")
                    Spacer()
                    Text("Sensitive facts start unticked. Tick them only if you want Alevr to keep them.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .multilineTextAlignment(.trailing)
                }
                DesktopListCard {
                    ForEach(Array(candidates.enumerated()), id: \.element.id) { index, candidate in
                        if index > 0 { DesktopRowDivider() }
                        reviewRow(candidate)
                    }
                }
                refusalLine
            }
        }
    }

    @ViewBuilder
    private var refusalLine: some View {
        if let refusal {
            Label {
                Text(refusal)
            } icon: {
                JunoIconView(.error, size: 14)
            }
            .junoType(.ui)
            .foregroundStyle(Color.junoDestructiveInk)
        }
    }

    private func reviewRow(_ candidate: NativeMemoryImportCandidate) -> some View {
        let locked = !candidate.isSelectable
        return HStack(alignment: .top, spacing: JunoSpace.cozy) {
            Toggle("", isOn: Binding(
                get: { selected.contains(candidate.id) },
                set: { on in if on { selected.insert(candidate.id) } else { selected.remove(candidate.id) } }
            ))
            .toggleStyle(.checkbox)
            .labelsHidden()
            .disabled(locked)
            .accessibilityLabel(candidate.content)
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text(candidate.content)
                    .junoType(.ui)
                    .strikethrough(locked, color: Color.junoSecondaryInk.opacity(0.4))
                    .foregroundStyle(locked ? Color.junoSecondaryInk : Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: JunoSpace.tight) {
                    DesktopRowToken(text: NativeMemoryVocabulary.topicLabel(candidate.category))
                    if let sensitive = candidate.sensitive {
                        DesktopRowToken(text: NativeMemoryVocabulary.sensitiveLabel(sensitive), icon: .permission, isWarning: true)
                    }
                    switch candidate.status {
                    case .known: DesktopRowToken(text: "Already remembered")
                    case .forgotten: DesktopRowToken(text: "You asked Alevr to forget this")
                    case .secret: DesktopRowToken(text: "Looks like a password or key, so it’s never imported", isWarning: true)
                    case .new: EmptyView()
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    private var selectable: [Int] { candidates.filter(\.isSelectable).map(\.id) }

    private var allBinding: Binding<Bool> {
        Binding(
            get: { !selectable.isEmpty && selectable.allSatisfy(selected.contains) },
            set: { on in selected = on ? Set(selectable) : [] }
        )
    }

    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            if step != .copy {
                Button {
                    refusal = nil
                    step = step == .review ? .paste : .copy
                } label: {
                    Label("Back", icon: .arrowLeft)
                }
                .buttonStyle(.borderless)
                .tint(nil)
                .disabled(working)
                .contentShape(.rect)
            }
            Spacer()
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .tint(nil)
                .disabled(working)
                .contentShape(.rect)
            switch step {
            case .copy:
                Button("I’ve Got the Answer") { step = .paste }
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut(.defaultAction)
                    .contentShape(.rect)
            case .paste:
                Button(working ? "Reading…" : "Review") { Task { await review() } }
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(working || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .contentShape(.rect)
            case .review:
                Button(working ? "Importing…" : "Import \(selected.count) \(selected.count == 1 ? "Fact" : "Facts")") {
                    Task { await commit() }
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(working || selected.isEmpty)
                .contentShape(.rect)
            }
        }
    }

    private func review() async {
        working = true
        refusal = nil
        let result = await page.importPreview(text)
        working = false
        switch result {
        case .success(let list):
            candidates = list
            selected = Set(list.filter(\.selected).map(\.id))
            step = .review
        case .failure(let error):
            refusal = error.message
        }
    }

    private func commit() async {
        let facts = candidates.filter { selected.contains($0.id) }.map(\.content)
        guard !facts.isEmpty else { return }
        working = true
        let outcome = await page.importFacts(facts)
        working = false
        if outcome.imported {
            toast(.success(outcome.notice.title))
            dismiss()
        } else {
            refusal = outcome.notice.title
        }
    }
}
