import Foundation

// The provider-agnostic computer vocabulary (Alevr Code v2 SPEC §3.12).
//
// Anthropic's toolset and OpenAI's function form speak the 17 toolset
// actions with `[x, y]` tuples. Every other model — Gemini, Grok, DeepSeek,
// Qwen, Mistral, and every subscription agent reaching the Mac through the
// Alevr MCP server — gets one flat `computer_use` call instead: plain `x`/`y`
// numbers, accessibility targeting (`ax_find` / `ax_press`) and menus, which a
// model with no verified coordinate convention can use without guessing
// pixels. This file turns one such call into what the service runs. It knows
// nothing of the contract types (JunoCodeCore mirrors them); the action names
// are the contract's COMPUTER_ACTION_VALUES.

public extension ImageBudget {
    /// What every route can take: 1366×768 fits Anthropic's standard limit,
    /// OpenAI's `high` box (short side 768) and Gemini's tiling without a
    /// server-side resize, so the model's coordinates stay in Alevr's frame.
    static let portable = ImageBudget(maxLongEdge: 1_366, maxShortEdge: 768, maxPixels: 1_049_088)

    /// The same frame for models that answer in 0…999 on each axis (Gemini,
    /// Qwen-VL). The frame header says so.
    static let portableNormalized = ImageBudget(
        maxLongEdge: 1_366, maxShortEdge: 768, maxPixels: 1_049_088, coordinates: .normalized1000
    )
}

/// One `computer_use` call, as decoded from the model's JSON.
public struct PortableComputerCall: Hashable, Sendable, Codable {
    public var action: String
    public var app: String?
    public var x: Double?
    public var y: Double?
    public var toX: Double?
    public var toY: Double?
    public var element: String?
    public var query: String?
    public var text: String?
    public var direction: String?
    public var amount: Int?
    public var seconds: Double?
    public var region: [Double]?
    public var path: [String]?
    /// The convention `x`/`y`/`region` are written in, when the call says.
    public var coordinateSpace: CoordinateConvention?

    enum CodingKeys: String, CodingKey {
        case action, app, x, y, element, query, text, direction, amount, seconds, region, path
        case toX = "to_x"
        case toY = "to_y"
        case coordinateSpace = "coordinate_space"
    }

    public init(
        action: String,
        app: String? = nil,
        x: Double? = nil,
        y: Double? = nil,
        toX: Double? = nil,
        toY: Double? = nil,
        element: String? = nil,
        query: String? = nil,
        text: String? = nil,
        direction: String? = nil,
        amount: Int? = nil,
        seconds: Double? = nil,
        region: [Double]? = nil,
        path: [String]? = nil,
        coordinateSpace: CoordinateConvention? = nil
    ) {
        self.action = action
        self.app = app
        self.x = x
        self.y = y
        self.toX = toX
        self.toY = toY
        self.element = element
        self.query = query
        self.text = text
        self.direction = direction
        self.amount = amount
        self.seconds = seconds
        self.region = region
        self.path = path
        self.coordinateSpace = coordinateSpace
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = try c.decode(String.self, forKey: .action)
        app = try c.decodeIfPresent(String.self, forKey: .app)
        x = Self.lenientNumber(c, .x)
        y = Self.lenientNumber(c, .y)
        toX = Self.lenientNumber(c, .toX)
        toY = Self.lenientNumber(c, .toY)
        element = try? c.decodeIfPresent(String.self, forKey: .element)
        query = try? c.decodeIfPresent(String.self, forKey: .query)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        direction = try? c.decodeIfPresent(String.self, forKey: .direction)
        amount = Self.lenientNumber(c, .amount).map { Int($0) }
        seconds = Self.lenientNumber(c, .seconds)
        region = try? c.decodeIfPresent([Double].self, forKey: .region)
        path = try? c.decodeIfPresent([String].self, forKey: .path)
        if let raw = try? c.decodeIfPresent(String.self, forKey: .coordinateSpace) {
            coordinateSpace = PortableCoordinates.convention(wireName: raw)
        }
    }

    /// Several vendors send numbers as strings ("512").
    private static func lenientNumber(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Double? {
        if let number = try? c.decodeIfPresent(Double.self, forKey: key) { return number }
        if let string = try? c.decodeIfPresent(String.self, forKey: key) { return Double(string) }
        return nil
    }
}

/// Moving a model's coordinates between conventions.
public enum PortableCoordinates {
    /// `pixels` / `normalized_1000` on the wire.
    public static func convention(wireName: String) -> CoordinateConvention? {
        switch wireName {
        case "pixels": .pixels
        case "normalized_1000", "normalized1000": .normalized1000
        default: nil
        }
    }

