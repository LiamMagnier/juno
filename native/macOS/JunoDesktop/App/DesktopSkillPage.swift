import AppKit
import Foundation
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

/// The state of one skill's page.
@MainActor
@Observable
final class DesktopSkillPageModel {
    enum Load: Equatable {
        case loading, ready, missing, failed
    }

    private(set) var load: Load = .loading
    private(set) var detail: NativeSkillDetail?
    /// Nil while the history is loading, which is not the same as failing.
    private(set) var versions: [NativeSkillVersion]?
    private(set) var versionsFailed = false
    private(set) var busy = false

    let id: String
    private let library: NativeSkillLibraryModel

    init(id: String, library: NativeSkillLibraryModel) {
        self.id = id
        self.library = library
    }

    /// For a snapshot: a page in a known state, no request made.
    init(preview detail: NativeSkillDetail, versions: [NativeSkillVersion]?, library: NativeSkillLibraryModel) {
        id = detail.skill.id
        self.library = library
        self.detail = detail
        self.versions = versions
        load = .ready
    }

    private var client: NativeSkillsClient { library.skillsClient }

    func reload() async {
        guard let accountID = library.currentAccountID else { return }
        let result = await client.skill(id: id, for: accountID)
        switch result {
        case .ok(let value):
            detail = value
            load = .ready
        case .failed(.notFound, _):
            load = .missing
        default:
            if detail == nil { load = .failed }
        }
    }

    func reloadVersions() async {
        guard let accountID = library.currentAccountID else { return }
        versionsFailed = false
        let result = await client.versions(id: id, for: accountID)
        if let value = result.value {
            versions = value
        } else {
            versions = nil
            versionsFailed = true
        }
    }

    /// Returns the sentence when the server refused.
    private func patch(_ patch: NativeSkillPatch, failure: String) async -> String? {
        guard let accountID = library.currentAccountID else { return failure }
        busy = true
        defer { busy = false }
        let result = await client.patch(id: id, patch, for: accountID)
        if let skill = result.value {
            detail?.skill = skill
            _ = await library.refresh()
            return nil
        }
        return result.message(fallback: failure)
    }

    func setEnabled(_ enabled: Bool) async -> String? {
        let before = detail?.skill.enabled
        detail?.skill.enabled = enabled
        let sentence = await patch(NativeSkillPatch(enabled: enabled), failure: "Couldn’t change that. The skill is as it was.")
        if sentence != nil, let before { detail?.skill.enabled = before }
        return sentence
    }

    func setSourceEnabled(_ enabled: Bool) async -> String? {
        guard let source = detail?.source else { return nil }
        busy = true
        defer { busy = false }
        if let sentence = await library.setSourceEnabled(source, enabled) { return sentence }
        detail?.source?.enabled = enabled
        return nil
    }

    func setUsage(automatic: Bool) async -> String? {
        guard let detail else { return nil }
        let patch = NativeSkillRules.usagePatch(
            automatic: automatic, skill: detail.skill, isInstalled: detail.version?.provenance != nil
        )
        return await self.patch(patch, failure: "Couldn’t change how Alevr uses this skill. It is as it was.")
    }

    func move(to projectID: String?) async -> String? {
        let sentence = await patch(
            NativeSkillPatch(projectID: .some(projectID)), failure: "Couldn’t move this skill. It is filed where it was."
        )
        if sentence == nil { await reload() }
        return sentence
    }

    func consent() async -> (ok: Bool, sentence: String) {
        guard let accountID = library.currentAccountID, let version = detail?.version, version.requiresConsent else {
            return (false, "Couldn’t approve it. Nothing about the skill has changed.")
        }
        busy = true
        defer { busy = false }
        let result = await client.consent(id: id, version: version.version, for: accountID)
        if let approved = result.value {
            detail?.version = approved
            await reloadVersions()
            _ = await library.refresh()
            return (true, "Approved. The skill can run again.")
        }
        return (false, result.message(fallback: "Couldn’t approve it. Nothing about the skill has changed."))
    }

