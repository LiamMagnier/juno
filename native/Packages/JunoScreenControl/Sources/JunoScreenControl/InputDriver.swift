import Foundation

public enum MouseButton: String, Hashable, Codable, Sendable {
    case left, right, middle
}

/// One input event, as a value.
///
/// The driver plans events and hands them to an ``EventSink``. Production
/// turns them into `CGEvent`s; tests keep them, so a click's path from a
/// model coordinate to the point it would land on is checked without one
/// real event being posted (CODE_AGENT_SPEC §6.3).
public enum SyntheticEvent: Hashable, Sendable {
    case mouseMove(ScreenPoint)
    case mouseDown(MouseButton, ScreenPoint, clickCount: Int, modifiers: KeyModifiers)
    case mouseUp(MouseButton, ScreenPoint, clickCount: Int, modifiers: KeyModifiers)
    case mouseDrag(MouseButton, ScreenPoint)
    /// A key with the text it types. `keyCode` 0 with text is the Unicode
    /// path for characters no key types.
    case keyDown(keyCode: UInt16, modifiers: KeyModifiers, text: [UInt16])
    case keyUp(keyCode: UInt16, modifiers: KeyModifiers, text: [UInt16])
    /// Line units; positive `dy` scrolls toward the top (wheel up), positive
    /// `dx` toward the left.
    case scroll(dx: Int32, dy: Int32, at: ScreenPoint, modifiers: KeyModifiers)

    /// Where a pointer event lands.
    public var point: ScreenPoint? {
        switch self {
        case let .mouseMove(point), let .mouseDrag(_, point): point
        case let .mouseDown(_, point, _, _), let .mouseUp(_, point, _, _): point
        case let .scroll(_, _, point, _): point
        case .keyDown, .keyUp: nil
        }
    }
}

/// Where events go.
public enum EventTarget: Hashable, Sendable {
    /// To one process: background mode, where the reader keeps the pointer.
    case process(pid: Int32)
    /// To the whole session: takeover mode only.
    case global
}

/// Posts planned events. The only thing that touches the real input stream.
public protocol EventSink: Sendable {
    func post(_ events: [SyntheticEvent], to target: EventTarget) async throws
}

/// What `type` sent, chunk by chunk, for the read-back and for tests.
public struct TypingPlan: Hashable, Sendable {
    /// One posted unit: a keyed character, or a run of up to 16 UTF-16 units
    /// sent as a Unicode payload.
    public enum Unit: Hashable, Sendable {
        case key(KeyStroke, text: [UInt16])
        case named(NamedKey)
        case unicode([UInt16])

        public var text: [UInt16] {
            switch self {
            case let .key(_, text): text
            case let .unicode(text): text
            case let .named(named):
                switch named {
                case .return: [0x0D]
                case .tab: [0x09]
                default: []
                }
            }
        }
    }

    public var units: [Unit]

    /// The text the plan types, for checking it against what was asked.
    public var typedText: String {
        var result = ""
        for unit in units {
            switch unit {
            case .named(.return): result += "\n"
            case .named(.tab): result += "\t"
            case .named: break
            case let .key(_, text), let .unicode(text):
                result += String(utf16CodeUnits: text, count: text.count)
            }
        }
        return result
    }
}

/// Turns actions into events: move before click, chunked typing, layout-aware
/// chords (CODE_AGENT_SPEC §3.6).
public struct InputDriver: Sendable {
    /// macOS keeps 20 UTF-16 units of a Unicode keyboard event and drops the
    /// rest without saying so; the old tool reported success for text it cut
    /// (CU-03). 16 leaves room.
    public static let chunkUnits = 16

    public let layout: KeyboardLayout
    public let sink: any EventSink
    /// Pacing between typed chunks and keys, and the settle after a move.
    public let pause: @Sendable (Duration) async throws -> Void
    /// Throws once the reader has stopped screen control. Called between
    /// every typed unit, repeated key, drag step and slice of a held key, so
    /// Esc ends a long `type` or a 30-second `hold_key` where it is rather
    /// than after the last character has gone in (CODE_AGENT_SPEC §3.7:
    /// "Stop cancels the in-flight action").
    public let checkpoint: @Sendable () async throws -> Void

