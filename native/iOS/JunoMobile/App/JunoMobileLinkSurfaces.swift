import JunoCodeCore
import JunoCodeRemote
import JunoDesignSystem
import SwiftUI
import UIKit

// The surfaces beside the thread: Changes (diff review with per-hunk revert),
// Terminal (the Mac's shell, when it shares it), Screens (its preview and the
// Simulator) and Ship (commit, push, open a pull request).

// MARK: - Changes

struct JunoMobileLinkChangesView: View {
  @Bindable var model: CodeLinkRemoteModel

  enum Scope: Hashable { case thread, turn }
  @State private var scope: Scope = .thread
  @State private var confirming: (hunk: DiffHunk, file: CodeV2DiffFile)?

  private var files: [CodeV2DiffFile] { scope == .thread ? model.threadDiff : model.turnDiff }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
        header
        if files.isEmpty {
          JunoMobileLinkSurfaceEmpty(
            icon: .fileDiff,
            title: model.isLoadingDiff ? "Reading the changes on your Mac" : "No changes yet",
            text: "Edits this session makes on the Mac appear here, hunk by hunk. Revert any hunk you do not want."
          )
        }
        ForEach(files) { file in
          JunoMobileLinkDiffFile(
            file: file,
            reverting: model.revertingHunk,
            revert: { hunk in confirming = (hunk, file) }
          )
        }
        if let error = model.lastError {
          JunoInlineError(message: error)
        }
      }
      .padding(JunoSpace.regular)
      .frame(maxWidth: JunoMobileMeasure.reading)
      .frame(maxWidth: .infinity)
    }
    .refreshable { await model.loadDiff(checkpointID: scope == .turn ? model.diffCheckpointID : nil) }
    .task(id: model.openSessionID) {
      if model.threadDiff.isEmpty { await model.loadDiff() }
    }
    .confirmationDialog(
      "Revert this hunk on the Mac?",
      isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible
    ) {
      Button("Revert hunk", role: .destructive) {
        guard let pick = confirming else { return }
        confirming = nil
        Task { await model.revert(pick.hunk, in: pick.file) }
      }
      Button("Keep it", role: .cancel) { confirming = nil }
    } message: {
      Text("The file on your Mac goes back to how it was before this hunk. Other hunks stay.")
    }
    .accessibilityIdentifier("juno.mobile.link-changes")
  }

  private var header: some View {
    HStack(spacing: JunoSpace.snug) {
      if model.diffCheckpointID != nil {
        Picker("Scope", selection: $scope) {
          Text("Whole session").tag(Scope.thread)
          Text("This turn").tag(Scope.turn)
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 260)
      } else {
        Text(files.count == 1 ? "1 file" : "\(files.count) files")
          .font(.subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
      }
      Spacer(minLength: 0)
      let added = files.reduce(0) { $0 + $1.additions }
      let removed = files.reduce(0) { $0 + $1.deletions }
      if !files.isEmpty {
        Text("+\(added)").foregroundStyle(Color.junoSuccess)
        Text("\u{2212}\(removed)").foregroundStyle(Color.junoDanger)
      }
    }
    .font(.subheadline)
    .monospacedDigit()
    .onChange(of: model.diffCheckpointID) { _, id in scope = id == nil ? .thread : .turn }
  }
}

/// One file: its name, then each hunk with a Revert button on its header.
struct JunoMobileLinkDiffFile: View {
  let file: CodeV2DiffFile
  var reverting: String?
  let revert: (DiffHunk) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(file.change == .add ? .filePlus : file.change == .delete ? .trash : .fileCode, size: 14)
          .foregroundStyle(Color.junoTertiaryInk)
        VStack(alignment: .leading, spacing: 0) {
          Text(file.fileName).font(.subheadline.weight(.medium)).lineLimit(1)
          if !file.directory.isEmpty {
            Text(file.directory).font(.caption.monospaced()).foregroundStyle(Color.junoTertiaryInk).lineLimit(1).truncationMode(.head)
          }
        }
        Spacer(minLength: JunoSpace.hairline)
        Text(changeWord).font(.footnote).foregroundStyle(Color.junoSecondaryInk)
      }
      .padding(.horizontal, JunoSpace.cozy)
      .frame(minHeight: 52)
      if file.isBinary {
        Text("Binary file").font(.footnote).foregroundStyle(Color.junoSecondaryInk).padding(JunoSpace.cozy)
      }
      ForEach(Array(file.hunks.enumerated()), id: \.element.reviewIdentifier) { index, hunk in
        JunoMobileLinkHunk(
          hunk: hunk,
          ordinal: index + 1,
          isReverting: reverting == hunk.reviewIdentifier,
          revert: { revert(hunk) }
        )
      }
    }
    .background(Color.junoTerminal, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
    .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
    .accessibilityElement(children: .contain)
  }

  private var changeWord: String {
    switch file.change {
    case .add: "New"
    case .delete: "Deleted"
    case .rename: "Renamed"
    case .modify: "+\(file.additions) \u{2212}\(file.deletions)"
    }
  }
}

