import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - The right-column shell

/// The trailing dock's panel frame for the run's detail surfaces — the
/// rework's `RightColumnShell` (Tool calls & research SPEC §8.2), shared by
/// the Activity and Research panels: a stable name (the heading, never the
/// live phase), a static status beside it that never shimmers, the header's
/// own actions, then a view switch and a scrolling body. Close is the last
/// control; Escape closes too.
struct DesktopPanelShell<Tab: Hashable, Actions: View, Content: View>: View {
    /// "Activity" or "Research": the heading and the panel's accessible name.
    let label: String
    /// The static phase word and clock, or the settled summary, at a time.
    let status: (Date) -> String?
    /// The status carries a running clock: it redraws each second, and only
    /// it does.
    var ticks = false
    var statusIsWarning = false
    let tabs: [JunoSegmented<Tab>.Option]
    @Binding var tab: Tab
    let close: () -> Void
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: JunoSpace.snug) {
                Text(label)
                    .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                if ticks {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        statusText(status(context.date))
                    }
                } else {
                    statusText(status(.now))
                }
                Spacer(minLength: JunoSpace.snug)
                actions()
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(width: 1, height: 20)
                    .padding(.horizontal, 1)
                    .accessibilityHidden(true)
                Button(action: close) {
                    JunoIconView(.close, size: 14)
                        .junoSecondaryInk()
                        .frame(width: 28, height: 28)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Close panel")
                .accessibilityLabel("Close panel")
            }
            .padding(.leading, JunoSpace.regular)
            .padding(.trailing, JunoSpace.snug)
            .padding(.vertical, JunoSpace.snug)
            .frame(minHeight: 44)
            .background(Color.junoSurface.opacity(0.5))
            Divider()
            if tabs.count > 1 {
                JunoSegmented(options: tabs, selection: $tab, accessibilityLabel: "\(label) view")
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Divider()
            }
            Color.clear.overlay { content() }
                .clipped()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func statusText(_ text: String?) -> some View {
        if let text {
            Text(text)
                .junoFont(size: 12, relativeTo: .footnote)
                .monospacedDigit()
                .foregroundStyle(statusIsWarning ? Color.junoWarningInk : Color.junoSecondaryInk)
                .lineLimit(1)
                .truncationMode(.tail)
                // The announcer speaks the live state; the heading does not.
                .accessibilityHidden(true)
        }
    }
}

// MARK: - Activity

/// The run's detail surface in the trailing dock — the rework's **Activity**
/// panel (SPEC §8.3; DECISIONS U3). Nothing in it is needed to read the
/// thinking; it is where a reader goes for the arguments, the results and the
/// receipts.
///
/// Three views, each shown only when it has something (a tab with nothing to
/// show is left out, not disabled), and the last one chosen is remembered:
///
/// - **Timeline:** the reasoning as prose, interleaved with the tool calls
///   and notices in the order they happened. A call opens to its arguments,
///   its result, its approval receipt and its error — and a pending approval
///   can be answered from its row.
/// - **Sources:** *Cited*, then *Also read* (and *Found*, when nothing was
///   cited or read).
/// - **Details:** the model, the effort, the context, the tools, the
///   connectors and the memory used, with Forget.
///
/// What the rework takes out, and so this never has: cost as a headline, the
/// five-way filter, Summary/Full, the Research/Think/Write ledger.
///
/// Keyed by the reply, it survives the answer completing (the workspace
/// follows the placeholder's id to the server's); it closes when the reader
/// closes it, when the conversation changes, or when the reply leaves.
struct DesktopActivityPanel: View {
    let message: NativeChatMessage
    let live: Bool
    var recovering = false
    /// The call the panel was opened on: expanded, and scrolled to.
    var focusCallID: String? = nil
    /// The live approvals, so a pending call can be answered here too.
    var approvals = MessageRowApprovals()
    /// The model's context window, for "Context used".
    var contextWindow: Int? = nil
    /// Writes "Try again: …" into the composer, for a failed connector call.
    var seedDraft: ((String) -> Void)? = nil
    /// Forgets one saved memory.
    var forgetMemory: ((String) async -> Void)? = nil
    let close: () -> Void

