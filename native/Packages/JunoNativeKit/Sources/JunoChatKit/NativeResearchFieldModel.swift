import Foundation

/// Deep Field's map, as data — the native port of the web's
/// `deep-field-model.ts`. The run's REAL sources on three orbits:
///
///     outer orbit   found   a search returned it, nothing read it yet
///     middle orbit  read    a researcher opened and read the page
///     inner orbit   cited   the report cites it, with its number
///
/// Distance from the question is how far a source got into the evidence, so a
/// source moving inward is the run making progress, and nothing on the map is
/// decoration: every point is a source the server reported. A source keeps
/// its angle across polls (hashed from its id, never from its list position),
/// so an update never shuffles the map. Positions are fractions of the box.
public struct NativeResearchFieldModel: Equatable, Sendable {
    public enum State: Int, Equatable, Sendable, Comparable {
        case cited = 0, read = 1, found = 2

        public static func < (lhs: State, rhs: State) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    public struct Node: Equatable, Sendable, Identifiable {
        public let id: String
        public let url: URL
        public let host: String
        public let title: String
        public let state: State
        public let ring: Int
        public let degrees: Double
        public let x: Double
        public let y: Double
        /// Drawn with its host beside it.
        public let labelled: Bool
        /// The label sits after the point (true) or before it (false), away
        /// from the centre.
        public let labelTrailing: Bool
        /// Where the label's centre sits vertically, nudged apart from its
        /// neighbours on the same side.
        public var labelY: Double
        public let cited: Int?
        /// The page being read right now.
        public let current: Bool
    }

    /// One source as the map reads it.
    public struct Input: Equatable, Sendable {
        public let id: String
        public let url: URL
        public let title: String
        public let read: Bool
        public let citedIndex: Int?

        public init(id: String, url: URL, title: String, read: Bool, citedIndex: Int? = nil) {
            self.id = id
            self.url = url
            self.title = title
            self.read = read
            self.citedIndex = citedIndex
        }
    }

    /// In discovery order, whatever the orbit, so a promotion never re-inserts
    /// a node (and never replays its arrival).
    public let nodes: [Node]
    /// Found sources not drawn because the map is full.
    public let hidden: Int
    public var current: Node? { nodes.first(where: \.current) }

    /// The three orbits' radii, as fractions of the box's width and height.
    public static let rings: [(rx: Double, ry: Double)] = [0.2, 0.33, 0.46].map { ($0, $0 * 0.94) }

    public init(
        sources: [Input],
        currentHost: String? = nil,
        maxNodes: Int = 30,
        maxLabels: Int = 4
    ) {
        let current = currentHost.map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }
        let indexed = sources.enumerated().map { order, source in
            Entry(source: source, order: order, state: Self.state(of: source))
        }
        let evidence = indexed.filter { $0.state != .found }
        let found = indexed.filter { $0.state == .found }
        let room = max(0, maxNodes - evidence.count)
        let shownFound = room > 0 ? Array(found.suffix(room)) : []
        let shown = (evidence + shownFound).sorted { $0.order < $1.order }

        let currentID = current.flatMap { host in
            shown.last(where: { NativeResearchReport.host($0.source.url) == host })?.source.id
        }
        // Labels: the current source, the cited ones in citation order, then
        // the newest reads.
        var labelled: [String] = []
        if let currentID { labelled.append(currentID) }
        for entry in shown.filter({ $0.state == .cited }).sorted(by: { ($0.source.citedIndex ?? 0) < ($1.source.citedIndex ?? 0) }) {
            if labelled.count >= maxLabels { break }
            if !labelled.contains(entry.source.id) { labelled.append(entry.source.id) }
        }
        for entry in shown.filter({ $0.state == .read }).reversed() {
            if labelled.count >= maxLabels { break }
            if !labelled.contains(entry.source.id) { labelled.append(entry.source.id) }
        }

        var nodes: [Node] = []
        for ring in 0..<3 {
            var members: [Member] = []
            for entry in shown where entry.state.rawValue == ring {
                members.append(Member(entry: entry, base: Double(Self.hash(entry.source.id) % 360)))
            }
            members.sort { lhs, rhs in
                lhs.base < rhs.base || (lhs.base == rhs.base && lhs.entry.source.id < rhs.entry.source.id)
            }
            let angles = Self.spread(members.map { $0.base })
            let radii = Self.rings[ring]
            for (index, member) in members.enumerated() {
                let degrees = angles[index]
                let t = degrees * .pi / 180
                let x = 0.5 + radii.rx * cos(t)
                let y = 0.5 + radii.ry * sin(t)
                let source = member.entry.source
                nodes.append(Node(
                    id: source.id,
                    url: source.url,
                    host: NativeResearchReport.host(source.url),
                    title: source.title,
                    state: member.entry.state,
                    ring: ring,
                    degrees: degrees,
                    x: x,
                    y: y,
                    labelled: labelled.contains(source.id),
                    // Away from the centre, except at the edges, where a
                    // label would run out of the box: there it turns inward.
                    labelTrailing: x > 0.84 ? false : x < 0.16 ? true : x >= 0.5,
                    labelY: y,
                    cited: member.entry.state == State.cited ? source.citedIndex : nil,
                    current: source.id == currentID
                ))
            }
        }
        Self.separate(&nodes)
        let discovery = Dictionary(shown.map { ($0.source.id, $0.order) }, uniquingKeysWith: { first, _ in first })
        self.nodes = nodes.sorted { (discovery[$0.id] ?? 0) < (discovery[$1.id] ?? 0) }
        self.hidden = found.count - shownFound.count
    }