    func restore(_ version: Int) async -> (ok: Bool, sentence: String) {
        guard let accountID = library.currentAccountID else { return (false, "Couldn’t restore that version. Nothing changed.") }
        busy = true
        defer { busy = false }
        let result = await client.restoreVersion(id: id, version: version, for: accountID)
        if let minted = result.value {
            await reload()
            await reloadVersions()
            return (true, "Version \(version) is back, saved as version \(minted.version).")
        }
        return (false, result.message(fallback: "Couldn’t restore that version. Nothing changed."))
    }

    /// Saves an edit of a skill you wrote: the name and description on the
    /// skill, and the instructions as a new version that sends the rest of
    /// the declaration back whole.
    func save(name: String, description: String, instructions: String) async -> (ok: Bool, sentence: String?) {
        guard let accountID = library.currentAccountID, let detail else { return (false, nil) }
        if name != detail.skill.name || description != detail.skill.description {
            if let sentence = await patch(
                NativeSkillPatch(name: name, description: description),
                failure: "Couldn’t save the name and description. Nothing was saved."
            ) {
                return (false, sentence)
            }
        }
        let rewritten = detail.version == nil
            || instructions != detail.version?.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard rewritten else { return (true, "Saved.") }
        busy = true
        defer { busy = false }
        let result = await client.mintVersion(
            id: id,
            instructions: instructions,
            contract: detail.version?.contract,
            requestedTools: detail.version?.requestedTools,
            for: accountID
        )
        switch result {
        case .ok(let version):
            self.detail?.version = version
            self.detail?.skill.currentVersion = version.version
            self.detail?.skill.securityStatus = version.securityStatus
            await reloadVersions()
            return (true, "Saved as version \(version.version).")
        case .blocked:
            return (false, "Someone else saved this skill at the same moment. Reload and try again.")
        case .failed:
            return (false, result.message(fallback: "Couldn’t save this version. The current one is unchanged."))
        }
    }

    func delete() async -> String? {
        guard let accountID = library.currentAccountID else { return "Couldn’t delete this skill. It is exactly as it was." }
        busy = true
        defer { busy = false }
        let result = await client.delete(id: id, for: accountID)
        if case .ok = result {
            _ = await library.refresh()
            return nil
        }
        return result.message(fallback: "Couldn’t delete this skill. It is exactly as it was.")
    }
}

// MARK: - The page

/// One skill (`skill-detail-view.tsx`): what it says, how Juno may use it,
/// and what it used to say. Read first, edit second: the instructions render
/// as the document they are, an installed skill is read-only, and a skill
/// you wrote gets Edit, which saves a new version.
struct DesktopSkillPage: View {
    @State var model: DesktopSkillPageModel
    let projects: [DesktopMemoryProject]
    /// Starts in the editor, for a snapshot.
    var startsEditing = false

    @Environment(\.junoToast) private var toast
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var tab = DesktopSkillTab.instructions
    @State private var moving = false
    @State private var confirmation: JunoConfirmation?

