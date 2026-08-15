import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoStorage
import SwiftUI

// MARK: - Where this lives, and why it is not in the design system
//
// The milestone put this screen in `JunoDesignSystem`. It is here instead,
// beside ``NativeMemorySettingsStore`` and ``MemoryExtractionEngine``, for two
// reasons — one practical and one structural.
//
// Practically, another surface owns that target in parallel and two agents
// editing it is a merge conflict nobody learns anything from.
//
// Structurally, it does not belong there. `JunoDesignSystem` has no dependency
// on `JunoStorage`, and this screen is generic over `AccountScopedRepository`
// and drives `NativeMemorySettingsModel` directly — putting it there would mean
// pulling the storage stack into the design system so one screen could read a
// database. The design system supplies the tokens this uses; it should not have
// to know what a memory is.

/// Everything Juno remembers about this account, and every way to change it.
///
/// The screen is the feature's consent surface, not a settings page that happens
/// to list rows. Memory is only defensible if the person it is about can see all
/// of it, edit any of it, and delete any of it — so every stored memory appears
/// here verbatim, including the ones ``MemoryExtractionEngine`` proposed rather
/// than the reader typed, labelled as such.
///
/// **Proposals are shown before they are stored.** An extraction that filed
/// itself and appeared later is the version of this feature people describe as
/// creepy; one that asks is the version they leave switched on.
public struct NativeMemoryManagerView<Repository: AccountScopedRepository>: View {
    private let model: NativeMemorySettingsModel<Repository>
    private let proposals: [MemoryCandidate]
    private let onDecideProposal: (MemoryCandidate, Bool) -> Void

    @State private var editing: NativeMemoryEntry?
    @State private var draft = ""
    @State private var composing = false
    @State private var confirmingErase = false

    /// - Parameters:
    ///   - proposals: Candidates awaiting the reader's decision. Empty is the
    ///     normal case; the section disappears entirely rather than showing an
    ///     empty state, because a permanent "nothing proposed" row would imply
    ///     Juno is always watching for something.
    ///   - onDecideProposal: `true` keeps the candidate, `false` discards it. The
    ///     caller writes through ``NativeMemorySettingsModel/createMemory(content:)``
    ///     so an accepted proposal takes exactly the same path as a typed one.
    public init(
        model: NativeMemorySettingsModel<Repository>,
        proposals: [MemoryCandidate] = [],
        onDecideProposal: @escaping (MemoryCandidate, Bool) -> Void = { _, _ in }
    ) {
        self.model = model
        self.proposals = proposals
        self.onDecideProposal = onDecideProposal
    }