struct JunoMobileLinkHunk: View {
  let hunk: DiffHunk
  let ordinal: Int
  var isReverting = false
  let revert: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: JunoSpace.snug) {
        Text("Lines \(hunk.newStart) to \(hunk.newStart + max(0, hunk.newCount - 1))")
          .font(.caption)
          .foregroundStyle(Color.junoSecondaryInk)
        Spacer(minLength: 0)
        if isReverting {
          ProgressView().controlSize(.small).frame(width: 44, height: 44)
        } else {
          Button(action: revert) {
            HStack(spacing: JunoSpace.hairline) {
              JunoIconView(.undo, size: 12)
              Text("Revert")
            }
            .font(.footnote)
            .foregroundStyle(Color.primary)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Revert hunk \(ordinal)")
          .accessibilityIdentifier("juno.mobile.link-revert-\(ordinal)")
        }
      }
      .padding(.leading, JunoSpace.cozy)
      .background { Rectangle().fill(Color.junoMuted.opacity(0.6)) }
      // Long lines wrap: on a phone a hunk reads top to bottom, and every
      // row's tint spans the card.
      VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
            HStack(alignment: .firstTextBaseline, spacing: 0) {
              Text((line.newLineNumber ?? line.oldLineNumber).map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
                .foregroundStyle(Color.junoTertiaryInk)
                .padding(.trailing, JunoSpace.snug)
              Text(marker(line.kind))
                .frame(width: 12)
                .foregroundStyle(tint(line.kind))
              Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, JunoSpace.cozy)
            }
            .font(.caption.monospaced())
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { Rectangle().fill(background(line.kind)) }
          }
      }
      .padding(.vertical, JunoSpace.hairline)
    }
  }

  private func marker(_ kind: DiffLineKind) -> String {
    switch kind {
    case .added: "+"
    case .removed: "\u{2212}"
    case .context: " "
    }
  }

  private func tint(_ kind: DiffLineKind) -> Color {
    switch kind {
    case .added: Color.junoSuccess
    case .removed: Color.junoDanger
    case .context: Color.junoTertiaryInk
    }
  }

  private func background(_ kind: DiffLineKind) -> Color {
    switch kind {
    case .added: Color.junoSuccess.opacity(0.12)
    case .removed: Color.junoDanger.opacity(0.12)
    case .context: .clear
    }
  }
}

struct JunoMobileLinkSurfaceEmpty: View {
  let icon: JunoIcon
  let title: String
  let text: String

  var body: some View {
    VStack(spacing: JunoSpace.snug) {
      JunoIconView(icon, size: 26).foregroundStyle(Color.junoTertiaryInk)
      Text(title).font(.body.weight(.medium)).multilineTextAlignment(.center)
      Text(text)
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, JunoSpace.section * 2)
  }
}

// MARK: - Terminal

struct JunoMobileLinkTerminalView: View {
  @Bindable var model: CodeLinkRemoteModel
  @State private var input = ""
  @FocusState private var focused: Bool

  private var shared: Bool { model.selectedMac?.sharesTerminal == true }
  private var lines: [String] {
    let text = model.terminalText
    return text.isEmpty ? [] : text.components(separatedBy: "\n")
  }

