import JunoCodeCore
import JunoCodeRemote
import JunoDesignSystem
import SwiftUI

/// A new session on a paired Mac: pick any folder it shares (repositories
/// marked), optionally its own worktree, then the first prompt with the
/// full composer (model, effort, mode, team, skills).
struct JunoMobileLinkNewSessionSheet: View {
  @Bindable var model: CodeLinkRemoteModel
  let opened: (String) -> Void

  @State private var chosen: String?
  @State private var worktree = false
  @State private var prompt = ""
  @FocusState private var focused: Bool
  @Environment(\.dismiss) private var dismiss

  private var browser: CodeLinkFolderBrowser? { model.browser }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let chosen {
          promptStep(chosen)
        } else {
          folderStep
        }
      }
      .junoScreenCanvas()
      .navigationTitle(chosen == nil ? (browser?.title ?? "Folders") : CodeLinkFolderBrowser.name(of: chosen ?? ""))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        if chosen == nil, browser?.isAtRoot == false {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Up") { Task { await model.browseUp() } }
          }
        }
      }
    }
    .onAppear { if model.browser == nil { model.beginNewSession() } }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .accessibilityIdentifier("juno.mobile.link-new")
  }

  // MARK: Folder

  private var folderStep: some View {
    List {
      Section {
        if let browser, browser.rows.isEmpty {
          Text(browser.isAtRoot
            ? "\(model.selectedMac?.name ?? "This Mac") shares no folders with Remote yet. Add one in Alevr on the Mac."
            : "No folders inside this one.")
            .font(.subheadline)
            .foregroundStyle(Color.junoSecondaryInk)
        }
        ForEach(browser?.rows ?? []) { entry in
          HStack(spacing: JunoSpace.cozy) {
            Button {
              Task { await model.browse(entry.path) }
            } label: {
              HStack(spacing: JunoSpace.cozy) {
                JunoIconView(entry.isRepo == true ? .branch : .folderOpen, size: 17)
                  .foregroundStyle(entry.isRepo == true ? Color.primary : Color.junoSecondaryInk)
                  .frame(width: 24)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                  Text(entry.name).font(.body).foregroundStyle(.primary)
                  if entry.isRepo == true {
                    Text("Repository").font(.footnote).foregroundStyle(Color.junoSecondaryInk)
                  } else if browser?.isAtRoot == true {
                    Text(entry.path).font(.footnote).foregroundStyle(Color.junoTertiaryInk).lineLimit(1).truncationMode(.head)
                  }
                }
                Spacer(minLength: 0)
              }
              .frame(minHeight: 44)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button("Choose") { chosen = entry.path }
              .font(.subheadline)
              .frame(minWidth: 44, minHeight: 44)
              .buttonStyle(.plain)
              .foregroundStyle(Color.primary)
              .accessibilityLabel("Start in \(entry.name)")
          }
        }
      } header: {
        Text(browser?.isAtRoot == false ? (browser?.path ?? "") : "Shared with Remote")
          .font(.footnote)
          .textCase(nil)
          .lineLimit(1)
          .truncationMode(.head)
      } footer: {
        if let path = browser?.path {
          Button {
            chosen = path
          } label: {
            Text("Start here, in \(CodeLinkFolderBrowser.name(of: path))")
              .font(.body.weight(.medium))
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.glass)
          .padding(.top, JunoSpace.cozy)
          .accessibilityIdentifier("juno.mobile.link-new-here")
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .overlay { if model.isBrowsing { ProgressView() } }
  }

  // MARK: Prompt

  private func promptStep(_ cwd: String) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      VStack(alignment: .leading, spacing: JunoSpace.hairline) {
        Text(cwd).font(.footnote.monospaced()).foregroundStyle(Color.junoSecondaryInk).lineLimit(1).truncationMode(.head)
        Button("Change folder") { chosen = nil }
          .font(.subheadline)
          .frame(minHeight: 44)
      }
      Toggle(isOn: $worktree) {
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text("Its own worktree").font(.body)
          Text("A fresh branch beside your checkout, so your working copy stays as it is.")
            .font(.footnote)
            .foregroundStyle(Color.junoSecondaryInk)
        }
      }
      .frame(minHeight: 44)
      Spacer(minLength: 0)
      if let error = model.lastError { JunoInlineError(message: error) }
      JunoMobileCodeComposer(
        text: $prompt,
        placeholder: "What should it do?",
        focused: $focused,
        voice: nil,
        canSend: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSending && model.composer.selection != nil,
        send: { start(cwd) }
      ) {
        JunoMobileLinkComposerControls(model: model)
      }
    }
    .padding(JunoSpace.regular)
    .onAppear { focused = true }
  }

  private func start(_ cwd: String) {
    let text = prompt
    Task {
      if let id = await model.createSession(cwd: cwd, worktree: worktree, prompt: text) {
        dismiss()
        opened(id)
      }
    }
  }
}