    var body: some View {
        Group {
            switch model.load {
            case .loading:
                frame(title: "Skill") {
                    VStack(alignment: .leading, spacing: JunoSpace.section) {
                        JunoSkeleton(height: 96, cornerRadius: JunoRadius.card)
                        JunoSkeleton(height: 32, width: 260, cornerRadius: JunoRadius.menu)
                        JunoSkeleton(height: 240, cornerRadius: JunoRadius.card)
                    }
                    .accessibilityLabel("Loading skill")
                }
            case .missing:
                frame(title: "Skill not found") {
                    DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                        Text("This skill no longer exists. It may have been deleted on another device.")
                    }
                }
            case .failed:
                frame(title: "Skill") {
                    DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                        Text("Couldn’t load this skill. Nothing has been changed by the attempt.")
                    } action: {
                        Button("Retry") { Task { await model.reload() } }
                            .buttonStyle(.bordered)
                            .tint(nil)
                            .controlSize(.small)
                            .contentShape(.rect)
                    }
                }
            case .ready:
                if let detail = model.detail {
                    ready(detail)
                }
            }
        }
        .task {
            if model.detail == nil {
                await model.reload()
            }
            if model.versions == nil, !model.versionsFailed, model.detail != nil || model.load == .loading {
                await model.reloadVersions()
            }
            if startsEditing { editing = true }
        }
        .junoConfirmation($confirmation)
        .sheet(isPresented: $moving) {
            if let detail = model.detail {
                DesktopSkillMoveSheet(
                    slug: detail.skill.slug,
                    current: detail.skill.projectID,
                    projects: projects
                ) { projectID in
                    let sentence = await model.move(to: projectID)
                    if let sentence { toast(.error(sentence)) }
                    return sentence == nil
                }
            }
        }
    }

    private func frame<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        JunoPage(measure: .reading) {
            JunoPageHeader(title, caption: "Skills")
        } content: {
            content()
        }
    }

    private func ready(_ detail: NativeSkillDetail) -> some View {
        let skill = detail.skill
        let provenance = detail.version?.provenance
        let yours = provenance == nil
        let status = detail.version?.securityStatus ?? skill.securityStatus
        let blocked = status == "blocked"
        return JunoPage(measure: .reading) {
            JunoPageHeader(skill.name, caption: "Skills", lede: skill.description.isEmpty ? nil : skill.description) {
                HStack(spacing: JunoSpace.cozy) {
                    Text(skill.enabled && !blocked ? "On" : "Off")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .accessibilityHidden(true)
                    Toggle("Use this skill", isOn: Binding(
                        get: { skill.enabled && !blocked },
                        set: { on in Task { if let sentence = await model.setEnabled(on) { toast(.error(sentence)) } } }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .tint(Color.junoAccent)
                    .disabled(model.busy || blocked)
                    DesktopRowMenuButton(accessibilityLabel: "More") {
                        Section {
                            if yours {
                                Button { editing = true } label: { Label("Edit", image: JunoIcon.edit.assetName) }
                                    .disabled(editing)
                            }
                            if let url = sourceURL(detail) {
                                Button { NSWorkspace.shared.open(url) } label: {
                                    Label("View on GitHub", image: JunoIcon.github.assetName)
                                }
                            }
                            Button { moving = true } label: { Label("Move to Project…", image: JunoIcon.projects.assetName) }
                            Divider()
                            Button(role: .destructive) {
                                confirmation = deletion(skill)
                            } label: { Label("Delete…", image: JunoIcon.delete.assetName) }
                        }
                    }
                }
            }
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.wide) {
                meta(detail)
                if editing {
                    DesktopSkillEditor(
                        name: skill.name,
                        description: skill.description,
                        instructions: detail.version?.instructions ?? "",
                        slug: skill.slug,
                        missingVersion: detail.version == nil,
                        resources: detail.resources
                    ) { name, description, instructions in
                        let outcome = await model.save(name: name, description: description, instructions: instructions)
                        if let sentence = outcome.sentence {
                            toast(outcome.ok ? .success(sentence) : .error(sentence))
                        }
                        if outcome.ok { editing = false }
                        return outcome.ok
                    } cancel: {
                        editing = false
                    }
                } else {
                    if hasNotices(detail) {
                        notices(detail)
                    }
                    usage(detail, disabled: model.busy || blocked)
                    tabs(detail, yours: yours)
                }
            }
        }
    }

    // MARK: Meta

    /// Where it came from, what you type to call it, and which version this
    /// is — the line that closes the header.
    private func meta(_ detail: NativeSkillDetail) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            if let provenance = detail.version?.provenance {
                Button {
                    if let url = sourceURL(detail) { NSWorkspace.shared.open(url) }
                } label: {
                    HStack(spacing: JunoSpace.tight) {
                        DesktopOwnerTile(owner: provenance.owner, side: 18)
                        Text("\(provenance.owner)/\(provenance.repo)")
                            .junoType(JunoType.caption.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                        if let commit = provenance.commit {
                            Text("@\(NativeSkillRules.shortCommit(commit))")
                                .junoType(.micro)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        JunoIconView(.external, size: 11)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    .padding(.leading, JunoSpace.hairline)
                    .padding(.trailing, JunoSpace.snug)
                    .frame(height: 28)
                    .overlay(Capsule(style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
                    .contentShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .help("Opens GitHub")
            } else {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.skills, size: 12)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Text("Yours")
                        .junoType(JunoType.caption.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                }
                .padding(.horizontal, JunoSpace.snug)
                .frame(height: 28)
                .overlay(Capsule(style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
            }
            Text("Type \(desktopSlugText(detail.skill.slug))  ·  Version \(Text(detail.skill.currentVersion, format: .number))")
                .junoType(.ui)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
        }
    }

    // MARK: Notices

    @ViewBuilder
    private func notices(_ detail: NativeSkillDetail) -> some View {
        let status = detail.version?.securityStatus ?? detail.skill.securityStatus
        let findings = detail.version?.findings ?? []
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let source = detail.source, !source.enabled {
                DesktopNoteBand(icon: .info) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("\(source.label) is switched off").fontWeight(.medium)
                        Text("This skill won’t run, or show in chat, until the repository it came from is back on.")
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                } action: {
                    Button("Turn on") {
                        Task { if let sentence = await model.setSourceEnabled(true) { toast(.error(sentence)) } }
                    }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .controlSize(.small)
                    .disabled(model.busy)
                    .contentShape(.rect)
                }
            }
            if detail.version?.requiresConsent == true, status != "blocked" {
                DesktopNoteBand(icon: .warning, tone: Color.junoWarningInk) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("This version asks for more than the last one").fontWeight(.medium)
                        Text("It won’t run until you approve what it asks for.")
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                } action: {
                    Button("Approve") {
                        Task {
                            let outcome = await model.consent()
                            toast(outcome.ok ? .success(outcome.sentence) : .error(outcome.sentence))
                        }
                    }
                    .buttonStyle(.junoProminent)
                    .controlSize(.small)
                    .disabled(model.busy)
                    .contentShape(.rect)
                }
            }
            if status == "blocked" {
                DesktopNoteBand(icon: .circleSlash, tone: Color.junoDestructiveInk) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("Blocked by Alevr’s safety check").fontWeight(.medium)
                        Text("This version can’t run or be switched on.")
                            .foregroundStyle(Color.junoSecondaryInk)
                        findingList(findings)
                    }
                }
            } else if status == "warning" {
                DesktopNoteBand(icon: .warning, tone: Color.junoWarningInk) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        Text("Alevr’s safety check flagged something").fontWeight(.medium)
                        Text("It can still run. Read the instructions before you rely on it.")
                            .foregroundStyle(Color.junoSecondaryInk)
                        findingList(findings)
                    }
                }
            } else if status == "pending" {
                DesktopNoteBand(icon: .info) {
                    Text("Alevr hasn’t checked this version yet. It’s checked before a task uses it.")
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        }
    }

    private func hasNotices(_ detail: NativeSkillDetail) -> Bool {
        let status = detail.version?.securityStatus ?? detail.skill.securityStatus
        return detail.source?.enabled == false || detail.version?.requiresConsent == true
            || ["blocked", "warning", "pending"].contains(status)
    }

    @ViewBuilder
    private func findingList(_ findings: [String]) -> some View {
        if !findings.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                ForEach(Array(findings.prefix(6).enumerated()), id: \.offset) { _, finding in
                    Text("•  \(finding)")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            .padding(.top, JunoSpace.tight)
        }
    }

    // MARK: Usage

    private func usage(_ detail: NativeSkillDetail, disabled: Bool) -> some View {
        let skill = detail.skill
        let automatic = NativeSkillRules.isAutomatic(skill)
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Usage")
                .junoType(JunoType.body.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            DesktopListCard {
                DesktopSkillUsageOption(
                    title: "Only when I call it",
                    detail: Text("Type \(desktopSlugText(skill.slug, emphasised: false)) in chat, or pick it from the + menu."),
                    isSelected: !automatic,
                    disabled: disabled
                ) {
                    Task { if let sentence = await model.setUsage(automatic: false) { toast(.error(sentence)) } }
                }
                DesktopRowDivider()
                DesktopSkillUsageOption(
                    title: "Automatically when relevant",
                    detail: Text(NativeSkillRules.trustPermitsAutoSelection(skill.trust)
                        ? "Alevr picks it when your request matches its description."
                        : "Alevr picks it when your request matches its description. Choosing this trusts its instructions."),
                    isSelected: automatic,
                    disabled: disabled
                ) {
                    Task { if let sentence = await model.setUsage(automatic: true) { toast(.error(sentence)) } }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Usage")
            if skill.projectID != nil {
                HStack(spacing: JunoSpace.tight) {
                    Text("Filed in \(Text(detail.projectName ?? "a project").fontWeight(.medium).foregroundStyle(Color.junoForeground)), so Alevr only picks it for that project’s tasks.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Button("Change") { moving = true }
                        .buttonStyle(DesktopUnderlineLinkStyle())
                        .contentShape(.rect)
                }
            }
        }
    }

    // MARK: Tabs

    private func tabs(_ detail: NativeSkillDetail, yours: Bool) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack {
                JunoSegmented(
                    options: [
                        JunoSegmented<DesktopSkillTab>.Option(.instructions, "Instructions"),
                        JunoSegmented<DesktopSkillTab>.Option(
                            .files, "Files", count: detail.resources.isEmpty ? nil : detail.resources.count
                        ),
                        JunoSegmented<DesktopSkillTab>.Option(.history, "History"),
                    ],
                    selection: $tab,
                    accessibilityLabel: "About this skill"
                )
                .fixedSize()
                Spacer()
                if yours {
                    Button { editing = true } label: { Label("Edit", icon: .edit, size: 13) }
                        .buttonStyle(.bordered)
                        .tint(nil)
                        .contentShape(.rect)
                }
            }
            switch tab {
            case .instructions: instructions(detail)
            case .files: files(detail)
            case .history: history(detail)
            }
        }
    }

    @ViewBuilder
    private func instructions(_ detail: NativeSkillDetail) -> some View {
        if let version = detail.version {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: JunoSpace.cozy) {
                    Text("SKILL.md")
                        .junoType(.micro)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Spacer()
                    if let created = version.createdAt {
                        Text("Saved \(created.formatted(.relative(presentation: .named)))")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    if let url = version.provenance?.url.flatMap(URL.init(string:)) {
                        Button("Source ↗") { NSWorkspace.shared.open(url) }
                            .buttonStyle(DesktopUnderlineLinkStyle())
                            .contentShape(.rect)
                    }
                }
                .padding(.horizontal, JunoSpace.roomy)
                .frame(minHeight: 40)
                DesktopRowDivider()
                Group {
                    if version.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("No instructions yet.")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                    } else {
                        JunoMarkdownText(version.instructions)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(JunoSpace.wide)
            }
            .background(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).fill(Color.junoCard))
            .overlay(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
        } else {
            DesktopNoteBand(icon: .warning, tone: Color.junoWarningInk) {
                Text("This skill points at a version that isn’t there, so there are no instructions to show.")
            }
        }
    }

    private func files(_ detail: NativeSkillDetail) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if detail.missingResourceCount > 0 {
                DesktopNoteBand(icon: .warning, tone: Color.junoWarningInk) {
                    Text(detail.missingResourceCount == 1
                        ? "One file this version names is no longer in your library."
                        : "Some files this version names are no longer in your library.")
                }
            }
            if detail.resources.isEmpty {
                Text("This skill brings no files of its own.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, JunoSpace.section)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                            .strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    )
            } else {
                DesktopListCard {
                    ForEach(Array(detail.resources.enumerated()), id: \.element.id) { index, resource in
                        if index > 0 { DesktopRowDivider() }
                        HStack(spacing: JunoSpace.close) {
                            JunoIconView(.file, size: 15)
                                .foregroundStyle(Color.junoSecondaryInk)
                            Text(resource.fileName)
                                .junoType(.ui)
                                .lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, JunoSpace.regular)
                        .frame(minHeight: 40)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func history(_ detail: NativeSkillDetail) -> some View {
        if let versions = model.versions {
            DesktopListCard {
                ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                    if index > 0 { DesktopRowDivider() }
                    HStack(spacing: JunoSpace.cozy) {
                        Text("Version \(Text(version.version, format: .number))")
                            .junoType(JunoType.ui.weight(.medium))
                            .monospacedDigit()
                            .frame(width: 84, alignment: .leading)
                        Text(firstLine(version.instructions))
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let created = version.createdAt {
                            Text(created.formatted(.relative(presentation: .named)))
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        if version.version == detail.skill.currentVersion {
                            Text("Current")
                                .junoType(JunoType.caption.weight(.medium))
                                .foregroundStyle(Color.junoForeground)
                                .frame(width: 72, alignment: .trailing)
                        } else {
                            Button {
                                Task {
                                    let outcome = await model.restore(version.version)
                                    toast(outcome.ok ? .success(outcome.sentence) : .error(outcome.sentence))
                                }
                            } label: {
                                Label("Restore", icon: .restore, size: 13)
                            }
                            .buttonStyle(.borderless)
                            .tint(nil)
                            .disabled(model.busy)
                            .frame(width: 72, alignment: .trailing)
                            .contentShape(.rect)
                        }
                    }
                    .padding(.horizontal, JunoSpace.regular)
                    .frame(minHeight: 44)
                }
            }
        } else if model.versionsFailed {
            DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) {
                Text("Couldn’t load the history. Nothing about the skill has changed.")
            } action: {
                Button("Try again") { Task { await model.reloadVersions() } }
                    .buttonStyle(.bordered)
                    .tint(nil)
                    .controlSize(.small)
                    .contentShape(.rect)
            }
        } else {
            JunoSkeletonRows(count: 2, showsMark: false)
        }
    }

    private func firstLine(_ instructions: String) -> String {
        instructions
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "# ").union(.whitespaces)) }
            .first { !$0.isEmpty } ?? ""
    }

    // MARK: Actions

    private func sourceURL(_ detail: NativeSkillDetail) -> URL? {
        guard let provenance = detail.version?.provenance else { return nil }
        let raw = provenance.url ?? detail.source?.url ?? "https://github.com/\(provenance.owner)/\(provenance.repo)"
        return URL(string: raw)
    }

    private func deletion(_ skill: NativeSkill) -> JunoConfirmation {
        JunoConfirmation(
            title: "Delete “\(skill.name)”?",
            message: "It’s removed from your skills and can’t run again. Chats and tasks that used it keep their history.",
            confirmTitle: "Delete"
        ) {
            Task {
                if let sentence = await model.delete() {
                    toast(.error(sentence))
                } else {
                    toast(.success("Skill deleted."))
                    dismiss()
                }
            }
        }
    }
}

enum DesktopSkillTab: Hashable {
    case instructions, files, history
}

/// One Usage choice: a radio mark in the foreground ink (never the accent:
/// a radio is not on the accent budget), the title, the help line.
private struct DesktopSkillUsageOption: View {
    let title: String
    let detail: Text
    let isSelected: Bool
    let disabled: Bool
    let select: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                JunoRadioMark(isOn: isSelected)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(title)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                    detail
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 28)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.comfy)
            .background(isHovering && !disabled ? Color.junoHover : Color.clear)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
        .onHover { isHovering = $0 }
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Editing