    public static func wireName(_ convention: CoordinateConvention) -> String {
        switch convention {
        case .pixels: "pixels"
        case .normalized1000: "normalized_1000"
        }
    }

    /// Rewrites one value written in `from` into `to`, along an axis `extent`
    /// frame pixels long. Nil when it needs the frame and there is none yet.
    public static func convert(_ value: Double, along extent: Int?, from: CoordinateConvention, to: CoordinateConvention) -> Double? {
        guard from != to else { return value }
        guard let extent, extent > 0 else { return nil }
        switch (from, to) {
        case (.normalized1000, .pixels):
            return value / 1_000 * Double(extent)
        case (.pixels, .normalized1000):
            return value / Double(extent) * 1_000
        default:
            return value
        }
    }

    /// A point, both axes.
    public static func convert(x: Double, y: Double, frame: PixelSize?, from: CoordinateConvention, to: CoordinateConvention) -> [Double]? {
        guard let cx = convert(x, along: frame?.width, from: from, to: to),
              let cy = convert(y, along: frame?.height, from: from, to: to)
        else { return nil }
        return [cx, cy]
    }
}

/// What a `computer_use` call turns into.
public enum PortableComputerPlan: Hashable, Sendable {
    /// One of the toolset actions the service prepares and performs.
    case screen(ScreenAction)
    case openApp(String)
    /// List (or filter) the front window's controls.
    case axFind(app: String?, query: String?)
    /// Press a control by id, or the one control matching `query`.
    case axPress(app: String?, element: String?, query: String?)
    case menu(app: String?, path: [String])
}

public struct PortableComputerError: Error, LocalizedError, Hashable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum PortableComputerVocabulary {
    /// The contract's COMPUTER_ACTION_VALUES, in order.
    public static let actions = [
        "screenshot", "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "wait",
        "open_app", "zoom", "ax_find", "ax_press", "menu",
    ]

    /// The toolset action a portable action runs as, where it is one.
    public static func screenKind(for action: String) -> ScreenActionKind? {
        switch action {
        case "screenshot": .screenshot
        case "click": .leftClick
        case "double_click": .doubleClick
        case "right_click": .rightClick
        case "move": .mouseMove
        case "drag": .leftClickDrag
        case "scroll": .scroll
        case "type": .type
        case "key": .key
        case "wait": .wait
        case "zoom": .zoom
        default: nil
        }
    }

