import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The sheet that opens a pull request from a local session.
///
/// Small on purpose: base branch, title, body, draft, Create. The title and body
/// arrive already written from the session — the run's summary, the file list,
/// the verification verdict — so the common case is reading them once and
/// pressing Create; the fields are editable because a reviewer reads them, and
/// Juno's draft is a draft.
///
/// The branch is pushed by `gh` itself when it has not been. Nothing here runs a
/// force push, and nothing here is reachable by the agent.
public struct CreatePullRequestSheet: View {
    @Bindable private var controller: SessionController
    @State private var draft: PullRequestDraft
    @State private var didLoadBase = false
    @State private var createdURL: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    public init(controller: SessionController) {
        self.controller = controller
        _draft = State(initialValue: controller.pullRequestDraft())
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            header

            if let createdURL {
                created(createdURL)
            } else {
                form
            }
        }
        .padding(JunoSpace.section)
        .frame(width: 560)
        .task {
            guard !didLoadBase else { return }
            didLoadBase = true
            if draft.baseBranch.isEmpty, let base = await controller.githubDefaultBranch() {
                draft.baseBranch = base
            }
        }
        .accessibilityIdentifier("juno.code.pull-request.sheet")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text("Create pull request")
                .junoTitle()
            if let branch = controller.gitStatus?.branch ?? controller.session.gitBranch {
                HStack(spacing: JunoSpace.hairline) {
                    JunoIconView(.branch, size: 12)
                    Text(branch)
                }
                .junoCaption()
                .junoSecondaryInk()
            }
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            field("Base branch") {
                TextField("Repository default", text: $draft.baseBranch)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("juno.code.pull-request.base")
            }
            field("Title") {
                TextField("Title", text: $draft.title)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("juno.code.pull-request.title")
            }
            field("Description") {
                TextEditor(text: $draft.body)
                    .font(.body)
                    .frame(minHeight: 160, maxHeight: 260)
                    .padding(JunoSpace.tight)
                    .background(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .fill(Color.junoCanvas)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                            .strokeBorder(Color.junoBorder)
                    )
                    .accessibilityIdentifier("juno.code.pull-request.body")
            }

            Toggle("Open as a draft", isOn: $draft.isDraft)
                .toggleStyle(.switch)
                .tint(Color.junoAccent)

            if let error = controller.transientError {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            HStack {
                Text("Uses the GitHub CLI signed in on this Mac. The branch is pushed if it isn’t yet.")
                    .junoCaption()
                    .junoSecondaryInk()
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: JunoSpace.regular)
                Button("Cancel") { dismiss() }
                    .contentShape(.rect)
                    .keyboardShortcut(.cancelAction)
                Button(controller.isCreatingPullRequest ? "Creating…" : "Create") {
                    Task {
                        createdURL = await controller.createPullRequest(draft)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .contentShape(.rect)
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canSubmit || controller.isCreatingPullRequest)
                .accessibilityIdentifier("juno.code.pull-request.create")
            }
        }
    }

    private func created(_ url: String) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.check, size: 16)
                    .foregroundStyle(Color.junoSuccess)
                Text("Pull request opened")
                    .junoRowLabel()
            }
            Text(url)
                .junoMono()
                .textSelection(.enabled)
                .lineLimit(2)
                .truncationMode(.middle)
            HStack {
                Spacer(minLength: 0)
                Button("Done") { dismiss() }
                    .contentShape(.rect)
                    .keyboardShortcut(.cancelAction)
                Button("Open on GitHub") {
                    if let link = URL(string: url) { openURL(link) }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
                .contentShape(.rect)
                .keyboardShortcut(.defaultAction)
            }
        }
        .accessibilityIdentifier("juno.code.pull-request.created")
    }

    private func field<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
            Text(title).junoCaption().junoSecondaryInk()
            content()
        }
    }
}