    /// The longest single sleep inside a held key, so a stop is seen within
    /// this much time.
    static let holdSlice: Duration = .milliseconds(100)

    public init(
        layout: KeyboardLayout,
        sink: any EventSink,
        pause: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        checkpoint: @escaping @Sendable () async throws -> Void = {}
    ) {
        self.layout = layout
        self.sink = sink
        self.pause = pause
        self.checkpoint = checkpoint
    }

    // MARK: Pointer

    /// Moves first, so controls that appear on hover exist when the click
    /// arrives (as JunoWork's driver always did), then down and up `count`
    /// times with the click state macOS reads for double and triple clicks.
    public func click(
        at point: ScreenPoint,
        button: MouseButton = .left,
        count: Int = 1,
        modifiers: KeyModifiers = [],
        target: EventTarget
    ) async throws {
        try await sink.post([.mouseMove(point)], to: target)
        try await pause(.milliseconds(40))
        try await checkpoint()
        var events: [SyntheticEvent] = []
        for index in 1...max(1, min(count, 3)) {
            events.append(.mouseDown(button, point, clickCount: index, modifiers: modifiers))
            events.append(.mouseUp(button, point, clickCount: index, modifiers: modifiers))
        }
        try await sink.post(events, to: target)
    }

    public func move(to point: ScreenPoint, target: EventTarget) async throws {
        try await sink.post([.mouseMove(point)], to: target)
    }

    public func mouseDown(at point: ScreenPoint, target: EventTarget) async throws {
        try await sink.post([.mouseMove(point), .mouseDown(.left, point, clickCount: 1, modifiers: [])], to: target)
    }

    public func mouseUp(at point: ScreenPoint, target: EventTarget) async throws {
        try await sink.post([.mouseUp(.left, point, clickCount: 1, modifiers: [])], to: target)
    }

    /// Press at `start`, drag through intermediate points, release at `end`.
    public func drag(from start: ScreenPoint, to end: ScreenPoint, target: EventTarget) async throws {
        try await sink.post([.mouseMove(start), .mouseDown(.left, start, clickCount: 1, modifiers: [])], to: target)
        let steps = 8
        var reached = start
        do {
            for step in 1...steps {
                let fraction = Double(step) / Double(steps)
                let point = ScreenPoint(
                    x: start.x + (end.x - start.x) * fraction,
                    y: start.y + (end.y - start.y) * fraction
                )
                try await pause(.milliseconds(12))
                try await checkpoint()
                try await sink.post([.mouseDrag(.left, point)], to: target)
                reached = point
            }
        } catch {
            // A stop mid-drag still lets the button go, where the pointer
            // is, so nothing is left held down.
            try? await sink.post([.mouseUp(.left, reached, clickCount: 1, modifiers: [])], to: target)
            throw error
        }
        try await sink.post([.mouseUp(.left, end, clickCount: 1, modifiers: [])], to: target)
    }

    /// `amount` notches in `direction`. Up scrolls toward the top of the
    /// content, as turning a mouse wheel up does.
    public func scroll(
        at point: ScreenPoint,
        direction: ScreenAction.ScrollDirection,
        amount: Int,
        modifiers: KeyModifiers = [],
        target: EventTarget
    ) async throws {
        let notches = Int32(max(1, min(amount, 30)))
        let (dx, dy): (Int32, Int32) = switch direction {
        case .up: (0, notches)
        case .down: (0, -notches)
        case .left: (notches, 0)
        case .right: (-notches, 0)
        }
        try await sink.post([.mouseMove(point), .scroll(dx: dx, dy: dy, at: point, modifiers: modifiers)], to: target)
    }

    // MARK: Keys

    /// A chord, `repeatCount` times, resolved on the active layout.
    public func key(_ chord: String, repeatCount: Int = 1, target: EventTarget) async throws {
        let stroke = try layout.resolve(chord: chord)
        for index in 0..<max(1, min(repeatCount, 100)) {
            if index > 0 {
                try await pause(.milliseconds(15))
                try await checkpoint()
            }
            // The modifiers go on both halves. A key-down with ⌘ and a key-up
            // without leaves the app believing ⌘ is still held.
            try await sink.post([
                .keyDown(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: []),
                .keyUp(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: []),
            ], to: target)
        }
    }

