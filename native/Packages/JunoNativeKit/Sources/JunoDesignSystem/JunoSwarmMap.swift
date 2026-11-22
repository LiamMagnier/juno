import SwiftUI

// The swarm map: a lead's face in the middle and every agent it started round
// it, each joined to whoever started it. The web twin is `SwarmStage` in
// `src/components/code/v2/agents-tree.tsx`; the layout below is its
// `stageLayout`, number for number, and the faces are seeded the same way
// (``JunoAgentAvatar/seeded(_:)`` is `defaultAgentAvatar` bit for bit), so a
// run looks the same on the Mac, the iPhone and the web.
//
// The links carry the motion. Work flows along a working agent's link, a
// waiting agent's link beats in the "needs you" tint, a finished one settles
// into a quiet line, and a new agent travels out from the lead as it is
// started: the one entrance on the map. Under Reduce Motion the links hold
// still, nothing travels, and the faces show their still frames (the face
// handles its own).
//
// The map is a picture of the list under it: it is hidden from assistive
// technology, and the list carries every agent, its state and its controls
// in words. A pointer can still pick an agent on the map.

/// One agent on the map.
public struct JunoSwarmMember: Identifiable, Hashable, Sendable {
    /// What its link to the agent that started it shows.
    public enum Link: Hashable, Sendable {
        /// Work flows along it.
        case working
        /// It beats in the "needs you" tint.
        case waiting
        /// A quiet solid line.
        case done
        /// A broken line in the danger ink.
        case failed
        /// A dotted line: queued, paused or stopped.
        case quiet
    }

    public var id: String
    public var name: String
    public var avatar: JunoAgentAvatar
    public var state: JunoAgentState
    public var link: Link
    /// The agent that started it, or nil for the lead.
    public var parentID: String?

    public init(id: String, name: String, avatar: JunoAgentAvatar, state: JunoAgentState, link: Link, parentID: String? = nil) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.state = state
        self.link = link
        self.parentID = parentID
    }
}

/// Where each agent sits, in the map's own units (400 × 196), the web's numbers.
public enum JunoSwarmLayout {
    public static let width: CGFloat = 400
    public static let height: CGFloat = 196
    /// More than this and the rest are counted, not drawn.
    public static let maxShown = 10
    static let center = CGPoint(x: width / 2, y: height / 2)
    static let orbit = CGSize(width: 150, height: 70)

    public struct Spot: Equatable, Sendable {
        public var id: String
        public var point: CGPoint
        public var parent: CGPoint
        /// Started by another agent, not by the lead.
        public var nested: Bool
    }

    /// Agents on an ellipse round the lead, the first at the top and on round
    /// clockwise; an agent another agent started sits just outside it, its
    /// siblings side by side.
    public static func spots(_ members: [JunoSwarmMember], max: Int = maxShown) -> (spots: [Spot], more: Int) {
        let shown = Array(members.prefix(max))
        let known = Set(members.map(\.id))
        func clampX(_ x: CGFloat) -> CGFloat { Swift.min(width - 24, Swift.max(24, x)) }
        func clampY(_ y: CGFloat) -> CGFloat { Swift.min(height - 24, Swift.max(24, y)) }
        func parentID(of member: JunoSwarmMember) -> String? {
            guard let id = member.parentID, id != member.id, known.contains(id) else { return nil }
            return id
        }

        var at: [String: CGPoint] = [:]
        var spots: [Spot] = []
        let top = shown.filter { parentID(of: $0) == nil }
        let ring = Swift.max(top.count, 1)
        for (index, member) in top.enumerated() {
            // An even count turns half a step, so no agent sits alone on the lead's sides.
            let turn = ring % 2 == 0 ? CGFloat.pi / CGFloat(ring) : 0
            let angle = -CGFloat.pi / 2 + CGFloat(index) * 2 * CGFloat.pi / CGFloat(ring) + turn
            let point = CGPoint(x: center.x + cos(angle) * orbit.width, y: center.y + sin(angle) * orbit.height)
            at[member.id] = point
            spots.append(Spot(id: member.id, point: point, parent: center, nested: false))
        }

        var siblings: [String: Int] = [:]
        for member in shown {
            guard let parentID = parentID(of: member) else { continue }
            let parent = at[parentID] ?? center
            let dx = parent.x - center.x
            let dy = parent.y - center.y
            let length = Swift.max(hypot(dx, dy), 1)
            let k = siblings[parentID] ?? 0
            siblings[parentID] = k + 1
            let along: CGFloat = 40
            let across = CGFloat(k % 2 == 0 ? 1 : -1) * CGFloat((k + 1) / 2) * 30
            let point = CGPoint(
                x: clampX(parent.x + dx / length * along - dy / length * across),
                y: clampY(parent.y + dy / length * along * 0.6 + dx / length * across * 0.6)
            )
            at[member.id] = point
            spots.append(Spot(id: member.id, point: point, parent: parent, nested: true))
        }
        return (spots, Swift.max(0, members.count - shown.count))
    }
}