/// Editing a skill you wrote (`skill-editor.tsx`): its name, its one line
/// and its instructions, saved together as a new version. Earlier versions
/// stay in History.
struct DesktopSkillEditor: View {
    @State var name: String
    @State var description: String
    @State var instructions: String
    let slug: String
    let missingVersion: Bool
    let resources: [NativeSkillResource]
    let save: (String, String, String) async -> Bool
    let cancel: () -> Void

    @State private var saving = false
    private let initial: (String, String, String)

    init(
        name: String,
        description: String,
        instructions: String,
        slug: String,
        missingVersion: Bool,
        resources: [NativeSkillResource],
        save: @escaping (String, String, String) async -> Bool,
        cancel: @escaping () -> Void
    ) {
        _name = State(initialValue: name)
        _description = State(initialValue: description)
        _instructions = State(initialValue: instructions)
        self.slug = slug
        self.missingVersion = missingVersion
        self.resources = resources
        self.save = save
        self.cancel = cancel
        initial = (name, description, instructions)
    }

    private var trimmed: (String, String, String) {
        (
            name.trimmingCharacters(in: .whitespacesAndNewlines),
            description.trimmingCharacters(in: .whitespacesAndNewlines),
            instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private var valid: Bool { !trimmed.0.isEmpty && !trimmed.2.isEmpty }
    private var changed: Bool {
        trimmed.0 != initial.0 || trimmed.1 != initial.1
            || trimmed.2 != initial.2.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            HStack(alignment: .top, spacing: JunoSpace.roomy) {
                DesktopSkillField(label: "Name", text: $name, help: Text("Still typed as \(desktopSlugText(slug))"))
                DesktopSkillField(label: "Description", text: $description, help: Text("One line. Alevr matches requests against it."))
            }
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Instructions")
                    .junoType(JunoType.ui.weight(.medium))
                if missingVersion {
                    Text("The saved instructions are missing. What you write here becomes the current version.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoWarningInk)
                }
                DesktopMonoEditor(text: $instructions, minHeight: 300)
                Text("Markdown. Write it the way you would brief a person.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            if !resources.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("Files")
                        .junoType(JunoType.ui.weight(.medium))
                    Text("Templates and references the skill works from. Alevr reads them, never runs them.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                    DesktopListCard {
                        ForEach(Array(resources.enumerated()), id: \.element.id) { index, resource in
                            if index > 0 { DesktopRowDivider() }
                            HStack(spacing: JunoSpace.close) {
                                JunoIconView(.file, size: 15).foregroundStyle(Color.junoSecondaryInk)
                                Text(resource.fileName).junoType(.ui).lineLimit(1)
                                Spacer()
                            }
                            .padding(.horizontal, JunoSpace.regular)
                            .frame(minHeight: 36)
                        }
                    }
                }
            }
            Divider()
            HStack(spacing: JunoSpace.snug) {
                Button("Save") {
                    Task {
                        saving = true
                        _ = await save(trimmed.0, trimmed.1, trimmed.2)
                        saving = false
                    }
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut("s", modifiers: .command)
                .disabled(!valid || !changed || saving)
                .contentShape(.rect)
                Button("Cancel", action: cancel)
                    .buttonStyle(.borderless)
                    .tint(nil)
                    .disabled(saving)
                    .contentShape(.rect)
                Spacer()
                Text("Saving makes a new version. Earlier ones stay in History.")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }
}

/// A labelled one-line field in the page's field recipe.
struct DesktopSkillField: View {
    let label: String
    @Binding var text: String
    var placeholder: String = ""
    var help: Text? = nil

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(label)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .junoType(.ui)
                .focused($focused)
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 32)
                .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoCanvas))
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(focused ? Color.junoRing : Color.junoInput, lineWidth: 1)
                )
                .accessibilityLabel(label)
            if let help {
                help
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A monospaced multi-line editor in the field recipe: the reader's own
/// instructions, which are code-like text they wrote.
struct DesktopMonoEditor: View {
    @Binding var text: String
    var placeholder: String = ""
    var minHeight: CGFloat = 220

    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .font(JunoType.monoSmall.font())
                .scrollContentBackground(.hidden)
                .focused($focused)
                .padding(JunoSpace.snug)
            if text.isEmpty, !placeholder.isEmpty {
                Text(placeholder)
                    .font(JunoType.monoSmall.font())
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.snug + 5)
                    .padding(.vertical, JunoSpace.snug)
                    .allowsHitTesting(false)
            }
        }
        .frame(minHeight: minHeight)
        .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoCanvas))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(focused ? Color.junoRing : Color.junoInput, lineWidth: 1)
        )
    }
}

