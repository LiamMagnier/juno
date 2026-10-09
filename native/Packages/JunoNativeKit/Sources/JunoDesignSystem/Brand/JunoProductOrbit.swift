import SwiftUI

/// The two products, in the order the web's `PRODUCTS` lists them (talk, then build).
public enum JunoProduct: String, CaseIterable, Sendable, Identifiable {
    case chat
    case code

    public var id: String { rawValue }

    /// The visible name (the web's `BRAND.chat.label` / `BRAND.code.label`).
    public var label: String {
        switch self {
        case .chat: "Chat"
        case .code: "Code"
        }
    }
}

/// The product switch's geometry, ported verbatim from
/// `src/components/app/product-switch.tsx` so the toolbar on the Mac and the
/// phone draws the same orbit, the same arcs, as the web sidebar.
public enum JunoProductOrbitGeometry {
    /// One flattened orbit; the box is larger than the ring so the bloom is never cut square.
    public static let ring = [JunoDotRing(cx: 0.5, cy: 0.5, rx: 0.34, ry: 0.17)]
    /// Short trails, like the hero's trajectory: the last stretch of the way in.
    /// Round the FRONT going to Code, round the BACK coming home.
    public static let trailToCode = [JunoDotArc(ring: 0, from: 125, to: 0)]
    public static let trailToChat = [JunoDotArc(ring: 0, from: -55, to: -180)]
    /// At rest the arc stays, so the row always says where you are.
    public static let restChat = [JunoDotArc(ring: 0, from: 110, to: 180)]
    public static let restCode = [JunoDotArc(ring: 0, from: 70, to: 0)]
    /// `.product-orbit { --dots-pitch: 2.4px }`.
    public static let pitch: CGFloat = 2.4
    /// The orbit box (`h-12 w-[84px]`, pulled in by `-mx-1.5 -my-2`).
    public static let size = CGSize(width: 84, height: 48)
    /// The trail's draw time.
    public static let draw = 0.62

    /// The arcs to draw: the resting arc before any switch, the trail after.
    public static func arcs(for product: JunoProduct, turn: Int) -> [JunoDotArc] {
        if turn == 0 { return product == .code ? restCode : restChat }
        return product == .code ? trailToCode : trailToChat
    }
}

/// The orbit between the two names. The ring holds still; over it the
/// trajectory layer is remounted on each change of product (its clock
/// restarts) with its own ring drawn at zero ink, so only the presence arc and
/// its bloom show — exactly the web's two stacked `DotRings`.
public struct JunoProductOrbitTrack: View {
    let active: JunoProduct

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turn = 0
    @State private var seen: JunoProduct?

    public init(active: JunoProduct) {
        self.active = active
    }

    public var body: some View {
        let base = JunoDotStyle.standard(for: scheme)
        let G = JunoProductOrbitGeometry.self
        ZStack {
            JunoDotRings(rings: G.ring, animate: false, pitch: G.pitch)
            JunoDotRings(
                rings: G.ring,
                arcs: G.arcs(for: active, turn: turn),
                animate: !reduceMotion && turn > 0,
                stagger: 0, draw: G.draw, delay: 0,
                pitch: G.pitch,
                style: base.strength(0)
            )
            .id(turn)
        }
        .frame(width: G.size.width, height: G.size.height)
        .onAppear { if seen == nil { seen = active } }
        .onChange(of: active) { _, next in
            guard seen != next else { return }
            seen = next
            turn += 1
        }
        .accessibilityHidden(true)
    }
}

/// THE PRODUCT SWITCH, native: Chat and Code named in the greeting's serif
/// at the two ends of one dot-matrix orbit; the presence trail runs round
/// the orbit to the product you are in and blooms there.
///
/// Ready to drop into a toolbar or a sidebar header (docs/native/BRAND_MOTIFS.md).
/// It owns no navigation: `onSelect` is the caller's. A product the plan does
/// not include is shown, never hidden — greyed with a lock — and still calls
/// `onSelect` so the caller can route to the upgrade sheet.
public struct JunoProductOrbit: View {
    let active: JunoProduct
    let locked: Set<JunoProduct>
    let onSelect: (JunoProduct) -> Void

    public init(active: JunoProduct, locked: Set<JunoProduct> = [], onSelect: @escaping (JunoProduct) -> Void) {
        self.active = active
        self.locked = locked
        self.onSelect = onSelect
    }

    public var body: some View {
        HStack(spacing: 2) {
            end(.chat)
            JunoProductOrbitTrack(active: active)
                // `-mx-1.5 -my-2`: the orbit's box is bigger than the row so the bloom is never clipped.
                .padding(.horizontal, -6)
                .padding(.vertical, -8)
            end(.code)
        }
        .frame(height: 32)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Products")
    }

    private func end(_ product: JunoProduct) -> some View {
        let isActive = product == active
        let isLocked = locked.contains(product)
        return Button {
            onSelect(product)
        } label: {
            HStack(spacing: 4) {
                if isLocked {
                    JunoIconView(.lock, size: 14)
                }
                Text(product.label)
                    .font(JunoSerif.font(size: 15.5, relativeTo: .body))
                    .tracking(-0.155)
            }
            .foregroundStyle(isActive && !isLocked ? Color.junoForeground : Color.junoTertiaryInk)
            .padding(.horizontal, 6)
            .frame(minWidth: 44, minHeight: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .animation(JunoMotion.fast, value: isActive)
        .accessibilityLabel(isLocked ? "\(product.label), upgrade required" : product.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

#Preview("Product orbit") {
    @Previewable @State var product = JunoProduct.chat
    VStack(spacing: 24) {
        JunoProductOrbit(active: product) { product = $0 }
        JunoProductOrbit(active: .chat, locked: [.code]) { _ in }
    }
    .padding(40)
}