/// The map itself. `selectedID` nil selects the lead.
public struct JunoSwarmMap: View {
    private let leadName: String
    private let leadAvatar: JunoAgentAvatar
    private let leadState: JunoAgentState
    private let members: [JunoSwarmMember]
    private let selectedID: String?
    private let needsYouTint: Color
    private let select: (String?) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrived: Set<String> = []

    public init(
        leadName: String = "Lead",
        leadAvatar: JunoAgentAvatar = .seeded("alevr-lead"),
        leadState: JunoAgentState,
        members: [JunoSwarmMember],
        selectedID: String?,
        needsYouTint: Color = .junoAccent,
        select: @escaping (String?) -> Void
    ) {
        self.leadName = leadName
        self.leadAvatar = leadAvatar
        self.leadState = leadState
        self.members = members
        self.selectedID = selectedID
        self.needsYouTint = needsYouTint
        self.select = select
    }

    private var layout: (spots: [JunoSwarmLayout.Spot], more: Int) { JunoSwarmLayout.spots(members) }
    private var moving: Bool {
        !reduceMotion && members.contains { $0.link == .working || $0.link == .waiting }
    }

    public var body: some View {
        let layout = self.layout
        let ids = layout.spots.map(\.id)
        GeometryReader { proxy in
            let sx = proxy.size.width / JunoSwarmLayout.width
            let sy = proxy.size.height / JunoSwarmLayout.height
            let roomy = proxy.size.width >= 440
            ZStack {
                links(layout.spots, sx: sx, sy: sy)
                ForEach(Array(layout.spots.enumerated()), id: \.element.id) { index, spot in
                    if let member = members.first(where: { $0.id == spot.id }) {
                        let home = arrived.contains(spot.id)
                        let at = home ? spot.point : spot.parent
                        face(
                            id: member.id,
                            name: member.name,
                            avatar: member.avatar,
                            state: member.state,
                            size: spot.nested ? 26 : 36,
                            showsName: (roomy && !spot.nested) || selectedID == member.id,
                            isWaiting: member.link == .waiting
                        )
                        .position(x: at.x * sx, y: at.y * sy)
                        // A short stagger, so the lead is seen handing work out rather than everyone appearing at once.
                        .animation(
                            JunoMotion.reduced(JunoMotion.outExpo(JunoMotion.Duration.emphasis).delay(Double(Swift.min(index, 8)) * 0.045), when: reduceMotion),
                            value: home
                        )
                    }
                }
                face(id: nil, name: leadName, avatar: leadAvatar, state: leadState, size: 52, showsName: true, isWaiting: false)
                    .position(x: JunoSwarmLayout.center.x * sx, y: JunoSwarmLayout.center.y * sy)
                if layout.more > 0 {
                    Text("+\(layout.more) more below")
                        .junoCaption()
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(JunoSpace.snug)
                }
            }
        }
        .frame(height: JunoSwarmLayout.height)
        .background(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).fill(Color.junoMuted.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1))
        .onAppear { arrive(ids) }
        .onChange(of: ids) { _, next in arrive(next) }
        .accessibilityHidden(true)
    }

    /// Every agent on the map arrives once: all of them when the map appears,
    /// then each new one as the lead starts it. Under Reduce Motion they are
    /// simply there.
    private func arrive(_ ids: [String]) {
        let fresh = Set(ids).subtracting(arrived)
        guard !fresh.isEmpty else { return }
        if reduceMotion {
            arrived.formUnion(fresh)
            return
        }
        // After this frame, so each face is first drawn at the lead and then travels.
        Task { @MainActor in arrived.formUnion(fresh) }
    }

    private func links(_ spots: [JunoSwarmLayout.Spot], sx: CGFloat, sy: CGFloat) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !moving)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, _ in
                let orbitRect = CGRect(
                    x: (JunoSwarmLayout.center.x - JunoSwarmLayout.orbit.width) * sx,
                    y: (JunoSwarmLayout.center.y - JunoSwarmLayout.orbit.height) * sy,
                    width: JunoSwarmLayout.orbit.width * 2 * sx,
                    height: JunoSwarmLayout.orbit.height * 2 * sy
                )
                context.stroke(Path(ellipseIn: orbitRect), with: .color(Color.junoBorder), style: StrokeStyle(lineWidth: 1, dash: [2, 6]))
                // Work flows out from the lead: the dashes march one pattern length per beat.
                let flow = reduceMotion ? 0 : -CGFloat((time / JunoMotion.Loop.run).truncatingRemainder(dividingBy: 1)) * 10
                // A waiting link breathes between 40% and full.
                let breath = reduceMotion ? 1 : 0.4 + 0.6 * (0.5 - 0.5 * cos(2 * Double.pi * time / JunoMotion.Loop.skeletonBreathe))
                for spot in spots where arrived.contains(spot.id) {
                    guard let member = members.first(where: { $0.id == spot.id }) else { continue }
                    var path = Path()
                    path.move(to: CGPoint(x: spot.parent.x * sx, y: spot.parent.y * sy))
                    path.addLine(to: CGPoint(x: spot.point.x * sx, y: spot.point.y * sy))
                    switch member.link {
                    case .working:
                        context.stroke(path, with: .color(Color.junoPresence.opacity(0.7)), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [3, 7], dashPhase: flow))
                    case .waiting:
                        context.stroke(path, with: .color(needsYouTint.opacity(breath)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    case .done:
                        context.stroke(path, with: .color(Color.junoForeground.opacity(0.3)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    case .failed:
                        context.stroke(path, with: .color(Color.junoDestructive.opacity(0.7)), style: StrokeStyle(lineWidth: 1.5, dash: [2, 4]))
                    case .quiet:
                        context.stroke(path, with: .color(Color.junoBorder), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [1, 5]))
                    }
                }
            }
        }
    }

    private func face(id: String?, name: String, avatar: JunoAgentAvatar, state: JunoAgentState, size: CGFloat, showsName: Bool, isWaiting: Bool) -> some View {
        let isSelected = selectedID == id
        return Button { select(id) } label: {
            JunoAgentFace(avatar: avatar, state: state, size: size, live: !reduceMotion)
                .background {
                    if isSelected {
                        Circle().strokeBorder(Color.junoRing, lineWidth: 2).padding(-JunoSpace.tight)
                    }
                }
                .overlay(alignment: .top) {
                    if showsName {
                        Text(name)
                            .junoCaption()
                            .foregroundStyle(isWaiting ? needsYouTint : (isSelected ? Color.junoForeground : Color.junoSecondaryInk))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(width: 136)
                            .offset(y: size + JunoSpace.micro)
                    }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }
}