  var body: some View {
    VStack(spacing: 0) {
      if !shared {
        JunoMobileLinkSurfaceEmpty(
          icon: .terminal,
          title: "Terminal stays on the Mac",
          text: "To type into a shell here, turn on Share this Mac's terminal in Alevr on \(model.selectedMac?.name ?? "the Mac"). Commands the agent runs still show in the thread."
        )
        Spacer(minLength: 0)
      } else if model.terminalID == nil {
        JunoMobileLinkSurfaceEmpty(
          icon: .terminal,
          title: "Open a shell in this folder",
          text: "It runs on \(model.selectedMac?.name ?? "your Mac"), in \(model.openSnapshot.map { CodeLinkFolderBrowser.name(of: $0.cwd) } ?? "the session's folder")."
        )
        Button {
          Task { await model.openTerminal() }
        } label: {
          Text("Open terminal").font(.body.weight(.medium)).padding(.horizontal, JunoSpace.cozy)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
        .frame(minHeight: 44)
        Spacer(minLength: 0)
      } else {
        JunoMobileTerminalView(lines: lines)
        inputRow
      }
    }
    .accessibilityIdentifier("juno.mobile.link-terminal")
  }

  private var inputRow: some View {
    HStack(spacing: JunoSpace.snug) {
      Text("$").font(.body.monospaced()).foregroundStyle(Color.junoTertiaryInk)
      TextField("Type a command", text: $input)
        .font(.body.monospaced())
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($focused)
        .submitLabel(.send)
        .onSubmit(run)
        .accessibilityIdentifier("juno.mobile.link-terminal-input")
      Button {
        Task { await model.writeTerminal("\u{3}") }
      } label: {
        Text("Ctrl C").font(.footnote).foregroundStyle(Color.junoSecondaryInk).frame(minWidth: 44, minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Interrupt")
    }
    .padding(.horizontal, JunoSpace.regular)
    .frame(minHeight: 52)
    .junoGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .padding(.horizontal, JunoSpace.regular)
    .padding(.vertical, JunoSpace.snug)
  }

  private func run() {
    let line = input
    input = ""
    focused = true
    Task { await model.writeTerminal(line + "\r") }
  }
}

// MARK: - Screens

struct JunoMobileLinkScreensView: View {
  @Bindable var model: CodeLinkRemoteModel

  private var targets: [CodeV2.RemoteCaptureTarget] { model.selectedMac?.captures ?? [] }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: JunoSpace.section) {
        if targets.isEmpty {
          JunoMobileLinkSurfaceEmpty(
            icon: .monitor,
            title: "Nothing to show yet",
            text: "When the Mac has a preview running or a Simulator booted, you can look at it from here."
          )
        }
        ForEach(targets, id: \.self) { target in
          VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
              Text(target == .preview ? "Preview" : "Simulator").font(.body.weight(.medium))
              Spacer(minLength: 0)
              if model.capturing == target {
                ProgressView().frame(width: 44, height: 44)
              } else {
                Button {
                  Task { await model.capture(target) }
                } label: {
                  JunoIconView(.refresh, size: 16)
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh \(target == .preview ? "preview" : "Simulator")")
              }
            }
            if let capture = model.captures[target], let data = capture.imageData, let image = UIImage(data: data) {
              Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
                .frame(maxWidth: .infinity)
              if let at = CodeV2Formatting.clockTime(iso: capture.at) {
                Text("Taken at \(at)").font(.footnote).foregroundStyle(Color.junoTertiaryInk)
              }
            } else {
              RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                .fill(Color.junoMuted.opacity(0.5))
                .frame(height: 220)
                .overlay {
                  Text("Tap refresh to look").font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
                }
            }
          }
        }
        if let error = model.lastError { JunoInlineError(message: error) }
      }
      .padding(JunoSpace.regular)
      .frame(maxWidth: JunoMobileMeasure.reading)
      .frame(maxWidth: .infinity)
    }
    .task(id: model.openSessionID) {
      for target in targets where model.captures[target] == nil { await model.capture(target) }
    }
    .accessibilityIdentifier("juno.mobile.link-screens")
  }
}

// MARK: - Ship