    enum Tab: String, Hashable { case timeline, sources, details }

    @AppStorage("activity.tab") private var storedTab = Tab.timeline.rawValue
    @State private var expandedCalls = Set<String>()
    @State private var forgotten = Set<String>()
    @State private var showsTools = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotActivityTab) private var snapshotTab

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
        if !view.items.isEmpty || live { tabs.append(.timeline) }
        if !message.sources.isEmpty { tabs.append(.sources) }
        if !view.facts.isEmpty || message.model != nil { tabs.append(.details) }
        return tabs
    }

    var body: some View {
        let view = view
        let tabs = tabs(for: view)
        let chosen = snapshotTab.flatMap(Tab.init(rawValue:)) ?? Tab(rawValue: storedTab) ?? .timeline
        let shown = tabs.contains(chosen) ? chosen : (tabs.first ?? .timeline)
        DesktopPanelShell(
            label: "Activity",
            status: { now in status(view: view, now: now) },
            ticks: live,
            statusIsWarning: message.errorDescription != nil && !live,
            tabs: tabs.map { tab in
                switch tab {
                case .timeline: JunoSegmented<Tab>.Option(.timeline, "Timeline")
                case .sources: JunoSegmented<Tab>.Option(.sources, "Sources \(message.sources.count)")
                case .details: JunoSegmented<Tab>.Option(.details, "Details")
                }
            },
            tab: Binding(get: { shown }, set: { storedTab = $0.rawValue }),
            close: close,
            actions: { EmptyView() },
            content: {
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
                                case .sources: DesktopActivitySources(message: message)
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
        )
        .accessibilityIdentifier("juno.desktop.chat.activity-panel")
    }

    /// The header's static phase word and clock while the run works; the
    /// summary's lead at rest (SPEC §8.3). Never a loop, never a shimmer.
    private func status(view: NativeRunView, now: Date) -> String? {
        let phase = NativeRunPhase.derive(
            view: view,
            live: live,
            failed: message.errorDescription != nil,
            finishReason: message.finishReason,
            answerStarted: message.answerStartedAt != nil || (!message.content.isEmpty && !live),
            awaitingApproval: !approvals.approvals.filter(\.isPending).isEmpty
        )
        if recovering { return "Reconnecting…" }
        let word: String
        switch phase {
        case .queued, .thinking: word = "Thinking"
        case .searching: word = "Searching"
        case .reading: word = "Reading"
        case .tool: word = "Working"
        case .waiting: return "Waiting for your approval"
        case .stopped, .failed, .answering, .done:
            let worked = view.timing.workedMs ?? message.runStartedAt.flatMap { started in
                (message.answerStartedAt ?? (live ? nil : message.createdAt)).map {
                    Int(max(0, $0.timeIntervalSince(started)) * 1_000)
                }
            }
            switch phase {
            case .stopped: return NativeToolPresentation.stoppedLine(workedMs: worked).text
            case .failed: return NativeToolPresentation.failedRunLine(workedMs: worked).text
            default: return NativeToolPresentation.summaryLead(view, workedMs: worked)?.text
            }
        }
        guard let started = message.runStartedAt else { return word }
        let seconds = Int(max(0, now.timeIntervalSince(started)))
        return seconds >= 3 ? "\(word) · \(NativeToolPresentation.clock(seconds: seconds))" : word
    }

    private func focus(proxy: ScrollViewProxy) {
        guard let focusCallID else { return }
        storedTab = Tab.timeline.rawValue
        expandedCalls.insert(focusCallID)
        Task { @MainActor in
            await Task.yield()
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                proxy.scrollTo(focusCallID, anchor: .center)
            }
        }
    }

    // MARK: Timeline

    private func timeline(view: NativeRunView) -> some View {
        let running = view.calls.contains(where: \.status.isActive)
        let lastReasoning = view.items.last(where: \.isReasoning)?.id
        return VStack(alignment: .leading, spacing: JunoSpace.regular) {
            ForEach(view.items) { item in
                switch item {
                case .reasoning(let id, let text):
                    HStack(alignment: .top, spacing: JunoSpace.snug) {
                        JunoMarkdownText(Self.headlined(text))
                            .environment(\.junoProseStyle, .reading)
                            .foregroundStyle(Color.junoForeground)
                        if live, !running, id == lastReasoning {
                            // The panel's live item owns the loop while it is open.
                            JunoRunSignature(phase: .thinking, loops: true, size: .small)
                                .padding(.top, 6)
                        }
                    }
                case .commentary(_, let text, _):
                    DesktopRunCommentary(paragraphs: [text])
                case .tool(_, let call, let detail):
                    DesktopToolCallDetail(
                        call: call,
                        detail: detail,
                        live: live,
                        approval: approvals.approvals.first { $0.id == call.approval?.id && $0.isPending },
                        approvals: approvals,
                        seedDraft: seedDraft,
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
            if !message.liveCommentary.isEmpty {
                DesktopRunCommentary(paragraphs: message.liveCommentary.map(\.text))
            }
        }
    }

    /// A provider's `**Headline**` first line, as a heading (SPEC §8.3.1).
    static func headlined(_ text: String) -> String {
        guard let headline = NativeToolPresentation.headline(of: text) else { return text }
        var lines = text.components(separatedBy: "\n")
        if let index = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "**\(headline)**" }) {
            lines[index] = "### \(headline)"
        }
        return lines.joined(separator: "\n")
    }

    // MARK: Details

    private func details(view: NativeRunView) -> some View {
        let facts = view.facts
        return VStack(alignment: .leading, spacing: JunoSpace.regular) {
            if let model = facts.model ?? message.model.map(junoDisplayModelName) {
                fact("Model", [model, facts.modelProvider].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            }
            if let effort = facts.effort {
                let label = NativeReasoningEffort(rawValue: effort)?.label ?? (effort == "instant" ? "Instant" : effort)
                fact("Effort", facts.effortAuto ? "\(label) (Auto)" : label)
            }
            if let context = contextLine(facts) { fact("Context", context) }
            if !facts.toolsOffered.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Button {
                        withAnimation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion)) { showsTools.toggle() }
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            factName("Tools available")
                            Text(facts.toolsOffered.count.formatted())
                                .junoFont(size: 12, relativeTo: .footnote)
                                .monospacedDigit()
                                .foregroundStyle(Color.junoSecondaryInk)
                            JunoIconView(.chevronRight, size: 10, weight: .bold)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .rotationEffect(.degrees(showsTools ? 90 : 0))
                        }
                        .frame(minHeight: 28)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(showsTools ? "Expanded" : "Collapsed")
                    if showsTools {
                        ForEach(facts.toolsOffered, id: \.self) { tool in
                            Text(NativeToolPresentation.toolName(tool))
                                .junoFont(size: 13, relativeTo: .callout)
                                .foregroundStyle(Color.junoForeground)
                        }
                    }
                }
            }
            if !facts.connectorsReady.isEmpty || !facts.connectorsFailed.isEmpty || facts.connectors != nil {
                VStack(alignment: .leading, spacing: 2) {
                    factName("Connectors")
                    ForEach(facts.connectorsReady, id: \.id) { connector in
                        connectorRow(connector.label, state: "Connected", warning: false)
                    }
                    ForEach(facts.connectorsFailed, id: \.id) { connector in
                        connectorRow(
                            connector.label,
                            state: NativeToolPresentation.connectorFailure(connector.reason ?? "").text,
                            warning: true
                        )
                    }
                    if facts.connectorsReady.isEmpty, facts.connectorsFailed.isEmpty, let legacy = facts.connectors {
                        Text(legacy)
                            .junoFont(size: 13, relativeTo: .callout)
                            .foregroundStyle(Color.junoForeground)
                    }
                }
            }
            if !facts.memory.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    factName("Memory used")
                    ForEach(facts.memory) { memory in
                        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                            JunoIconView(.memory, size: 13)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .accessibilityHidden(true)
                            Text(memory.content)
                                .junoFont(size: 13, relativeTo: .callout)
                                .foregroundStyle(forgotten.contains(memory.id) ? Color.junoSecondaryInk : Color.junoForeground)
                                .strikethrough(forgotten.contains(memory.id))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: JunoSpace.snug)
                            if let forgetMemory, !forgotten.contains(memory.id) {
                                Button("Forget") {
                                    forgotten.insert(memory.id)
                                    Task { await forgetMemory(memory.id) }
                                }
                                .buttonStyle(MessageGhostButtonStyle(fontSize: 12, horizontalPadding: 8))
                                .contentShape(.rect)
                                .accessibilityLabel("Forget this memory")
                            } else if forgotten.contains(memory.id) {
                                Text("Forgotten")
                                    .junoFont(size: 12, relativeTo: .footnote)
                                    .foregroundStyle(Color.junoSecondaryInk)
                            }
                        }
                    }
                }
            }
        }
    }

    /// "Context used 12,480 tokens · Window 200,000 tokens", or the counts
    /// the turn started with when either number is unknown.
    private func contextLine(_ facts: NativeRunView.Facts) -> String? {
        if let used = message.promptTokens, let window = contextWindow {
            return NativeRunPhraseLine([
                NativeRunPhrase([.phrase("Context used"), .count(used, one: "token", other: "tokens", approx: false)]),
                NativeRunPhrase([.phrase("Window"), .count(window, one: "token", other: "tokens", approx: false)]),
            ]).text
        }
        if let counts = facts.contextCounts {
            var phrases = [NativeRunPhrase([.count(counts.historyMessages, one: "earlier message", other: "earlier messages", approx: false)])]
            if counts.attachments > 0 {
                phrases.append(NativeRunPhrase([.count(counts.attachments, one: "attachment", other: "attachments", approx: false)]))
            }
            if counts.projectFiles > 0 {
                phrases.append(NativeRunPhrase([.count(counts.projectFiles, one: "project file", other: "project files", approx: false)]))
            }
            return NativeRunPhraseLine(phrases).text
        }
        return facts.context
    }

    private func connectorRow(_ label: String, state: String, warning: Bool) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Text(label)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
            Text(state)
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(warning ? Color.junoWarningInk : Color.junoSecondaryInk)
        }
        .frame(minHeight: 24)
    }

    private func factName(_ name: String) -> some View {
        Text(name)
            .junoFont(size: 12, relativeTo: .footnote, weight: .medium)
            .foregroundStyle(Color.junoSecondaryInk)
            .accessibilityAddTraits(.isHeader)
    }

    private func fact(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            factName(name)
            Text(value)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

extension EnvironmentValues {
    /// Opens the Activity panel on a view — the harness's stand-in for a tab
    /// click. Production never sets it.
    @Entry var junoSnapshotActivityTab: String? = nil
}

// MARK: - Sources

/// The Sources view: *Cited* — the sources a `[n]` in the answer points at,
/// by first citation, with the number — then *Also read*, by first
/// appearance. Search results nothing opened or cited are listed under a
/// quiet *Found* only when nothing was cited or read (SPEC §8.3.2).
struct DesktopActivitySources: View {
    let message: NativeChatMessage

    var body: some View {
        let split = DesktopSourceSplit(message: message)
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if !split.cited.isEmpty {
                section("Cited", count: split.cited.count) {
                    ForEach(split.cited, id: \.number) { entry in
                        SourceRow(source: entry.source, number: entry.number)
                    }
                }
            }
            if !split.read.isEmpty {
                section(split.cited.isEmpty ? "Read" : "Also read", count: split.read.count) {
                    ForEach(split.read, id: \.number) { entry in
                        SourceRow(source: entry.source, number: entry.number)
                    }
                }
            }
            if split.cited.isEmpty, split.read.isEmpty, !split.found.isEmpty {
                section("Found", count: split.found.count) {
                    ForEach(split.found, id: \.number) { entry in
                        SourceRow(source: entry.source, number: entry.number)
                    }
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, count: Int, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.tight) {
                Text(title)
                    .junoFont(size: 12, relativeTo: .footnote, weight: .semibold)
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(count.formatted())
                    .junoFont(size: 12, relativeTo: .footnote)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

/// The web's `splitSources`: a source a `[n]` in the answer points at is
/// *cited*, in the order first cited; a search result nothing opened or cited
/// was only *found*; every other one was *read*. Only an answer written from a
/// numbered corpus (`cited`) has citations at all.
struct DesktopSourceSplit {
    struct Entry {
        let source: NativeChatSource
        let number: Int
    }

    let cited: [Entry]
    let read: [Entry]
    let found: [Entry]

    init(message: NativeChatMessage) {
        let numbered = message.sources.enumerated().map { Entry(source: $1, number: $0 + 1) }
        // Pages a `web_fetch` opened: a search result among them was read.
        let opened = Set(message.activity.compactMap { event -> String? in
            guard let call = event.call, call.tool == "web_fetch", call.status == .succeeded else { return nil }
            return call.web?.finalURL
        })
        var order: [Int] = []
        if message.sources.contains(where: \.cited) {
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
        }
        cited = order.map { numbered[$0 - 1] }
        let rest = numbered.filter { !order.contains($0.number) }
        found = rest.filter { $0.source.origin == "juno_search" && !opened.contains($0.source.url.absoluteString) }
        let foundNumbers = Set(found.map(\.number))
        read = rest.filter { !foundNumbers.contains($0.number) }
    }
}

// MARK: - One call

/// One call in the panel: its line, opening to what was sent and what came
/// back, exactly as the server kept them — or the sentence that says why they
/// are not here — its approval receipt and its error (SPEC §8.3.1).
struct DesktopToolCallDetail: View {
    let call: NativeToolCall
    let detail: NativeToolDetail?
    var live = false
    /// The live approval this call is waiting on, when it is.
    var approval: NativeChatApproval? = nil
    var approvals = MessageRowApprovals()
    var seedDraft: ((String) -> Void)? = nil
    @Binding var expanded: Bool
    @State private var showsAllArguments = false
    @State private var showsAllResult = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                    // The open panel's running row owns the loop.
                    DesktopToolCallLine(call: call, loops: live && call.status == .running)
                }
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .contentShape(.rect)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if let approval, approval.isPending {
                decision(approval)
                    .padding(.leading, JunoSpace.regular + 2)
            }
            if expanded {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    if call.status.isTerminal, call.status != .succeeded {
                        VStack(alignment: .leading, spacing: 2) {
                            // The row already says it when its line is the
                            // failure phrase ("Couldn't open nature.com").
                            if !NativeToolPresentation.phrase(call).hasSuffix(NativeToolPresentation.failurePhrase(call).text) {
                                Text(NativeToolPresentation.failurePhrase(call).text)
                                    .junoFont(size: 13, relativeTo: .callout)
                                    .foregroundStyle(NativeToolPresentation.readsAsFailure(call) ? Color.junoWarningInk : Color.junoSecondaryInk)
                            }
                            if let detail = call.errorDetail {
                                Text(detail)
                                    .junoFont(size: 12, relativeTo: .footnote)
                                    .foregroundStyle(Color.junoSecondaryInk)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    if let receipt = DesktopApprovalReceipt.words(for: call) {
                        Text(receipt)
                            .junoFont(size: 12, relativeTo: .footnote)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    arguments
                    result
                    if call.tool == "mcp", call.status == .failed, call.errorCode != "blocked", let seedDraft {
                        Button("Ask to run again") {
                            seedDraft("Try again: \(call.toolTitle ?? call.connectorLabel ?? "the tool")")
                        }
                        .buttonStyle(MessageGhostButtonStyle(fontSize: 12, horizontalPadding: 8))
                        .contentShape(.rect)
                        .padding(.leading, -8)
                    }
                }
                .padding(.leading, JunoSpace.regular + 2)
                .transition(.opacity)
            }
        }
    }

    // MARK: Parts

    @ViewBuilder
    private var arguments: some View {
        if let arguments = detail?.args {
            block("Arguments", arguments, lines: 12, showsAll: $showsAllArguments, truncated: detail?.argsTruncated == true)
        } else if let sentence = detail?.argsNoteText {
            note(sentence)
        } else if !call.args.isEmpty {
            block("Arguments", Self.json(call.args), lines: 12, showsAll: $showsAllArguments)
        }
    }

    @ViewBuilder
    private var result: some View {
        if call.tool == "web_fetch", let web = call.web, call.status == .succeeded {
            VStack(alignment: .leading, spacing: 2) {
                if let final = web.finalURL, let url = URL(string: final) {
                    SourceRow(source: NativeChatSource(title: SourceHost.name(url), url: url, snippet: ""), number: 1)
                }
                if let figure = NativeToolPresentation.figure(call) {
                    note(figure)
                }
                if web.injection != nil {
                    Text("Contained instructions aimed at the assistant; they were ignored")
                        .junoFont(size: 12, relativeTo: .footnote)
                        .foregroundStyle(Color.junoWarningInk)
                }
            }
        } else if let results = call.web?.results, !results.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(results.enumerated()), id: \.offset) { index, result in
                    if let url = URL(string: result.url) {
                        SourceRow(source: NativeChatSource(title: result.title, url: url, snippet: ""), number: result.n ?? index + 1)
                    }
                }
            }
        } else if let text = detail?.result {
            block(call.tool == "run_code" ? "Output" : "Result", text, lines: call.tool == "run_code" ? 40 : 12, showsAll: $showsAllResult, truncated: detail?.resultTruncated == true)
        } else if let sentence = detail?.resultNoteText {
            note(sentence)
        } else if call.status == .succeeded, let figure = NativeToolPresentation.figure(call) {
            note(figure)
        }
    }

    /// Allow once / Always allow / Decline, as the card offers them, answered
    /// through the same approval route.
    private func decision(_ approval: NativeChatApproval) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Button("Don’t allow") { approvals.decide(approval, .deny) }
                .buttonStyle(MessageGhostButtonStyle(fontSize: 12, horizontalPadding: 10))
                .contentShape(.rect)
            if approvals.canAllowScope(approval) {
                Button("Always allow") { approvals.decide(approval, .allowScope) }
                    .buttonStyle(MessageGhostButtonStyle(fontSize: 12, horizontalPadding: 10))
                    .contentShape(.rect)
            }
            Button("Allow once") { approvals.decide(approval, .allowOnce) }
                .buttonStyle(MessageGhostButtonStyle(fontSize: 12, horizontalPadding: 10))
                .contentShape(.rect)
        }
        .contentShape(.rect)
        .disabled(approvals.inFlightID == approval.id)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Approval for \(NativeToolPresentation.phrase(call))")
    }

    static func json(_ args: [String: String]) -> String {
        let data = try? JSONSerialization.data(withJSONObject: args, options: [.prettyPrinted, .sortedKeys])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? args.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
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
