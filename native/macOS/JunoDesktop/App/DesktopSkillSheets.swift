import AppKit
import Foundation
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

// MARK: - Import from GitHub

/// Importing skills from a GitHub repository (`import-skills-dialog.tsx`):
/// paste a repository, choose what to install, and the sheet closes onto the
/// library with the page saying what happened. Every skill starts ticked
/// except the ones Juno's scan blocked; ticking grants nothing on its own,
/// which the footer says before the button.
struct DesktopSkillImportSheet: View {
    let model: NativeSkillLibraryModel
    var initialSource: String? = nil
    /// Starts on the choose step with this preview, for a snapshot.
    var initialPreview: NativeSkillImportPreview? = nil
    let installed: (NativeSkillImportOutcome, NativeSkillImportPreview) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var source = ""
    @State private var looking = false
    @State private var installing = false
    @State private var refusal: String?
    @State private var preview: NativeSkillImportPreview?
    @State private var chosen: Set<String> = []
    @State private var renames: [String: String] = [:]
    @State private var filter = ""
    @State private var openDetails: String?
    @State private var didStart = false

    var body: some View {
        Group {
            if let preview {
                choose(preview)
            } else {
                sourceStep
            }
        }
        .frame(width: 600, height: preview == nil ? 300 : 620)
        .task {
            guard !didStart else { return }
            didStart = true
            if let initialPreview {
                show(initialPreview)
            } else if let initialSource, !initialSource.isEmpty {
                await look(initialSource)
            }
        }
    }

    // MARK: Step 1

