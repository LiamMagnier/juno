import Foundation
import JunoCodeCore

/// The console's line assembly, lifted out of ``SessionController``.
///
/// It is one of the three pieces of that 2,400-line observable that is a pure
/// state machine rather than a bridge to an actor, and it is the subtlest:
/// output arrives as pipe reads, not as lines. One chunk can carry twenty
/// newlines and can end mid-line, with the rest of that line arriving in the
/// next chunk — possibly on a different channel, possibly from a different tool
/// call, possibly not at all.
///
/// Splitting on newlines and continuing the previous partial line is what makes
/// the console a line-oriented log, and what makes the 2,000-entry bound mean
/// two thousand *lines* rather than two thousand arbitrary reads.
///
/// A struct rather than a class, so a controller that holds one still publishes
/// a change when it mutates: `@Observable` sees the whole property being
/// written and the console redraws exactly as it did when these were five
/// stored properties on the controller itself.
struct SessionTerminalLog: Equatable {
    /// Beyond this many lines the oldest are dropped. A long `npm test` can
    /// print tens of thousands; the console is a tail, not an archive.
    static let lineLimit = 2_000

    private(set) var lines: [TerminalLine] = []
    /// Monotonic, never reused — it is the SwiftUI identity of each row, so a
    /// counter that restarted would make two different lines the same row.
    private(set) var lineCounter = 0
    /// The line still waiting for its terminator, if the last chunk ended
    /// mid-line.
    private var pending: (id: Int, channel: ToolOutputChannel, toolCallID: String?)?

    static func == (lhs: SessionTerminalLog, rhs: SessionTerminalLog) -> Bool {
        lhs.lines == rhs.lines && lhs.lineCounter == rhs.lineCounter
    }

    mutating func clear() {
        lines = []
        lineCounter = 0
        pending = nil
    }

    /// Seeds the counter from a restored fixture so new lines keep climbing.
    mutating func adopt(lines: [TerminalLine]) {
        self.lines = lines
        lineCounter = lines.last?.id ?? 0
        pending = nil
    }

    /// Folds one chunk of streamed output into lines.
    ///
    /// Carriage returns are treated as line breaks: the executor runs commands
    /// with `TERM=dumb` and `NO_COLOR`, so a lone `\r` is a progress redraw with
    /// no cursor to honour it.
    mutating func append(channel: ToolOutputChannel, text: String, toolCallID: String?) {
        guard !text.isEmpty else { return }
        var buffer = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        // Only continue the partial line when the new chunk belongs to the same
        // stream. Interleaved stdout and stderr, or output from a different tool
        // call, must not be spliced into the middle of someone else's sentence.
        if let pending,
           pending.channel == channel,
           pending.toolCallID == toolCallID,
           let index = lines.lastIndex(where: { $0.id == pending.id })
        {
            buffer = lines[index].text + buffer
            lines.remove(at: index)
        }
        pending = nil

        let endsOnLineBreak = buffer.hasSuffix("\n")
        var pieces = buffer.components(separatedBy: "\n")
        if endsOnLineBreak {
            pieces.removeLast()
        }
        for (offset, piece) in pieces.enumerated() {
            lineCounter += 1
            lines.append(
                TerminalLine(
                    id: lineCounter,
                    channel: channel,
                    text: piece,
                    toolCallID: toolCallID
                )
            )
            if offset == pieces.count - 1, !endsOnLineBreak {
                pending = (lineCounter, channel, toolCallID)
            }
        }
        if lines.count > Self.lineLimit {
            lines.removeFirst(lines.count - Self.lineLimit)
        }
    }

    /// Replays a transcript's recorded output.
    ///
    /// Reopening a session used to show an empty log beside a transcript full of
    /// tool output, because the console was only ever fed by events arriving
    /// live. The output is part of the record, so it is rebuilt from the record.
    mutating func rebuild(from events: [SessionEvent]) {
        clear()
        for event in events {
            guard case let .toolOutput(output) = event.payload else { continue }
            append(channel: output.channel, text: output.text, toolCallID: output.toolCallID)
        }
    }
}
