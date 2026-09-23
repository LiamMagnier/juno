import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The run's detail surface in the trailing dock — the rework's **Activity**
/// panel (Tool calls & research DECISIONS U3, SPEC §8.3), which replaces the
/// brief's Thought panel. Nothing in it is needed to read the thinking; it is
/// where a reader goes for the arguments, the results and the receipts.
///
/// A header in the canvas's own shape — the live phase with its clock, or
/// "Thought for 12s" — and three views, each shown only when it has something:
///
/// - **Timeline:** the reasoning as prose, interleaved with the tool calls in
///   the order they happened. A call opens to its arguments and result, and a
///   failure reads as one.
/// - **Sources:** *Cited*, then *Also read*.
/// - **Details:** the model, the effort, the context and the memory used.
///
/// What the rework takes out, and so this never had: cost as a headline, the
/// five-way filter, Summary/Full, the Research/Think/Write ledger.
///
/// Keyed by the message's id, it survives the answer completing; it closes when
/// the reader closes it, when the conversation changes, or when the message
/// leaves the transcript.
struct DesktopActivityPanel: View {
    let message: NativeChatMessage
    let live: Bool
    var recovering = false
    /// The call the panel was opened on: expanded, and scrolled to.
    var focusCallID: String? = nil
    let close: () -> Void

    enum Tab: Hashable { case timeline, sources, details }

    @State private var tab: Tab = .timeline
    @State private var expandedCalls = Set<String>()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var view: NativeRunView {
        NativeRunView.build(
            activity: message.activity,
            reasoning: message.reasoning,
            reasoningParts: message.reasoningParts,
            sources: message.sources
        )
    }

    private func tabs(for view: NativeRunView) -> [Tab] {
        var tabs: [Tab] = []
        if !view.items.isEmpty { tabs.append(.timeline) }
        if !message.sources.isEmpty { tabs.append(.sources) }
        let facts = view.facts
        if facts.model != nil || facts.effort != nil || facts.context != nil || facts.connectors != nil
            || !facts.memory.isEmpty
        {
            tabs.append(.details)
        }
        return tabs
    }

    var body: some View {
        let view = view
        let tabs = tabs(for: view)
        let shown = tabs.contains(tab) ? tab : (tabs.first ?? .timeline)
        VStack(spacing: 0) {
            header(view: view)
            Divider()
            if tabs.count > 1 {
                DesktopSegmented(
                    options: tabs.map { tab -> DesktopSegmented<Tab>.Option in
                        switch tab {
                        case .timeline: DesktopSegmented<Tab>.Option(.timeline, "Timeline")
                        case .sources: DesktopSegmented<Tab>.Option(.sources, "Sources \(message.sources.count)")
                        case .details: DesktopSegmented<Tab>.Option(.details, "Details")
                        }
                    },
                    selection: Binding(get: { shown }, set: { tab = $0 }),
                    accessibilityLabel: "Activity view"
                )
                .padding(.horizontal, JunoSpace.regular)
                .padding(.vertical, JunoSpace.snug)
                .frame(maxWidth: .infinity, alignment: .leading)
                Divider()
            }
            Color.clear.overlay {
                ScrollViewReader { proxy in
                    ScrollView {
                        Group {
                            if tabs.isEmpty {
                                Text(live ? "Nothing to show yet." : "This reply has no steps to show.")
                                    .junoFont(size: 13, relativeTo: .callout)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } else {
                                switch shown {
                                case .timeline: timeline(view: view)
                                case .sources: sources
                                case .details: details(view: view)
                                }
                            }
                        }
                        .padding(JunoSpace.regular)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .onAppear { focus(proxy: proxy) }
                    .onChange(of: focusCallID) { _, _ in focus(proxy: proxy) }
                }
            }
            .clipped()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Activity")
        .accessibilityIdentifier("juno.desktop.chat.activity-panel")
    }

    private func focus(proxy: ScrollViewProxy) {
        guard let focusCallID else { return }
        tab = .timeline
        expandedCalls.insert(focusCallID)
        Task { @MainActor in
            await Task.yield()
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                proxy.scrollTo(focusCallID, anchor: .center)
            }
        }
    }

    // MARK: Header

    private func header(view: NativeRunView) -> some View {
        HStack(spacing: JunoSpace.snug) {
            DesktopActivityHeaderTitle(message: message, view: view, live: live, recovering: recovering)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: close) {
                JunoIconView(.close, size: 14)
            }
            .buttonStyle(JunoProseIconButtonStyle())
            .contentShape(.rect)
            .help("Close the activity panel")
            .accessibilityLabel("Close panel")
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.snug)
        .frame(minHeight: 44)
        .background(Color.junoSurface.opacity(0.5))
    }