    private var sourceStep: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Import from GitHub")
                    .junoType(.heading)
                    .accessibilityAddTraits(.isHeader)
                Text("Paste a repository. You’ll choose which skills to install.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            HStack(spacing: JunoSpace.snug) {
                TextField("owner/repo or a GitHub link", text: $source)
                    .textFieldStyle(.plain)
                    .junoType(.ui)
                    .disabled(looking)
                    .onSubmit { Task { await look(source) } }
                    .padding(.horizontal, JunoSpace.cozy)
                    .frame(height: 36)
                    .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoCanvas))
                    .overlay(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).strokeBorder(Color.junoInput, lineWidth: 1))
                    .accessibilityLabel("Repository")
                Button(looking ? "Looking…" : "Continue") { Task { await look(source) } }
                    .buttonStyle(.junoProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(looking || source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .contentShape(.rect)
            }
            if let refusal {
                DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(refusal) }
            }
            DesktopPopularSources(disabled: looking) { repository in
                Task { await look(repository) }
            }
            Spacer(minLength: 0)
            HStack {
                Text("Private repositories need GitHub connected in Connections.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .tint(nil)
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.roomy)
    }

    // MARK: Step 2

    private func choose(_ preview: NativeSkillImportPreview) -> some View {
        let needle = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let visible = needle.isEmpty ? preview.skills : preview.skills.filter {
            $0.name.lowercased().contains(needle) || $0.slug.contains(needle) || $0.description.lowercased().contains(needle)
        }
        let selectable = visible.filter { !$0.installed }
        let problems = NativeSkillRules.renameProblems(preview.skills, chosen: chosen, renames: renames)
        let installedCount = preview.skills.filter(\.installed).count
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack(spacing: JunoSpace.cozy) {
                    DesktopOwnerTile(owner: preview.repository.owner)
                    VStack(alignment: .leading, spacing: JunoSpace.micro) {
                        Text("\(preview.repository.owner)/\(preview.repository.repo)")
                            .junoType(.heading)
                            .lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                        HStack(spacing: JunoSpace.tight) {
                            Text("\(preview.repository.ref)@\(NativeSkillRules.shortCommit(preview.repository.commit))")
                                .junoType(.micro)
                            Text("·")
                            Text("\(preview.skills.count) \(preview.skills.count == 1 ? "skill" : "skills")")
                            if installedCount > 0 {
                                Text("·")
                                Text("\(installedCount) already installed")
                            }
                        }
                        .junoType(.ui)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                HStack(spacing: JunoSpace.cozy) {
                    Toggle("Select all", isOn: Binding(
                        get: { !selectable.isEmpty && selectable.allSatisfy { chosen.contains($0.path) } },
                        set: { on in
                            for skill in selectable {
                                if on { chosen.insert(skill.path) } else { chosen.remove(skill.path) }
                            }
                        }
                    ))
                    .toggleStyle(.checkbox)
                    .junoType(JunoType.ui.weight(.medium))
                    .disabled(selectable.isEmpty || installing)
                    Spacer()
                    if preview.skills.count > 8 {
                        JunoPageSearchField(text: $filter, prompt: "Filter")
                            .frame(maxWidth: 224)
                    }
                }
            }
            .padding(JunoSpace.roomy)
            Divider()
            ScrollView {
                VStack(spacing: 0) {
                    if visible.isEmpty {
                        Text("No skills match “\(filter.trimmingCharacters(in: .whitespacesAndNewlines))”")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(.vertical, JunoSpace.wide)
                    }
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, skill in
                        if index > 0 { DesktopRowDivider() }
                        candidate(skill, problem: problems[skill.path])
                    }
                    if !preview.problems.isEmpty {
                        DesktopRowDivider()
                        Text(preview.problems.count == 1 ? "1 SKILL.md couldn’t be read" : "\(preview.problems.count) SKILL.md files couldn’t be read")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, JunoSpace.roomy)
                            .padding(.vertical, JunoSpace.cozy)
                    }
                    if preview.more {
                        DesktopRowDivider()
                        Text(moreSentence(preview))
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, JunoSpace.roomy)
                            .padding(.vertical, JunoSpace.cozy)
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if let refusal {
                    DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(refusal) }
                }
                HStack(spacing: JunoSpace.snug) {
                    Text("Imported skills only run when you call them.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Spacer()
                    Button("Back") {
                        refusal = nil
                        self.preview = nil
                    }
                    .tint(nil)
                    .disabled(installing)
                    .contentShape(.rect)
                    Button("Cancel") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .tint(nil)
                        .disabled(installing)
                        .contentShape(.rect)
                    Button(installLabel) { Task { await install(preview) } }
                        .buttonStyle(.junoProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(chosen.isEmpty || !problems.isEmpty || installing)
                        .contentShape(.rect)
                }
            }
            .padding(JunoSpace.roomy)
        }
    }

    private var installLabel: String {
        if installing { return "Installing…" }
        if chosen.isEmpty { return "Choose a Skill" }
        return "Install \(chosen.count) \(chosen.count == 1 ? "Skill" : "Skills")"
    }

    private func moreSentence(_ preview: NativeSkillImportPreview) -> String {
        let read = preview.skills.count + preview.problems.count
        let of = preview.total.map { " of \($0)" } ?? ""
        return "Alevr read the first \(read)\(of) skills in this repository. To reach the rest, paste a link to a folder inside it."
    }

    private func candidate(_ skill: NativeSkillImportCandidate, problem: NativeSkillRules.RenameProblem?) -> some View {
        let checked = !skill.installed && chosen.contains(skill.path)
        let open = openDetails == skill.path
        return HStack(alignment: .top, spacing: JunoSpace.cozy) {
            Toggle(skill.name, isOn: Binding(
                get: { checked },
                set: { on in if on { chosen.insert(skill.path) } else { chosen.remove(skill.path) } }
            ))
            .toggleStyle(.checkbox)
            .labelsHidden()
            .disabled(skill.installed || installing)
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                    Text(skill.name)
                        .junoType(JunoType.ui.weight(.medium))
                        .lineLimit(1)
                    if skill.installed {
                        Text("Installed")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
                if !skill.description.isEmpty {
                    Text(skill.description)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(2)
                }
                if skill.securityStatus == "blocked" {
                    Label("Alevr’s safety check blocked this skill. It would install switched off.", icon: .warning, size: 12)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoWarningInk)
                }
                if skill.slugTaken, !skill.installed, checked {
                    renameField(skill, problem: problem)
                }
                if !skill.droppedTools.isEmpty, !skill.installed {
                    Text("Leaves out tool rules Alevr can’t apply: \(Text(skill.droppedTools.prefix(2).joined(separator: ", ")).font(JunoType.micro.font()))\(skill.droppedTools.count > 2 ? ", …" : "")")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                if open {
                    details(skill)
                }
            }
            .opacity(skill.installed ? 0.6 : 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            DesktopQuietIconButton(
                icon: open ? .chevronUp : .chevronDown,
                label: open ? "Hide details" : "Show details",
                help: open ? "Hide details" : "Details"
            ) {
                openDetails = open ? nil : skill.path
            }
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.cozy)
    }

    private func renameField(_ skill: NativeSkillImportCandidate, problem: NativeSkillRules.RenameProblem?) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.warning, size: 12).foregroundStyle(Color.junoWarningInk)
                Text("\(Text(verbatim: "/\(skill.slug)").font(JunoType.micro.font()).foregroundStyle(Color.junoForeground)) is taken. Install as")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                HStack(spacing: 0) {
                    Text("/").font(JunoType.micro.font()).foregroundStyle(Color.junoSecondaryInk)
                    TextField("", text: Binding(
                        get: { renames[skill.path] ?? "" },
                        set: { renames[skill.path] = $0.lowercased().replacingOccurrences(of: " ", with: "-") }
                    ))
                    .textFieldStyle(.plain)
                    .font(JunoType.micro.font())
                    .accessibilityLabel("New slash name for \(skill.name)")
                }
                .padding(.horizontal, JunoSpace.snug)
                .frame(width: 192, height: 28)
                .background(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous).fill(Color.junoCanvas))
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .strokeBorder(problem == nil ? Color.junoInput : Color.junoDestructive.opacity(0.6), lineWidth: 1)
                )
            }
            if let problem {
                Text(problem.sentence)
                    .junoType(.caption)
                    .foregroundStyle(Color.junoDestructiveInk)
            }
        }
    }

    private func details(_ skill: NativeSkillImportCandidate) -> some View {
        Grid(alignment: .leading, horizontalSpacing: JunoSpace.regular, verticalSpacing: JunoSpace.micro * 2) {
            GridRow {
                Text("Path").foregroundStyle(Color.junoSecondaryInk)
                Text(skill.path).font(JunoType.micro.font()).lineLimit(1)
            }
            if let license = skill.license {
                GridRow {
                    Text("License").foregroundStyle(Color.junoSecondaryInk)
                    Text(license)
                }
            }
            GridRow {
                Text("Asks for").foregroundStyle(Color.junoSecondaryInk)
                if skill.requestedTools.isEmpty {
                    Text("No tools")
                } else {
                    Text(skill.requestedTools.joined(separator: ", ")).font(JunoType.micro.font())
                }
            }
            if !skill.companionFiles.isEmpty {
                GridRow {
                    Text("Other files").foregroundStyle(Color.junoSecondaryInk)
                    Text("\(skill.companionFiles.count) beside it, listed and not installed")
                }
            }
            if let compatibility = skill.compatibility {
                GridRow {
                    Text("Works with").foregroundStyle(Color.junoSecondaryInk)
                    Text(compatibility)
                }
            }
        }
        .junoType(.caption)
        .padding(.top, JunoSpace.tight)
    }

    // MARK: Actions

    private func show(_ preview: NativeSkillImportPreview) {
        self.preview = preview
        chosen = preview.defaultChoice
        renames = preview.defaultRenames
    }

    private func look(_ raw: String) async {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let accountID = model.currentAccountID else { return }
        source = trimmed
        looking = true
        refusal = nil
        let result = await model.skillsClient.previewImport(source: trimmed, for: accountID)
        looking = false
        if let value = result.value {
            show(value)
        } else {
            refusal = result.message(fallback: "Couldn’t look inside that repository. Nothing was installed.")
        }
    }

    private func install(_ preview: NativeSkillImportPreview) async {
        guard let accountID = model.currentAccountID else { return }
        let paths = preview.skills.filter { chosen.contains($0.path) }.map(\.path)
        guard !paths.isEmpty else { return }
        installing = true
        refusal = nil
        let takenPaths = Set(preview.skills.filter(\.slugTaken).map(\.path))
        let result = await model.skillsClient.install(
            source: source.isEmpty ? "\(preview.repository.owner)/\(preview.repository.repo)" : source,
            commit: preview.repository.commit,
            paths: paths,
            renames: renames.filter { chosen.contains($0.key) && takenPaths.contains($0.key) },
            for: accountID
        )
        installing = false
        if let outcome = result.value {
            installed(outcome, preview)
            dismiss()
        } else {
            refusal = result.message(fallback: "Couldn’t install those skills. Nothing was saved.")
        }
    }
}