    /// Down, wait, up.
    public func hold(_ chord: String, seconds: Double, target: EventTarget) async throws {
        let stroke = try layout.resolve(chord: chord)
        let duration = max(0, min(seconds, ScreenAction.maximumDurationSeconds))
        try await sink.post([.keyDown(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: [])], to: target)
        do {
            // In slices, each followed by the stop check: Esc lets the key go
            // within a slice, not at the end of the hold.
            var remaining = Duration.milliseconds(Int((duration * 1_000).rounded()))
            while remaining > .zero {
                let slice = min(remaining, Self.holdSlice)
                try await pause(slice)
                remaining -= slice
                try await checkpoint()
            }
        } catch {
            // A stop while a key is held still lets the key go.
            try? await sink.post([.keyUp(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: [])], to: target)
            throw error
        }
        try await sink.post([.keyUp(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: [])], to: target)
    }

    /// Types `text`, paced, in units no longer than ``chunkUnits``.
    @discardableResult
    public func type(_ text: String, target: EventTarget) async throws -> TypingPlan {
        let plan = Self.plan(text, layout: layout)
        for (index, unit) in plan.units.enumerated() {
            if index > 0 {
                try await pause(.milliseconds(8))
                // A stop between two chunks ends the typing there.
                try await checkpoint()
            }
            switch unit {
            case let .key(stroke, text):
                try await sink.post([
                    .keyDown(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: text),
                    .keyUp(keyCode: stroke.keyCode, modifiers: stroke.modifiers, text: text),
                ], to: target)
            case let .named(named):
                try await sink.post([
                    .keyDown(keyCode: named.keyCode, modifiers: [], text: []),
                    .keyUp(keyCode: named.keyCode, modifiers: [], text: []),
                ], to: target)
            case let .unicode(units):
                try await sink.post([
                    .keyDown(keyCode: 0, modifiers: [], text: units),
                    .keyUp(keyCode: 0, modifiers: [], text: units),
                ], to: target)
            }
        }
        return plan
    }

    /// The units `type` would send.
    ///
    /// A character the layout types with one key goes as that key, carrying
    /// its text too, so apps that read key codes (some Java apps, games,
    /// terminals) get the right letter (CU-24). Everything else — emoji,
    /// accents the layout reaches only through a dead key — goes as Unicode
    /// payloads, grouped up to 16 UTF-16 units without splitting a character.
    /// Newlines and tabs are the Return and Tab keys.
    public static func plan(_ text: String, layout: KeyboardLayout) -> TypingPlan {
        var units: [TypingPlan.Unit] = []
        var run: [UInt16] = []

        func flush() {
            if !run.isEmpty {
                units.append(.unicode(run))
                run = []
            }
        }

        for character in text {
            if character == "\n" || character == "\r\n" || character == "\r" {
                flush()
                units.append(.named(.return))
                continue
            }
            if character == "\t" {
                flush()
                units.append(.named(.tab))
                continue
            }
            let utf16 = Array(String(character).utf16)
            // Option-typed characters stay on the Unicode path: holding ⌥ is
            // a shortcut in many apps, which is the opposite of typing.
            if let stroke = layout.stroke(for: character), !stroke.modifiers.contains(.option) {
                flush()
                units.append(.key(stroke, text: utf16))
                continue
            }
            if utf16.count > chunkUnits {
                // A cluster longer than a chunk (rare: long emoji sequences)
                // is sent scalar by scalar rather than cut.
                flush()
                for scalar in String(character).unicodeScalars {
                    let scalarUnits = Array(String(scalar).utf16)
                    if run.count + scalarUnits.count > chunkUnits { flush() }
                    run += scalarUnits
                }
                flush()
                continue
            }
            if run.count + utf16.count > chunkUnits { flush() }
            run += utf16
        }
        flush()
        return TypingPlan(units: units)
    }
}

/// An event sink that keeps what it was given. Tests use it; so does a dry
/// run of the calibration pipeline.
public actor RecordingEventSink: EventSink {
    public private(set) var posted: [(events: [SyntheticEvent], target: EventTarget)] = []

    public init() {}

    public func post(_ events: [SyntheticEvent], to target: EventTarget) async throws {
        posted.append((events, target))
    }

    public var events: [SyntheticEvent] { posted.flatMap(\.events) }

    public func reset() { posted.removeAll() }
}