    /// Turns a call into a plan, with its coordinates rewritten into the
    /// frame's convention when the call wrote them in another one.
    ///
    /// - Parameters:
    ///   - frameConvention: the convention of the route's image budget, which
    ///     the service's frames are captured in.
    ///   - frameSize: the latest frame's size, for converting between
    ///     conventions.
    public static func plan(
        _ call: PortableComputerCall,
        frameConvention: CoordinateConvention,
        frameSize: PixelSize?
    ) throws -> PortableComputerPlan {
        let from = call.coordinateSpace ?? frameConvention
        func point(_ x: Double?, _ y: Double?, _ name: String) throws -> [Double]? {
            guard let x, let y else {
                if x != nil || y != nil { throw PortableComputerError("Give both \(name == "end" ? "to_x and to_y" : "x and y").") }
                return nil
            }
            guard x.isFinite, y.isFinite, x >= 0, y >= 0 else {
                throw PortableComputerError("Coordinates must be numbers of zero or more.")
            }
            if from == .normalized1000, x > 1_000 || y > 1_000 {
                throw PortableComputerError("Coordinates in normalized_1000 are 0-999 on each axis.")
            }
            guard let converted = PortableCoordinates.convert(x: x, y: y, frame: frameSize, from: from, to: frameConvention) else {
                throw PortableComputerError("Take a screenshot first, so there is a frame for those coordinates.")
            }
            return converted
        }
        if let element = call.element, element.range(of: #"^e[0-9]{1,4}$"#, options: .regularExpression) == nil {
            throw PortableComputerError("element must be an id from ax_find, like e12.")
        }

        switch call.action {
        case "open_app":
            guard let app = call.app?.trimmingCharacters(in: .whitespaces), !app.isEmpty else {
                throw PortableComputerError("open_app needs app: a bundle id or app name.")
            }
            return .openApp(app)
        case "ax_find":
            return .axFind(app: call.app, query: call.query?.trimmingCharacters(in: .whitespaces).nilIfEmpty)
        case "ax_press":
            let query = call.query?.trimmingCharacters(in: .whitespaces).nilIfEmpty
            guard call.element != nil || query != nil else {
                throw PortableComputerError("ax_press needs element (from ax_find) or query.")
            }
            return .axPress(app: call.app, element: call.element, query: query)
        case "menu":
            let path = (call.path ?? []).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard !path.isEmpty, path.count <= 6 else {
                throw PortableComputerError("menu needs path: titles from the menu bar down, like [\"File\", \"Export…\"].")
            }
            return .menu(app: call.app, path: path)
        default:
            break
        }

        guard let kind = screenKind(for: call.action) else {
            throw PortableComputerError("action must be one of: \(actions.joined(separator: ", ")).")
        }
        var action = ScreenAction(kind: kind, app: call.app)
        switch call.action {
        case "click", "double_click", "right_click", "move":
            action.coordinate = try point(call.x, call.y, "start")
            action.element = call.element
            if action.coordinate == nil, action.element == nil {
                throw PortableComputerError("\(call.action) needs x and y, or an element from ax_find.")
            }
        case "drag":
            guard let start = try point(call.x, call.y, "start"), let end = try point(call.toX, call.toY, "end") else {
                throw PortableComputerError("drag needs x, y, to_x and to_y.")
            }
            action.startCoordinate = start
            action.coordinate = end
        case "scroll":
            guard let raw = call.direction, let direction = ScreenAction.ScrollDirection(rawValue: raw) else {
                throw PortableComputerError("scroll needs direction: up, down, left or right.")
            }
            action.scrollDirection = direction
            let amount = call.amount ?? 3
            guard (1...30).contains(amount) else { throw PortableComputerError("amount must be a whole number from 1 to 30.") }
            action.scrollAmount = amount
            action.element = call.element
            action.coordinate = try point(call.x, call.y, "start")
            if action.coordinate == nil, action.element == nil {
                // The middle of the frame: where a person would put the wheel.
                guard let frameSize else {
                    throw PortableComputerError("Take a screenshot first, or give x and y for the scroll.")
                }
                let middle = [Double(frameSize.width) / 2, Double(frameSize.height) / 2]
                action.coordinate = frameConvention == .normalized1000 ? [500, 500] : middle
            }
        case "type":
            guard let text = call.text, !text.isEmpty else { throw PortableComputerError("type needs text.") }
            action.text = text
        case "key":
            guard let text = call.text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else {
                throw PortableComputerError("key needs text: a key or chord like return or cmd+s.")
            }
            action.text = text
        case "wait":
            let seconds = call.seconds ?? 1
            guard seconds >= 0, seconds <= ScreenAction.maximumDurationSeconds else {
                throw PortableComputerError("seconds must be 0 to 30.")
            }
            action.duration = seconds
        case "zoom":
            guard let region = call.region, region.count == 4, region.allSatisfy({ $0.isFinite && $0 >= 0 }),
                  region[2] > region[0], region[3] > region[1]
            else {
                throw PortableComputerError("zoom needs region: [x0, y0, x1, y1] with x1 > x0 and y1 > y0.")
            }
            guard let topLeft = try point(region[0], region[1], "start"), let bottomRight = try point(region[2], region[3], "start") else {
                throw PortableComputerError("zoom needs region: [x0, y0, x1, y1].")
            }
            action.region = topLeft + bottomRight
        default:
            break
        }
        return .screen(action)
    }

    /// The element ids a `computer_ax`-style listing names, with each line,
    /// in order: `[e12] button "Export…" (…) enabled`.
    public static func listedElements(in listing: String) -> [(id: String, line: String, enabled: Bool)] {
        listing.split(separator: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("[e"), let close = line.firstIndex(of: "]") else { return nil }
            let id = String(line[line.index(after: line.startIndex)..<close])
            guard id.range(of: #"^e[0-9]{1,4}$"#, options: .regularExpression) != nil else { return nil }
            return (id, line, !line.contains(" disabled"))
        }
    }

    /// The one control a press by `query` means: the only enabled match, or
    /// the only one whose quoted title is exactly the query. Nil when there
    /// are none or several (the caller lists them).
    public static func uniqueMatch(for query: String, in listing: String) -> String? {
        let enabled = listedElements(in: listing).filter(\.enabled)
        if enabled.count == 1 { return enabled[0].id }
        let exact = enabled.filter { $0.line.localizedCaseInsensitiveContains("\"\(query)\"") }
        return exact.count == 1 ? exact[0].id : nil
    }
}

fileprivate extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