    private struct Entry {
        let source: Input
        let order: Int
        let state: State
    }

    private struct Member {
        let entry: Entry
        let base: Double
    }

    public static func state(of source: Input) -> State {
        if let cited = source.citedIndex, cited > 0 { return .cited }
        return source.read ? .read : .found
    }

    /// FNV-1a: a stable angle per source id.
    static func hash(_ text: String) -> UInt32 {
        var h: UInt32 = 0x811c_9dc5
        for byte in text.utf16 {
            h ^= UInt32(byte)
            h = h &* 0x0100_0193
        }
        return h
    }

    /// Labels on one side keep at least this far apart, as a fraction of the
    /// box's height.
    static let labelGap = 0.1

    static func separate(_ nodes: inout [Node]) {
        for trailing in [false, true] {
            let group = nodes.indices
                .filter { nodes[$0].labelled && nodes[$0].labelTrailing == trailing }
                .sorted { nodes[$0].labelY < nodes[$1].labelY }
            guard group.count > 1 else { continue }
            for k in 1..<group.count where nodes[group[k]].labelY - nodes[group[k - 1]].labelY < labelGap {
                nodes[group[k]].labelY = nodes[group[k - 1]].labelY + labelGap
            }
            // Pushed off the bottom: walk the column back up from the edge.
            for k in stride(from: group.count - 1, through: 0, by: -1) {
                let ceiling = k == group.count - 1 ? 0.95 : nodes[group[k + 1]].labelY - labelGap
                if nodes[group[k]].labelY > ceiling { nodes[group[k]].labelY = ceiling }
            }
        }
    }

    /// Spreads one orbit's points so no two sit closer than it can afford.
    static func spread(_ angles: [Double]) -> [Double] {
        let n = angles.count
        guard n >= 2 else { return angles }
        let gap = min(34, 360 / Double(n))
        var out = angles
        for _ in 0..<3 {
            for i in 1..<n where out[i] - out[i - 1] < gap { out[i] = out[i - 1] + gap }
            let over = out[n - 1] - (out[0] + 360 - gap)
            if over > 0 { for i in 0..<n { out[i] -= over * (Double(i + 1) / Double(n)) } }
        }
        return out.map { (($0.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360) }
    }
}

extension NativeResearchRun {
    /// The `[n]` numbers a text cites, in order of first use.
    public static func citedNumbers(in text: String) -> [Int] {
        var seen: [Int] = []
        var rest = text[...]
        while let open = rest.firstIndex(of: "[") {
            let after = rest[rest.index(after: open)...]
            guard let close = after.firstIndex(of: "]") else { break }
            let inner = after[..<close]
            // `[1]`, and the writer's `[1, 3]` / `[1][3]` alike.
            for piece in inner.split(whereSeparator: { $0 == "," || $0 == " " }) {
                if let number = Int(piece), number > 0, number < 1_000, !seen.contains(number) { seen.append(number) }
            }
            rest = after[after.index(after: close)...]
        }
        return seen
    }

    /// The map's inputs: the run's sources, with the citation number of each
    /// one the report (or the answer being written) cites.
    ///
    /// - Parameters:
    ///   - citations: the numbered list the `[n]` marks count — the answer's
    ///     `sources` on the in-chat path; nil for a run, whose marks count the
    ///     sources it read.
    ///   - text: where to look for `[n]`; the run's report when nil.
    public func fieldInputs(citations: [NativeChatSource]? = nil, text: String? = nil) -> [NativeResearchFieldModel.Input] {
        let cited = Self.citedNumbers(in: text ?? reportBody ?? "")
        var numberByURL: [String: Int] = [:]
        if let citations {
            for number in cited where citations.indices.contains(number - 1) {
                let key = Self.normalized(citations[number - 1].url)
                if numberByURL[key] == nil { numberByURL[key] = number }
            }
        } else {
            let read = sources.filter(\.read)
            for number in cited where read.indices.contains(number - 1) {
                let key = Self.normalized(read[number - 1].url)
                if numberByURL[key] == nil { numberByURL[key] = number }
            }
        }
        return sources.map { source in
            NativeResearchFieldModel.Input(
                id: source.id, url: source.url, title: source.title, read: source.read,
                citedIndex: numberByURL[Self.normalized(source.url)]
            )
        }
    }
}
