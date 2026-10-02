import JunoDesignSystem
import SwiftUI

/// The files a run made, as cards: name, kind and size, opening the
/// attachment. The twin of the web's `ToolRunFiles` (tool-run-files.tsx).
/// Shared by macOS and iOS; each app supplies `onOpen` (the Mac opens the
/// file beside the chat, iOS presents it).
public struct NativeToolRunFilesView: View {
    private let files: [NativeToolRunFile]
    private let onOpen: ((NativeToolRunFile) -> Void)?

    public init(files: [NativeToolRunFile], onOpen: ((NativeToolRunFile) -> Void)? = nil) {
        self.files = files
        self.onOpen = onOpen
    }

    public var body: some View {
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(files) { file in
                    card(file)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Files this run made")
        }
    }

    @ViewBuilder
    private func card(_ file: NativeToolRunFile) -> some View {
        let content = HStack(spacing: 10) {
            JunoIconView(file.isImage ? .image : .file, size: 16)
                .foregroundStyle(Color.junoMutedForeground)
            VStack(alignment: .leading, spacing: 1) {
                Text(file.name)
                    .junoFont(size: 13, relativeTo: .body, weight: .medium)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(Self.meta(file))
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .contentShape(.rect)
        .background(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous).fill(Color.junoSurface))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous).strokeBorder(Color.junoHairline))

        if let onOpen, file.path != nil {
            Button { onOpen(file) } label: { content }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(file.name)")
        } else {
            content.accessibilityElement(children: .combine)
        }
    }

    static func meta(_ file: NativeToolRunFile) -> String {
        let kind = file.isImage ? "Image" : (file.name.split(separator: ".").last.map { $0.uppercased() } ?? "File")
        let size = file.bytes.map { NativeToolRunPresentation.bytes($0) }
        let place = file.path == nil ? "In this conversation's files" : nil
        return [kind, size, place].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Everything a run left behind, in the order a reader checks it: where it
/// ran, what it ran, what it printed, how it ended, what it made. The twin of
/// the web's `ToolRunDetail`. No status pills; the row above carries the words.
public struct NativeToolRunDetailView: View {
    private let call: NativeToolCall
    private let onOpenFile: ((NativeToolRunFile) -> Void)?
    private let onRunAgain: ((String) -> Void)?
    @State private var showProgram = false

    public init(call: NativeToolCall, onOpenFile: ((NativeToolRunFile) -> Void)? = nil, onRunAgain: ((String) -> Void)? = nil) {
        self.call = call
        self.onOpenFile = onOpenFile
        self.onRunAgain = onRunAgain
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let context = NativeToolRunPresentation.contextLine(call) {
                Text(context)
                    .junoCaption()
                    .foregroundStyle(Color.junoMutedForeground)
            }
            if let reason = NativeToolRunPresentation.reason(call) {
                Text(reason)
                    .junoCaption()
                    .foregroundStyle(NativeToolPresentation.readsAsFailure(call) ? Color.junoWarningInk : Color.junoMutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let code = call.run?.code {
                block(title: Self.programTitle(call), text: code, lines: showProgram ? nil : 6)
                if code.split(separator: "\n").count > 6 {
                    Button(showProgram ? "Show less" : "Show the whole program") { showProgram.toggle() }
                        .buttonStyle(.plain)
                        .junoCaption()
                        .foregroundStyle(Color.junoMutedForeground)
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                }
            }
            if !call.status.isTerminal, let progress = call.progress, !progress.lines.isEmpty {
                // Not announced: output changes several times a second. The
                // phase is announced once instead.
                block(title: "Output so far", text: progress.lines.joined(separator: "\n"), lines: nil)
                    .accessibilityHidden(true)
            }
            if let stdout = call.run?.stdout { stream("Output", stdout) }
            if let stderr = call.run?.stderr { stream("Errors", stderr) }
            if let exit = NativeToolRunPresentation.exitLine(call) {
                Text(exit)
                    .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoMutedForeground)
            }
            if let files = call.run?.files, !files.isEmpty {
                NativeToolRunFilesView(files: files, onOpen: onOpenFile)
            }
            if let discarded = call.run?.filesDiscarded, discarded > 0 {
                Text(discarded == 1 ? "1 file from this run was not kept." : "\(discarded) files from this run were not kept.")
                    .junoCaption()
                    .foregroundStyle(Color.junoMutedForeground)
            }
            if let onRunAgain, NativeToolRunPresentation.canRunAgain(call) {
                Button("Run again") { onRunAgain(NativeToolRunPresentation.runAgainDraft(call)) }
                    .buttonStyle(.glass)
                    .frame(minHeight: 28)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func programTitle(_ call: NativeToolCall) -> String {
        switch NativeToolRunPresentation.language(call) {
        case .python: "Python"
        case .javascript: "JavaScript"
        case .bash: "Shell script"
        case nil: "Code"
        }
    }

    @ViewBuilder
    private func stream(_ title: String, _ stream: NativeToolRunStream) -> some View {
        block(title: title, text: stream.head, lines: nil)
        if let omitted = NativeToolRunPresentation.omittedNote(stream) {
            Text(omitted)
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoMutedForeground)
        }
        if let tail = stream.tail {
            block(title: "\(title), end", text: tail, lines: nil)
        }
    }

    private func block(title: String, text: String, lines: Int?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoMutedForeground)
            Text(text)
                .junoFont(size: 12, relativeTo: .footnote, design: .monospaced)
                .foregroundStyle(Color.primary.opacity(0.85))
                .lineLimit(lines)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous).fill(Color.junoSurface))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous).strokeBorder(Color.junoHairline))
    }
}