struct JunoMobileLinkShipView: View {
  @Bindable var model: CodeLinkRemoteModel
  @State private var message = ""
  @State private var prTitle = ""
  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: JunoSpace.section) {
        if let git = model.git {
          if !git.isRepo {
            JunoMobileLinkSurfaceEmpty(icon: .branch, title: "Not a git repository", text: "This folder on the Mac is not under git, so there is nothing to commit.")
          } else {
            status(git)
            commitBox(git)
            publish(git)
          }
        } else {
          JunoShimmerText("Reading the branch on your Mac", font: .subheadline)
        }
        if let error = model.lastError { JunoInlineError(message: error) }
      }
      .padding(JunoSpace.regular)
      .frame(maxWidth: JunoMobileMeasure.reading)
      .frame(maxWidth: .infinity)
    }
    .refreshable { await model.refreshGit() }
    .task(id: model.openSessionID) {
      await model.refreshGit()
      if prTitle.isEmpty { prTitle = model.openSnapshot?.title ?? "" }
    }
    .accessibilityIdentifier("juno.mobile.link-ship")
  }

  private func status(_ git: CodeV2.GitStatusResult) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(.branch, size: 15).foregroundStyle(Color.junoSecondaryInk)
        Text(git.branch ?? "Detached").font(.body.weight(.medium))
        Spacer(minLength: 0)
        Text(syncLine(git)).font(.footnote).foregroundStyle(Color.junoSecondaryInk)
      }
      if git.files.isEmpty {
        Text("Nothing to commit.").font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
      } else {
        ForEach(git.files.prefix(12), id: \.path) { file in
          HStack(spacing: JunoSpace.snug) {
            Text(file.status.trimmingCharacters(in: .whitespaces))
              .font(.caption.monospaced())
              .foregroundStyle(Color.junoTertiaryInk)
              .frame(width: 24, alignment: .leading)
            Text(file.path).font(.footnote.monospaced()).lineLimit(1).truncationMode(.head)
          }
        }
        if git.files.count > 12 {
          Text("and \(git.files.count - 12) more").font(.footnote).foregroundStyle(Color.junoTertiaryInk)
        }
      }
    }
  }

  private func syncLine(_ git: CodeV2.GitStatusResult) -> String {
    guard git.upstream != nil else { return "Not pushed yet" }
    if git.ahead == 0, git.behind == 0 { return "Up to date" }
    var parts: [String] = []
    if git.ahead > 0 { parts.append("\(git.ahead) to push") }
    if git.behind > 0 { parts.append("\(git.behind) behind") }
    return parts.joined(separator: ", ")
  }

  private func commitBox(_ git: CodeV2.GitStatusResult) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      TextField("Commit message", text: $message, axis: .vertical)
        .font(.body)
        .lineLimit(2...5)
        .padding(JunoSpace.cozy)
        .background(Color.junoMuted.opacity(0.5), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier("juno.mobile.link-commit-message")
      HStack(spacing: JunoSpace.close) {
        actionButton("Commit", busy: model.gitBusy == "commit", disabled: git.files.isEmpty || message.trimmingCharacters(in: .whitespaces).isEmpty) {
          let text = message
          Task {
            await model.commit(text)
            if model.lastError == nil { message = "" }
          }
        }
        actionButton("Push", busy: model.gitBusy == "push", disabled: git.upstream != nil && git.ahead == 0) {
          Task { await model.push() }
        }
      }
      if let commit = model.lastCommit {
        Text("Committed \(String(commit.sha.prefix(7))): \(commit.summary)")
          .font(.footnote).foregroundStyle(Color.junoSecondaryInk).lineLimit(2)
      }
      if let push = model.lastPush {
        Text("Pushed \(push.branch) to \(push.remote)").font(.footnote).foregroundStyle(Color.junoSecondaryInk)
      }
    }
  }

  @ViewBuilder
  private func publish(_ git: CodeV2.GitStatusResult) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      Text("Pull request").font(.body.weight(.medium))
      if !git.canOpenPr {
        Text("Sign the GitHub CLI in on the Mac (gh auth login) to open pull requests from here.")
          .font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
      } else if let url = model.pullRequestURL, let link = URL(string: url) {
        Button {
          openURL(link)
        } label: {
          HStack {
            Text(url).font(.footnote.monospaced()).lineLimit(1).truncationMode(.middle)
            JunoIconView(.externalLink, size: 13)
          }
          .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
      } else {
        TextField("Title", text: $prTitle)
          .font(.body)
          .padding(JunoSpace.cozy)
          .background(Color.junoMuted.opacity(0.5), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        actionButton("Open pull request", busy: model.gitBusy == "pr", disabled: prTitle.trimmingCharacters(in: .whitespaces).isEmpty || git.upstream == nil) {
          let title = prTitle
          Task { await model.openPullRequest(title: title) }
        }
      }
    }
  }

  private func actionButton(_ title: String, busy: Bool, disabled: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Group {
        if busy { ProgressView() } else { Text(title).font(.body.weight(.medium)) }
      }
      .frame(maxWidth: .infinity, minHeight: 44)
    }
    .buttonStyle(.glass)
    .disabled(disabled || model.gitBusy != nil)
  }
}