// MARK: - Update a source

/// Bringing an installed repository up to date, skill by skill
/// (`update-source-dialog.tsx`). Nothing upstream lands unread: the sheet
/// sends back the commit it was shown and the paths the reader kept ticked.
struct DesktopSkillUpdateSheet: View {
    let model: NativeSkillLibraryModel
    let source: NativeSkillSource
    /// Starts with this answer, for a snapshot.
    var initialCheck: NativeSkillSourceCheck? = nil
    let updated: (NativeSkillSourceUpdateResult) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var check: NativeSkillSourceCheck?
    @State private var failure: String?
    @State private var picked: Set<String> = []
    @State private var applying = false
    @State private var refusal: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: JunoSpace.cozy) {
                DesktopOwnerTile(owner: source.owner)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text("Update \(source.label)")
                        .junoType(.heading)
                        .lineLimit(1)
                        .accessibilityAddTraits(.isHeader)
                    HStack(spacing: JunoSpace.tight) {
                        Text(NativeSkillRules.shortCommit(source.commit))
                        let to = check?.latestCommit ?? source.latestCommit
                        if let to, !to.isEmpty, to != source.commit {
                            JunoIconView(.arrowRight, size: 10)
                            Text(NativeSkillRules.shortCommit(to))
                        }
                    }
                    .junoType(.micro)
                    .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            .padding(JunoSpace.roomy)
            Divider()
            Group {
                if let check {
                    if !check.hasChoices {
                        upToDate(check)
                    } else {
                        choices(check)
                    }
                } else if let failure {
                    VStack(alignment: .leading, spacing: JunoSpace.regular) {
                        DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                            Text(failure)
                        } action: {
                            Button("Try Again") { Task { await run() } }
                                .buttonStyle(.junoGlass)
                                .tint(nil)
                                .controlSize(.small)
                                .contentShape(.rect)
                        }
                        Spacer()
                        HStack {
                            Spacer()
                            Button("Cancel") { dismiss() }
                                .keyboardShortcut(.cancelAction)
                                .tint(nil)
                                .contentShape(.rect)
                        }
                    }
                    .padding(JunoSpace.roomy)
                } else {
                    JunoSkeletonRows(count: 3, showsMark: false)
                        .padding(JunoSpace.roomy)
                        .accessibilityLabel("Checking for updates")
                    Spacer()
                }
            }
        }
        .frame(width: 560, height: 520)
        .task {
            if let initialCheck {
                apply(initialCheck)
            } else if check == nil {
                await run()
            }
        }
    }

    private func upToDate(_ check: NativeSkillSourceCheck) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Label("Up to date. Every installed skill matches the repository.", icon: .circleCheck, size: 15)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
            if !check.removed.isEmpty {
                Text(check.removed.count == 1
                    ? "One installed skill is no longer in the repository. It stays installed here."
                    : "\(check.removed.count) installed skills are no longer in the repository. They stay installed here.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.leading, JunoSpace.section)
            }
            Spacer()
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .tint(nil)
                    .contentShape(.rect)
            }
        }
        .padding(JunoSpace.roomy)
    }

    private func choices(_ check: NativeSkillSourceCheck) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    group("Changed", check.changed) { change in
                        change.widensPermissions
                            ? AnyView(Label("Asks for more tools. You’ll approve them on the skill’s page before it runs.", icon: .warning, size: 12)
                                .foregroundStyle(Color.junoWarningInk))
                            : AnyView(Text("New instructions"))
                    }
                    group("New in this repository", check.added) { _ in AnyView(Text("Not installed yet")) }
                    if check.more {
                        Text("This repository has more skills than Alevr reads at once, so some new ones may not be listed.")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(.horizontal, JunoSpace.roomy)
                            .padding(.bottom, JunoSpace.cozy)
                    }
                    if !check.removed.isEmpty {
                        Text("Removed upstream")
                            .junoType(JunoType.caption.weight(.medium))
                            .foregroundStyle(Color.junoSecondaryInk)
                            .padding(.horizontal, JunoSpace.roomy)
                            .padding(.top, JunoSpace.cozy)
                        ForEach(check.removed) { change in
                            HStack {
                                Text(change.name).junoType(.ui).lineLimit(1)
                                Spacer()
                                Text("Kept here").junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                            }
                            .padding(.leading, JunoSpace.roomy + 26)
                            .padding(.trailing, JunoSpace.roomy)
                            .padding(.vertical, JunoSpace.snug)
                        }
                    }
                }
                .padding(.vertical, JunoSpace.snug)
            }
            Divider()
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                if let refusal {
                    DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(refusal) }
                }
                HStack(spacing: JunoSpace.snug) {
                    Spacer()
                    Button("Later") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .tint(nil)
                        .disabled(applying)
                        .contentShape(.rect)
                    Button(applyLabel(check)) { Task { await applyUpdate(check) } }
                        .buttonStyle(.junoProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(picked.isEmpty || applying)
                        .contentShape(.rect)
                }
            }
            .padding(JunoSpace.roomy)
        }
    }

    private func group(
        _ title: String,
        _ changes: [NativeSkillSourceChange],
        note: @escaping (NativeSkillSourceChange) -> AnyView
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !changes.isEmpty {
                Text(title)
                    .junoType(JunoType.caption.weight(.medium))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.top, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.tight)
                ForEach(changes) { change in
                    HStack(alignment: .top, spacing: JunoSpace.cozy) {
                        Toggle(change.name, isOn: Binding(
                            get: { picked.contains(change.path) },
                            set: { on in if on { picked.insert(change.path) } else { picked.remove(change.path) } }
                        ))
                        .toggleStyle(.checkbox)
                        .labelsHidden()
                        .disabled(applying)
                        VStack(alignment: .leading, spacing: JunoSpace.micro) {
                            Text(change.name).junoType(JunoType.ui.weight(.medium))
                            note(change)
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.vertical, JunoSpace.snug)
                }
            }
        }
    }

    private func applyLabel(_ check: NativeSkillSourceCheck) -> String {
        if applying { return "Updating…" }
        if picked.isEmpty { return "Choose a Skill" }
        let installsOnly = !check.changed.contains { picked.contains($0.path) }
        return "\(installsOnly ? "Install" : "Update") \(picked.count) \(picked.count == 1 ? "Skill" : "Skills")"
    }

    private func apply(_ check: NativeSkillSourceCheck) {
        self.check = check
        picked = Set(check.changed.map(\.path))
    }

    private func run() async {
        guard let accountID = model.currentAccountID else { return }
        check = nil
        failure = nil
        refusal = nil
        let result = await model.skillsClient.checkSource(id: source.id, for: accountID)
        if let value = result.value {
            apply(value)
        } else {
            failure = result.message(fallback: "Couldn’t check this repository for updates. Nothing has changed.")
        }
    }

    private func applyUpdate(_ check: NativeSkillSourceCheck) async {
        guard let accountID = model.currentAccountID else { return }
        applying = true
        refusal = nil
        let result = await model.skillsClient.updateSource(
            id: source.id,
            commit: check.latestCommit,
            update: check.changed.filter { picked.contains($0.path) }.map(\.path),
            install: check.added.filter { picked.contains($0.path) }.map(\.path),
            for: accountID
        )
        applying = false
        switch result {
        case .ok(let value):
            updated(value)
            dismiss()
        case .blocked(let reason, _) where reason == "source_moved":
            await run()
            refusal = "The repository changed while you were looking. This is what it holds now."
        default:
            refusal = result.message(fallback: "Couldn’t apply the update. Every skill is as it was.")
        }
    }
}