    public var body: some View {
        List {
            consentSection
            if !proposals.isEmpty { proposalSection }
            storedSection
            neverStoredSection
            eraseSection
        }
        .navigationTitle("Memory")
        .refreshable { await model.refresh() }
        .sheet(item: $editing) { entry in
            editor(title: "Edit memory", initial: entry.content) { text in
                await model.updateMemory(id: entry.id, content: text)
            }
        }
        .sheet(isPresented: $composing) {
            editor(title: "New memory", initial: "") { text in
                await model.createMemory(content: text)
            }
        }
        .confirmationDialog(
            "Delete everything Juno remembers?",
            isPresented: $confirmingErase,
            titleVisibility: .visible
        ) {
            Button("Delete all memories", role: .destructive) {
                Task { await model.eraseAllMemory() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes every memory on this account, on every device. It can't be undone.")
        }
    }

    // MARK: Consent

    /// The switch, and — when the account's settings have not loaded — a row that
    /// says so instead of a switch.
    ///
    /// A `Toggle` bound to `settings?.memoryEnabled ?? false` would render as
    /// *off* for an account whose setting is simply not known yet, which is a
    /// screen telling someone memory is disabled when it may well be running.
    /// Absent is not off, and here it is not even a control.
    @ViewBuilder
    private var consentSection: some View {
        Section {
            if let settings = model.settings {
                Toggle(
                    "Remember details from conversations",
                    isOn: Binding(
                        get: { settings.memoryEnabled },
                        set: { newValue in
                            Task { await model.updateSettings(.init(memoryEnabled: newValue)) }
                        }
                    )
                )
                .disabled(model.isMutating)
                if !settings.memoryEnabled {
                    Text("Juno won't learn anything new. Memories already saved stay until you delete them.")
                        .junoCaption()
                }
            } else {
                LabeledContent("Remember details from conversations") {
                    Text(model.phase == .failed ? "Unavailable" : "Loading…")
                        .junoCaption()
                }
            }
            if let error = model.lastErrorDescription {
                Text(error).junoCaption().foregroundStyle(Color.junoDanger)
            }
        } header: {
            Text("Memory")
        } footer: {
            Text("Juno only learns from what you say, never from its own replies.")
        }
    }

    // MARK: Proposals

    private var proposalSection: some View {
        Section {
            ForEach(proposals) { candidate in
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(candidate.content).junoBody()
                    Text(candidate.rationale.explanation).junoCaption()
                    HStack(spacing: JunoSpace.cozy) {
                        Button("Keep") { onDecideProposal(candidate, true) }
                        Button("Discard", role: .destructive) {
                            onDecideProposal(candidate, false)
                        }
                    }
                    .buttonStyle(.bordered)
                    .padding(.top, JunoSpace.hairline)
                }
                .padding(.vertical, JunoSpace.hairline)
            }
        } header: {
            Text("Noticed in your conversations")
        } footer: {
            Text("Nothing here is saved until you keep it.")
        }
    }

    // MARK: Stored

    @ViewBuilder
    private var storedSection: some View {
        Section {
            if model.memories.isEmpty {
                Text("Nothing saved yet.").junoCaption()
            } else {
                ForEach(model.memories) { entry in
                    Button { beginEditing(entry) } label: { row(entry) }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Delete", role: .destructive) {
                                Task { await model.deleteMemory(id: entry.id) }
                            }
                        }
                }
            }
            Button("Add a memory") { draft = ""; composing = true }
        } header: {
            HStack {
                Text("Saved")
                Spacer()
                if let summary = model.summary {
                    Text("\(summary.entryCount)").junoCaption()
                }
            }
        }
    }

    private func row(_ entry: NativeMemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            // A suppression is stored without its polarity — the *kind* carries
            // it, so the prompt can render "Avoid: use em dashes" without a
            // double negative. That leaves the bare content ambiguous on screen,
            // so the polarity is put back here rather than being left for the
            // reader to infer from a badge underneath it.
            Text(entry.kind == .suppression ? "Never: \(entry.content)" : entry.content)
                .junoBody()
            HStack(spacing: JunoSpace.snug) {
                // The origin is stated on every row rather than only on the
                // automatic ones. "Juno noticed this" and "you typed this" are
                // the two facts a reader needs to decide whether a memory is
                // wrong, and inferring one from the absence of a label is a thing
                // nobody does.
                Text(entry.source == .automatic ? "Noticed by Juno" : "Added by you")
                if entry.kind == .suppression { Text("Never do this") }
                if entry.isPending { Text("Saving…") }
            }
            .junoCaption()
        }
        .padding(.vertical, JunoSpace.hairline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    // MARK: Disclosure

    /// The policy, written out.
    ///
    /// This is here because ``MemoryExtractionPolicy`` makes a promise in code
    /// that the reader otherwise has to take on faith. A category list they can
    /// read is the difference between a store they audit and a store they hope
    /// about.
    private var neverStoredSection: some View {
        Section {
            DisclosureGroup("What Juno never saves") {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    // Read from the policy itself rather than restated here: a
                    // disclosure list that drifted from the vocabulary it
                    // describes is a written assurance the code has stopped
                    // keeping.
                    ForEach(MemoryExtractionPolicy.neverStoredSummary, id: \.self) { line in
                        Text("• \(line)").junoCaption()
                    }
                }
                .padding(.vertical, JunoSpace.hairline)
            }
        }
    }

    // MARK: Erase

    private var eraseSection: some View {
        Section {
            Button("Delete all memories", role: .destructive) { confirmingErase = true }
                .disabled(model.memories.isEmpty || model.isErasing)
        }
    }

    // MARK: Editing

    private func beginEditing(_ entry: NativeMemoryEntry) {
        draft = entry.content
        editing = entry
    }

    private func editor(
        title: String,
        initial: String,
        commit: @escaping (String) async -> Void
    ) -> some View {
        NavigationStack {
            Form {
                TextField("Memory", text: $draft, axis: .vertical)
                    .lineLimit(3...10)
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismissEditor() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let text = draft
                        dismissEditor()
                        Task { await commit(text) }
                    }
                    .disabled(
                        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
            }
            .onAppear { if draft.isEmpty { draft = initial } }
        }
    }

    private func dismissEditor() {
        editing = nil
        composing = false
    }
}