// MARK: - New skill

/// Writing a skill (`/skills/new`): a name, one line, and the instructions.
/// A skill written here is yours; where it is filed and whether Juno may
/// pick it on its own are set on its page afterwards. The slash name is
/// derived from the name by the same rule the route uses.
struct DesktopNewSkillPage: View {
    let model: NativeSkillLibraryModel
    let startDraft: (String) -> Void
    /// Words already typed, for a snapshot.
    var initialName = ""
    var initialDescription = ""

    @Environment(\.desktopPush) private var push
    @Environment(\.dismiss) private var dismiss
    @Environment(\.junoToast) private var toast
    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var saving = false
    @State private var reading = false
    @State private var imported: NativeSkillFilePreview?
    @State private var fileError: String?

    @State private var didSeed = false

    private var slug: String? { NativeSkillRules.slug(fromName: name) }
    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && slug != nil && !saving && !reading
    }

    var body: some View {
        JunoPage(measure: .reading) {
            JunoPageHeader("New skill", caption: "Skills", lede: "Instructions Alevr follows when you call it by name.") {
                Button { startDraft(DesktopSkillCopy.createPrompt) } label: {
                    Label("Create with Alevr", icon: .conversation, size: 13)
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
            }
        } content: {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Button(reading ? "Reading…" : "Import SKILL.md") { pickSkillFile() }
                        .buttonStyle(.bordered)
                        .disabled(saving || reading)
                        .contentShape(.rect)
                    Text(imported == nil ? "Bring a skill from your computer, or write one below." : "File loaded. Review the instructions before saving. Attach referenced files separately.")
                        .junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                    if let imported, !imported.ignoredSettings.isEmpty {
                        Text("Settings that don’t apply in Alevr: \(imported.ignoredSettings.joined(separator: ", ")).")
                            .junoType(.caption).foregroundStyle(Color.junoSecondaryInk)
                    }
                    if let fileError {
                        DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(fileError) }
                    }
                }
                DesktopSkillField(
                    label: "Name",
                    text: $name,
                    placeholder: "File the invoices",
                    help: slug.map { Text("Type \(desktopSlugText($0)) in chat to use it.") }
                        ?? Text("Use at least one letter or number.")
                )
                DesktopSkillField(
                    label: "Description",
                    text: $description,
                    placeholder: "Sorts incoming invoices into the right folder and renames them.",
                    help: Text("One line. Alevr reads it to decide when the skill fits.")
                )
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("Instructions")
                        .junoType(JunoType.ui.weight(.medium))
                    DesktopMonoEditor(
                        text: $instructions,
                        placeholder: "Write it the way you would brief a person doing it for the first time: the steps, the edge cases, and what to do when something doesn’t fit.",
                        minHeight: 280
                    )
                    Text("Markdown works.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                HStack(spacing: JunoSpace.snug) {
                    Button("Create skill") { Task { await create() } }
                        .buttonStyle(.junoProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(!canSave)
                        .contentShape(.rect)
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.borderless)
                        .tint(nil)
                        .disabled(saving)
                        .contentShape(.rect)
                }
            }
            .disabled(saving || reading)
        }
        .onAppear {
            guard !didSeed else { return }
            didSeed = true
            if name.isEmpty { name = initialName }
            if description.isEmpty { description = initialDescription }
        }
    }

    private func create() async {
        guard canSave, let accountID = model.currentAccountID else { return }
        saving = true
        let result = await model.skillsClient.create(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines),
            imported: imported != nil,
            requestedTools: imported?.requestedTools ?? [],
            for: accountID
        )
        saving = false
        switch result {
        case .ok(let skill):
            _ = await model.refresh()
            // The new skill's page in place of this one.
            dismiss()
            push(.skill(skill.id))
        case .blocked(let reason, _) where reason == "slug_taken":
            toast(.error("You already have a skill called /\(slug ?? ""). Give this one a different name."))
        default:
            toast(.error(result.message(fallback: "Couldn’t save this skill. Nothing was created.")))
        }
    }

    private func pickSkillFile() {
        guard let accountID = model.currentAccountID else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, UTType(filenameExtension: "md") ?? .plainText]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = "Import"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in
                reading = true
                fileError = nil
                defer { reading = false }
                do {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 232_000 else { fileError = "This SKILL.md is too large to import."; return }
                    let content = try String(contentsOf: url, encoding: .utf8)
                    let result = await model.skillsClient.previewFile(content: content, for: accountID)
                    switch result {
                    case .ok(let preview):
                        imported = preview
                        name = preview.name
                        description = preview.description
                        instructions = preview.instructions
                    default: fileError = result.message(fallback: "Couldn’t read this SKILL.md.")
                    }
                } catch { fileError = "Couldn’t read this file as UTF-8 text." }
            }
        }
    }
}