// MARK: - Move to a project

/// Filing a skill in a project, or taking it out of one
/// (`MoveSkillDialog`): a filed skill is offered to that project's tasks and
/// no others; typing its slash name reaches it from anywhere.
struct DesktopSkillMoveSheet: View {
    let slug: String
    let current: String?
    let projects: [DesktopMemoryProject]
    let move: (String?) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var choice: String?
    @State private var busy = false
    @State private var didSeed = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Move to a project")
                    .junoType(.heading)
                    .accessibilityAddTraits(.isHeader)
                Text("Alevr picks a filed skill only for that project’s tasks. Typing \(desktopSlugText(slug)) works anywhere.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                DesktopListCard {
                    option(nil, "No project")
                    ForEach(projects) { project in
                        DesktopRowDivider()
                        option(project.id, project.name)
                    }
                }
            }
            .frame(maxHeight: 280)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .tint(nil)
                    .disabled(busy)
                    .contentShape(.rect)
                Button("Move") {
                    Task {
                        busy = true
                        let ok = await move(choice)
                        busy = false
                        if ok { dismiss() }
                    }
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(busy || choice == current)
                .contentShape(.rect)
            }
        }
        .padding(JunoSpace.roomy)
        .frame(width: 440)
        .onAppear {
            guard !didSeed else { return }
            didSeed = true
            choice = current
        }
    }

    private func option(_ id: String?, _ name: String) -> some View {
        Button {
            choice = id
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                JunoRadioMark(isOn: choice == id)
                Text(name)
                    .junoType(.ui)
                    .foregroundStyle(id == nil ? Color.junoSecondaryInk : Color.junoForeground)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, JunoSpace.regular)
            .frame(minHeight: 40)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityAddTraits(choice == id ? [.isButton, .isSelected] : .isButton)
    }
}