    // MARK: Timeline

    private func timeline(view: NativeRunView) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            ForEach(view.items) { item in
                switch item {
                case .reasoning(_, let text):
                    JunoMarkdownText(text)
                        .environment(\.junoProseStyle, .reading)
                        .foregroundStyle(Color.junoForeground)
                case .commentary(_, let text):
                    HStack(alignment: .top, spacing: JunoSpace.cozy) {
                        Rectangle()
                            .fill(Color.junoBorder)
                            .frame(width: 3)
                        Text(text)
                            .junoType(.reading)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                case .tool(_, let call, let detail):
                    DesktopToolCallDetail(
                        call: call,
                        detail: detail,
                        expanded: Binding(
                            get: { expandedCalls.contains(call.callID) },
                            set: { if $0 { expandedCalls.insert(call.callID) } else { expandedCalls.remove(call.callID) } }
                        )
                    )
                    .id(call.callID)
                case .notice:
                    DesktopRunStepRow(item: item, compact: false)
                }
            }
        }
    }

    // MARK: Sources

    /// Cited — the sources a `[n]` in the answer points at, in the order first
    /// cited — then everything else the answer read.
    private var sources: some View {
        let split = DesktopSourceSplit(message: message)
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if !split.cited.isEmpty {
                section("Cited") {
                    ForEach(split.cited, id: \.number) { entry in
                        SourceRow(source: entry.source, number: entry.number)
                    }
                }
            }
            if !split.read.isEmpty {
                section(split.cited.isEmpty ? "Sources" : "Also read") {
                    ForEach(split.read, id: \.number) { entry in
                        SourceRow(source: entry.source, number: entry.number)
                    }
                }
            }
        }
    }

    // MARK: Details

    private func details(view: NativeRunView) -> some View {
        let facts = view.facts
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let model = facts.model { fact("Model", model) }
            if let effort = facts.effort { fact("Effort", effort) }
            if let context = facts.context { fact("Context", context) }
            if let connectors = facts.connectors { fact("Connected tools", connectors) }
            if !facts.memory.isEmpty {
                section("Memory used") {
                    ForEach(facts.memory) { memory in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            JunoIconView(.memory, size: 13)
                                .foregroundStyle(Color.junoSecondaryInk)
                            Text(memory.content)
                                .junoFont(size: 13, relativeTo: .callout)
                                .foregroundStyle(Color.junoForeground)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private func fact(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(value)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoFont(size: 12, relativeTo: .footnote, weight: .semibold)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

/// The panel's title: the live phase and its clock while the run works, the
/// summary once it has settled.
private struct DesktopActivityHeaderTitle: View {
    let message: NativeChatMessage
    let view: NativeRunView
    let live: Bool
    let recovering: Bool

    var body: some View {
        let answerStarted = !message.content.isEmpty
        let phase = NativeRunPhase.derive(
            view: view,
            live: live,
            failed: message.errorDescription != nil,
            finishReason: message.finishReason,
            answerStarted: answerStarted,
            awaitingApproval: false
        )
        let settled = !phase.isWorking && phase != .waiting && !recovering
        DesktopRunLine(
            view: view,
            message: message,
            phase: phase,
            live: live,
            recovering: recovering,
            settled: settled,
            showsLabel: true,
            expanded: false,
            hovered: true,
            inHeader: true
        )
        .accessibilityAddTraits(.isHeader)
    }
}

/// One call in the panel: its line, opening to what was sent and what came
/// back, exactly as the server kept them — or the sentence that says why they
/// are not here.
struct DesktopToolCallDetail: View {
    let call: NativeToolCall
    let detail: NativeToolDetail?
    @Binding var expanded: Bool
    @State private var showsAllArguments = false
    @State private var showsAllResult = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Button {
                withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: JunoSpace.tight) {
                    JunoIconView(.chevronRight, size: 10, weight: .bold)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    DesktopToolCallLine(call: call)
                }
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    if call.status == .failed || call.status == .denied || call.status == .expired
                        || call.status == .cancelled
                    {
                        Text(NativeToolPresentation.failed(call))
                            .junoFont(size: 13, relativeTo: .callout)
                            .foregroundStyle(call.status == .failed ? Color.junoDestructiveInk : Color.junoSecondaryInk)
                    }
                    if let query = call.web?.query {
                        block("Query", query, lines: 3, showsAll: .constant(true))
                    }
                    if let arguments = detail?.args {
                        block("Arguments", arguments, lines: 12, showsAll: $showsAllArguments, truncated: detail?.argsTruncated == true)
                    } else if let sentence = detail?.argsNoteText {
                        note(sentence)
                    }
                    if let result = detail?.result {
                        block("Result", result, lines: 12, showsAll: $showsAllResult, truncated: detail?.resultTruncated == true)
                    } else if let sentence = detail?.resultNoteText {
                        note(sentence)
                    }
                    if let results = call.web?.results, !results.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(results.enumerated()), id: \.offset) { index, result in
                                if let url = URL(string: result.url) {
                                    SourceRow(source: NativeChatSource(title: result.title, url: url, snippet: ""), number: index + 1)
                                }
                            }
                        }
                    }
                }
                .padding(.leading, JunoSpace.regular + 2)
                .transition(.opacity)
            }
        }
    }

    private func note(_ sentence: String) -> some View {
        Text(sentence)
            .junoFont(size: 12, relativeTo: .footnote)
            .foregroundStyle(Color.junoSecondaryInk)
    }

    private func block(
        _ title: String,
        _ text: String,
        lines: Int,
        showsAll: Binding<Bool>,
        truncated: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(title)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
            Text(text)
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
                .lineLimit(showsAll.wrappedValue ? nil : lines)
                .fixedSize(horizontal: false, vertical: true)
                .padding(JunoSpace.snug)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(Color.junoSecondary)
                )
            if !showsAll.wrappedValue, text.components(separatedBy: "\n").count > lines {
                Button("Show all") { showsAll.wrappedValue = true }
                    .buttonStyle(MessageGhostButtonStyle(fontSize: 11, horizontalPadding: 6))
                    .contentShape(.rect)
                    .padding(.leading, -6)
            }
            if truncated {
                Text("Shortened: only the start was kept.")
                    .junoFont(size: 11, relativeTo: .caption)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
        }
    }
}

/// The web's `splitSources`: a source a `[n]` in the answer points at is
/// *cited*, in the order first cited; every other one was read. Only an answer
/// written from a numbered corpus (`cited`) has citations at all.
struct DesktopSourceSplit {
    struct Entry {
        let source: NativeChatSource
        let number: Int
    }

    let cited: [Entry]
    let read: [Entry]

    init(message: NativeChatMessage) {
        let numbered = message.sources.enumerated().map { Entry(source: $1, number: $0 + 1) }
        guard message.sources.contains(where: \.cited) else {
            cited = []
            read = numbered
            return
        }
        var order: [Int] = []
        let text = message.content as NSString
        if let expression = try? NSRegularExpression(pattern: #"\[(\d{1,3})\]"#) {
            for match in expression.matches(in: message.content, range: NSRange(location: 0, length: text.length)) {
                if let number = Int(text.substring(with: match.range(at: 1))),
                    (1...message.sources.count).contains(number), !order.contains(number)
                {
                    order.append(number)
                }
            }
        }
        cited = order.map { numbered[$0 - 1] }
        read = numbered.filter { !order.contains($0.number) }
    }
}
