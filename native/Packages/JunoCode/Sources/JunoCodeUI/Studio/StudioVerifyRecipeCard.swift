import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The recipe card: asks once whether the checks Juno found should become
/// this project's, listing each exact command (CODE_AGENT_SPEC §1.8, D-019).
///
/// Two separate answers. "Use these checks" saves `.juno/verify.json` (a
/// normal file change, in Changes) and remembers its bytes as accepted; it
/// grants nothing. The checkbox below it, off until ticked, also writes the
/// exact `Bash(...)` rules it lists to the personal settings file, so those
/// commands stop asking in this repository.
///
/// Sits above the composer with the other cards that wait on the reader.
struct StudioVerifyRecipeSlot: View {
    let controller: SessionController

    var body: some View {
        StudioVerifyRecipeCard(
            model: controller.verification,
            accept: {
                Task { await controller.verification.accept(workspaceRoot: controller.context?.access.rootURL) }
            }
        )
        .task(id: controller.events.count) {
            await controller.verification.update(
                workspaceRoot: controller.context?.access.rootURL,
                events: controller.events
            )
        }
    }
}

struct StudioVerifyRecipeCard: View {
    @Bindable var model: VerificationModel
    let accept: () -> Void

    /// More rows than this and the list scrolls inside the card. Every check
    /// is still listed, in full: accepting takes all of them, and the file
    /// can be anyone's, so no command may hide behind a count or an ellipsis.
    static let visibleChecks = 8
    /// How tall the list grows before it scrolls.
    static let maximumListHeight: CGFloat = 280

    var body: some View {
        if let proposal = model.proposal {
            card(proposal)
                .transition(.junoInline)
        } else if let problem = model.problem {
            Text(problem)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func card(_ proposal: VerificationModel.Proposal) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.title(for: proposal))
                    .font(Studio.Font.labelEmphasis)
                    .foregroundStyle(Studio.Ink.primary)
                Text(Self.subtitle(for: proposal))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            checkList(proposal.recipe.checks)

            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Toggle(isOn: $model.runWithoutAsking) {
                    Text("Run these without asking in this repository")
                        .font(Studio.Font.label)
                        .foregroundStyle(Studio.Ink.primary)
                }
                .toggleStyle(.checkbox)
                .accessibilityIdentifier("juno.code.verify.runWithoutAsking")
                Text(Self.rulesCaption(proposal.rules, on: model.runWithoutAsking))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 20)
            }

            if let problem = model.problem {
                Text(problem)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.danger)
            }

            HStack(spacing: JunoSpace.snug) {
                Button("Not now") { model.dismiss() }
                    .buttonStyle(StudioQuietButtonStyle())
                    .accessibilityIdentifier("juno.code.verify.dismiss")
                Spacer(minLength: JunoSpace.snug)
                Button(proposal.kind == .discovered ? "Use these checks" : "Use the new checks") { accept() }
                    .buttonStyle(StudioPrimaryButtonStyle())
                    .disabled(model.isSaving)
                    .accessibilityIdentifier("juno.code.verify.accept")
            }
        }
        .padding(JunoSpace.regular)
        .junoLiftedSurface(cornerRadius: Studio.Radius.composer)
    }

    @ViewBuilder
    private func checkList(_ checks: [VerifyCheck]) -> some View {
        if checks.count > Self.visibleChecks {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                ScrollView(.vertical) {
                    checkRows(checks)
                }
                .frame(maxHeight: Self.maximumListHeight)
                .modifier(CheckListFrame())
                // Overlay scrollers show nothing until used: say there is more.
                Text("\(checks.count) checks. Scroll the list to read every one before you accept.")
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
            }
        } else {
            checkRows(checks)
                .modifier(CheckListFrame())
        }
    }

    /// Each check with its whole command, wrapped rather than cut: a long
    /// line shortened in the middle could hide what follows `&&`.
    private func checkRows(_ checks: [VerifyCheck]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(checks.enumerated()), id: \.offset) { index, check in
                HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                    Text(Self.kindWord(check.kind))
                        .font(Studio.Font.meta)
                        .foregroundStyle(Studio.Ink.secondary)
                        .frame(width: 72, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(check.commandLine)
                            .font(Studio.Font.mono)
                            .foregroundStyle(Studio.Ink.primary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        if let targeted = check.targeted {
                            Text("For changed files: \(targeted)")
                                .font(Studio.Font.mono)
                                .foregroundStyle(Studio.Ink.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let place = Self.place(of: check) {
                            Text(place)
                                .font(Studio.Font.meta)
                                .foregroundStyle(Studio.Ink.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, JunoSpace.tight)
                .padding(.horizontal, JunoSpace.cozy)
                .overlay(alignment: .top) {
                    if index > 0 {
                        Rectangle().fill(Studio.Surface.hairline).frame(height: 1)
                    }
                }
            }
        }
    }
}

/// The quiet frame around the card's list of checks.
private struct CheckListFrame: ViewModifier {
    func body(content: Content) -> some View {
        content
        .background(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .fill(Studio.Surface.muted)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Studio.Radius.card, style: .continuous)
                .strokeBorder(Studio.Surface.hairline)
        )
    }
}

extension StudioVerifyRecipeCard {
    // MARK: - Words

    static func title(for proposal: VerificationModel.Proposal) -> String {
        switch proposal.kind {
        case .discovered: "Use these as this project's checks?"
        case .changed: "The checks in .juno/verify.json changed"
        }
    }

    static func subtitle(for proposal: VerificationModel.Proposal) -> String {
        switch proposal.kind {
        case .discovered:
            "Juno found them in this project and runs them to check its work. They are saved to .juno/verify.json, which you can review and commit."
        case .changed:
            "Juno does not run the new commands until you accept them."
        }
    }

    static func kindWord(_ kind: CheckKind) -> String {
        switch kind {
        case .build: "Build"
        case .test: "Test"
        case .lint: "Lint"
        case .typecheck: "Typecheck"
        case .custom: "Check"
        }
    }

    /// "In apps/web", and a plain warning for a command Juno does not
    /// recognise as a check (which no rule will cover). The targeted command
    /// has its own line.
    static func place(of check: VerifyCheck) -> String? {
        var parts: [String] = []
        if let cwd = check.normalizedCwd { parts.append("In \(cwd)") }
        if CommandClassifier().checkKind(of: check.commandLine) == nil {
            parts.append("Not a build or test command Juno recognises, so the box below adds no rule for it; read it before you accept")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What ticking the box does, in exact rules.
    static func rulesCaption(_ rules: [PermissionRule], on: Bool) -> String {
        guard !rules.isEmpty else {
            return "These commands cannot be allowed by a rule, so each one asks before it runs."
        }
        let listed = rules.map(\.description).joined(separator: ", ")
        return on
            ? "Adds \(listed) to .juno/settings.local.json, which stays on this Mac. You can remove them in /permissions."
            : "Otherwise each command asks before it runs, unless your rules already allow it. Ticking this adds \(listed) to .juno/settings.local.json."
    }
}
