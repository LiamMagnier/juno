import Foundation

/// The Juno Design scene model, in Swift.
///
/// This is the *same* document the website edits, decoded natively so the Mac
/// can validate it, migrate it, hand it to the editor, and store it — without a
/// second scene graph or a second editor engine. The editing engine itself is
/// shared: a locally bundled trusted web editor runs inside a WKWebView and
/// speaks to this type across ``DesignBridge``. What lives here is the contract,
/// not a reimplementation of it.
///
/// The generated JSON Schema at `contracts/design/design-document.v1.schema.json`
/// is the referee. `DesignRoundTripTests` decodes a real document, re-encodes
/// it, and asserts the JSON is unchanged — which is what makes "the same file
/// opens on both" a checked property rather than an intention.
///
/// Unknown *forward* fields are deliberately NOT preserved: the schema version
/// is checked first, and a document from a newer build is refused with a stated
/// reason rather than silently round-tripped with fields this build cannot see.

public enum DesignSchema {
    /// The schema version this build reads and writes.
    public static let version = 1
}

// MARK: - Primitives

public struct Rgba: Codable, Hashable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double
    public var a: Double

    public init(r: Double, g: Double, b: Double, a: Double) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }
}

public struct DesignPoint: Codable, Hashable, Sendable {
    public var x: Double
    public var y: Double
}

public struct GradientStop: Codable, Hashable, Sendable {
    public var position: Double
    public var color: Rgba
}

/// A fill or stroke paint. Tagged by `type` on the wire, exactly as the zod
/// discriminated union writes it.
public enum Paint: Codable, Hashable, Sendable {
    case solid(color: Rgba, opacity: Double?, visible: Bool?, boundVariable: String?)
    case linearGradient(stops: [GradientStop], from: DesignPoint, to: DesignPoint, opacity: Double?, visible: Bool?)
    case radialGradient(stops: [GradientStop], center: DesignPoint, radius: Double, opacity: Double?, visible: Bool?)
    case image(assetId: String, scaleMode: ScaleMode, opacity: Double?, visible: Bool?)

    private enum CodingKeys: String, CodingKey {
        case type, color, opacity, visible, boundVariable, stops, from, to, center, radius, assetId, scaleMode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let opacity = try container.decodeIfPresent(Double.self, forKey: .opacity)
        let visible = try container.decodeIfPresent(Bool.self, forKey: .visible)
        switch try container.decode(String.self, forKey: .type) {
        case "solid":
            self = .solid(
                color: try container.decode(Rgba.self, forKey: .color),
                opacity: opacity,
                visible: visible,
                boundVariable: try container.decodeIfPresent(String.self, forKey: .boundVariable)
            )
        case "linear-gradient":
            self = .linearGradient(
                stops: try container.decode([GradientStop].self, forKey: .stops),
                from: try container.decode(DesignPoint.self, forKey: .from),
                to: try container.decode(DesignPoint.self, forKey: .to),
                opacity: opacity,
                visible: visible
            )
        case "radial-gradient":
            self = .radialGradient(
                stops: try container.decode([GradientStop].self, forKey: .stops),
                center: try container.decode(DesignPoint.self, forKey: .center),
                radius: try container.decode(Double.self, forKey: .radius),
                opacity: opacity,
                visible: visible
            )
        case "image":
            self = .image(
                assetId: try container.decode(String.self, forKey: .assetId),
                scaleMode: try container.decode(ScaleMode.self, forKey: .scaleMode),
                opacity: opacity,
                visible: visible
            )
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown paint type “\(other)”"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .solid(let color, let opacity, let visible, let boundVariable):
            try container.encode("solid", forKey: .type)
            try container.encode(color, forKey: .color)
            try container.encodeIfPresent(opacity, forKey: .opacity)
            try container.encodeIfPresent(visible, forKey: .visible)
            try container.encodeIfPresent(boundVariable, forKey: .boundVariable)
        case .linearGradient(let stops, let from, let to, let opacity, let visible):
            try container.encode("linear-gradient", forKey: .type)
            try container.encode(stops, forKey: .stops)
            try container.encode(from, forKey: .from)
            try container.encode(to, forKey: .to)
            try container.encodeIfPresent(opacity, forKey: .opacity)
            try container.encodeIfPresent(visible, forKey: .visible)
        case .radialGradient(let stops, let center, let radius, let opacity, let visible):
            try container.encode("radial-gradient", forKey: .type)
            try container.encode(stops, forKey: .stops)
            try container.encode(center, forKey: .center)
            try container.encode(radius, forKey: .radius)
            try container.encodeIfPresent(opacity, forKey: .opacity)
            try container.encodeIfPresent(visible, forKey: .visible)
        case .image(let assetId, let scaleMode, let opacity, let visible):
            try container.encode("image", forKey: .type)
            try container.encode(assetId, forKey: .assetId)
            try container.encode(scaleMode, forKey: .scaleMode)
            try container.encodeIfPresent(opacity, forKey: .opacity)
            try container.encodeIfPresent(visible, forKey: .visible)
        }
    }
}

public enum ScaleMode: String, Codable, Hashable, Sendable {
    case fill, fit, stretch, tile
}

public struct Stroke: Codable, Hashable, Sendable {
    public var paint: Paint
    public var weight: Double
    public var align: StrokeAlign
    public var dash: [Double]?
}

public enum StrokeAlign: String, Codable, Hashable, Sendable {
    case inside, center, outside
}

public struct Shadow: Codable, Hashable, Sendable {
    public var type: ShadowKind
    public var color: Rgba
    public var offsetX: Double
    public var offsetY: Double
    public var blur: Double
    public var spread: Double
    public var visible: Bool?
}

public enum ShadowKind: String, Codable, Hashable, Sendable {
    case drop, inner
}

public struct Blur: Codable, Hashable, Sendable {
    public var type: BlurKind
    public var radius: Double
}

public enum BlurKind: String, Codable, Hashable, Sendable {
    case layer, background
}

public enum BlendMode: String, Codable, Hashable, Sendable {
    case normal, multiply, screen, overlay, darken, lighten
    case colorDodge = "color-dodge"
    case colorBurn = "color-burn"
    case hardLight = "hard-light"
    case softLight = "soft-light"
    case difference, exclusion
}

/// One radius, or four starting top-left and going clockwise.
public enum CornerRadius: Codable, Hashable, Sendable {
    case uniform(Double)
    case corners(Double, Double, Double, Double)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Double.self) {
            self = .uniform(value)
            return
        }
        let values = try container.decode([Double].self)
        guard values.count == 4 else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "cornerRadius must be a number or four numbers"
            )
        }
        self = .corners(values[0], values[1], values[2], values[3])
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .uniform(let value): try container.encode(value)
        case .corners(let a, let b, let c, let d): try container.encode([a, b, c, d])
        }
    }
}

public enum LineHeight: Codable, Hashable, Sendable {
    case points(Double)
    case percent(Double)

    private enum CodingKeys: String, CodingKey { case unit, value }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let value = try? single.decode(Double.self) {
            self = .points(value)
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self = .percent(try container.decode(Double.self, forKey: .value))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .points(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .percent(let value):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode("percent", forKey: .unit)
            try container.encode(value, forKey: .value)
        }
    }
}

public struct Typography: Codable, Hashable, Sendable {
    public var fontFamily: String
    public var fontSize: Double
    public var fontWeight: Double
    public var lineHeight: LineHeight
    public var letterSpacing: Double
    public var textAlign: TextAlign
    public var verticalAlign: VerticalAlign
    public var textCase: TextCase?
    public var textDecoration: TextDecoration?
    public var italic: Bool?
}

public enum TextAlign: String, Codable, Hashable, Sendable { case left, center, right, justify }
public enum VerticalAlign: String, Codable, Hashable, Sendable { case top, middle, bottom }
public enum TextCase: String, Codable, Hashable, Sendable { case none, upper, lower, title }
public enum TextDecoration: String, Codable, Hashable, Sendable { case none, underline, strikethrough }

// MARK: - Layout

public enum ConstraintBehavior: String, Codable, Hashable, Sendable {
    case min, max, center, stretch, scale
}

public struct Constraints: Codable, Hashable, Sendable {
    public var horizontal: ConstraintBehavior
    public var vertical: ConstraintBehavior
}

public enum SizingMode: String, Codable, Hashable, Sendable { case fixed, hug, fill }

public struct Padding: Codable, Hashable, Sendable {
    public var top: Double
    public var right: Double
    public var bottom: Double
    public var left: Double
}

public enum LayoutDirection: String, Codable, Hashable, Sendable { case horizontal, vertical, grid }
public enum LayoutAlign: String, Codable, Hashable, Sendable { case start, center, end, baseline }
public enum LayoutJustify: String, Codable, Hashable, Sendable {
    case start, center, end
    case spaceBetween = "space-between"
    case spaceAround = "space-around"
    case spaceEvenly = "space-evenly"
}

public struct AutoLayout: Codable, Hashable, Sendable {
    public var direction: LayoutDirection
    public var padding: Padding
    public var gap: Double
    public var crossGap: Double?
    public var align: LayoutAlign
    public var justify: LayoutJustify
    public var wrap: Bool
    public var columns: Int?
}

public enum LayoutSelfAlign: String, Codable, Hashable, Sendable {
    case start, center, end, baseline, stretch
}

public struct LayoutChild: Codable, Hashable, Sendable {
    public var grow: Bool
    public var alignSelf: LayoutSelfAlign?
    public var absolute: Bool
}

public struct SizeLimits: Codable, Hashable, Sendable {
    public var minWidth: Double?
    public var maxWidth: Double?
    public var minHeight: Double?
    public var maxHeight: Double?
}

// MARK: - Nodes

public enum NodeType: String, Codable, Hashable, Sendable {
    case frame, group, rectangle, ellipse, line, path, text, image, component, instance

    /// Whether this type carries `children`, `clipsContent` and `layout`.
    public var isContainer: Bool {
        switch self {
        case .frame, .group, .component, .instance: true
        default: false
        }
    }
}

/// One node.
///
/// Modelled as a single struct with per-type optionals rather than a Swift enum
/// of ten cases, because every consumer here treats a node uniformly (validate
/// it, hand it to the bridge, count it) and an enum would make every one of
/// those a ten-way switch. The Codable conformance is hand-written so encoding
/// emits exactly the fields the node's type has — a rectangle never gains a
/// `characters: null`, which would fail the website's schema on the way back.
public struct DesignNode: Codable, Hashable, Sendable {
    public var id: String
    public var type: NodeType
    public var name: String
    public var parentId: String?
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var rotation: Double
    public var opacity: Double
    public var visible: Bool
    public var locked: Bool
    public var blendMode: BlendMode
    public var fills: [Paint]
    public var strokes: [Stroke]
    public var cornerRadius: CornerRadius
    public var shadows: [Shadow]
    public var blur: Blur?
    public var constraints: Constraints
    public var widthMode: SizingMode
    public var heightMode: SizingMode
    public var limits: SizeLimits
    public var layoutChild: LayoutChild
    public var boundVariables: [String: String]

    // Container-only.
    public var children: [String]?
    public var clipsContent: Bool?
    public var layout: AutoLayout?

    // Component / instance.
    public var componentId: String?
    public var variantProperties: [String: String]?
    public var overrides: [String: [String: DesignJSONValue]]?

    // Path.
    public var d: String?
    public var windingRule: WindingRule?

    // Text.
    public var characters: String?
    public var typography: Typography?

    // Image.
    public var assetId: String?
    public var scaleMode: ScaleMode?

    private enum CodingKeys: String, CodingKey {
        case id, type, name, parentId, x, y, width, height, rotation, opacity, visible, locked
        case blendMode, fills, strokes, cornerRadius, shadows, blur, constraints
        case widthMode, heightMode, limits, layoutChild, boundVariables
        case children, clipsContent, layout
        case componentId, variantProperties, overrides
        case d, windingRule
        case characters, typography
        case assetId, scaleMode
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(NodeType.self, forKey: .type)
        name = try c.decode(String.self, forKey: .name)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        x = try c.decode(Double.self, forKey: .x)
        y = try c.decode(Double.self, forKey: .y)
        width = try c.decode(Double.self, forKey: .width)
        height = try c.decode(Double.self, forKey: .height)
        rotation = try c.decode(Double.self, forKey: .rotation)
        opacity = try c.decode(Double.self, forKey: .opacity)
        visible = try c.decode(Bool.self, forKey: .visible)
        locked = try c.decode(Bool.self, forKey: .locked)
        blendMode = try c.decode(BlendMode.self, forKey: .blendMode)
        fills = try c.decode([Paint].self, forKey: .fills)
        strokes = try c.decode([Stroke].self, forKey: .strokes)
        cornerRadius = try c.decode(CornerRadius.self, forKey: .cornerRadius)
        shadows = try c.decode([Shadow].self, forKey: .shadows)
        blur = try c.decodeIfPresent(Blur.self, forKey: .blur)
        constraints = try c.decode(Constraints.self, forKey: .constraints)
        widthMode = try c.decode(SizingMode.self, forKey: .widthMode)
        heightMode = try c.decode(SizingMode.self, forKey: .heightMode)
        limits = try c.decode(SizeLimits.self, forKey: .limits)
        layoutChild = try c.decode(LayoutChild.self, forKey: .layoutChild)
        boundVariables = try c.decode([String: String].self, forKey: .boundVariables)

        children = try c.decodeIfPresent([String].self, forKey: .children)
        clipsContent = try c.decodeIfPresent(Bool.self, forKey: .clipsContent)
        layout = try c.decodeIfPresent(AutoLayout.self, forKey: .layout)
        componentId = try c.decodeIfPresent(String.self, forKey: .componentId)
        variantProperties = try c.decodeIfPresent([String: String].self, forKey: .variantProperties)
        overrides = try c.decodeIfPresent([String: [String: DesignJSONValue]].self, forKey: .overrides)
        d = try c.decodeIfPresent(String.self, forKey: .d)
        windingRule = try c.decodeIfPresent(WindingRule.self, forKey: .windingRule)
        characters = try c.decodeIfPresent(String.self, forKey: .characters)
        typography = try c.decodeIfPresent(Typography.self, forKey: .typography)
        assetId = try c.decodeIfPresent(String.self, forKey: .assetId)
        scaleMode = try c.decodeIfPresent(ScaleMode.self, forKey: .scaleMode)

        // The type tells us which fields MUST be there. Catching it here means a
        // malformed node is a decode error at the door, not a crash later.
        if type.isContainer, children == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .children, in: c, debugDescription: "\(type.rawValue) node “\(id)” has no children array"
            )
        }
        if type == .text, characters == nil || typography == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .characters, in: c, debugDescription: "text node “\(id)” is missing characters or typography"
            )
        }
        if type == .image, assetId == nil || scaleMode == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .assetId, in: c, debugDescription: "image node “\(id)” is missing assetId or scaleMode"
            )
        }
        if type == .path, d == nil || windingRule == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .d, in: c, debugDescription: "path node “\(id)” is missing d or windingRule"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .type)
        try c.encode(name, forKey: .name)
        // `parentId` is nullable, not optional: a page root has an explicit null.
        try c.encode(parentId, forKey: .parentId)
        try c.encode(x, forKey: .x)
        try c.encode(y, forKey: .y)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(rotation, forKey: .rotation)
        try c.encode(opacity, forKey: .opacity)
        try c.encode(visible, forKey: .visible)
        try c.encode(locked, forKey: .locked)
        try c.encode(blendMode, forKey: .blendMode)
        try c.encode(fills, forKey: .fills)
        try c.encode(strokes, forKey: .strokes)
        try c.encode(cornerRadius, forKey: .cornerRadius)
        try c.encode(shadows, forKey: .shadows)
        try c.encode(blur, forKey: .blur)
        try c.encode(constraints, forKey: .constraints)
        try c.encode(widthMode, forKey: .widthMode)
        try c.encode(heightMode, forKey: .heightMode)
        try c.encode(limits, forKey: .limits)
        try c.encode(layoutChild, forKey: .layoutChild)
        try c.encode(boundVariables, forKey: .boundVariables)

        if type.isContainer {
            try c.encode(children ?? [], forKey: .children)
            try c.encode(clipsContent ?? false, forKey: .clipsContent)
            // Nullable-but-present for containers, exactly as the web writes it.
            try c.encode(layout, forKey: .layout)
        }
        if type == .component || type == .instance {
            try c.encodeIfPresent(componentId, forKey: .componentId)
        }
        if type == .instance {
            try c.encode(variantProperties ?? [:], forKey: .variantProperties)
            try c.encode(overrides ?? [:], forKey: .overrides)
        }
        if type == .path {
            try c.encodeIfPresent(d, forKey: .d)
            try c.encodeIfPresent(windingRule, forKey: .windingRule)
        }
        if type == .text {
            try c.encodeIfPresent(characters, forKey: .characters)
            try c.encodeIfPresent(typography, forKey: .typography)
        }
        if type == .image {
            try c.encodeIfPresent(assetId, forKey: .assetId)
            try c.encodeIfPresent(scaleMode, forKey: .scaleMode)
        }
    }
}

public enum WindingRule: String, Codable, Hashable, Sendable {
    case nonzero, evenodd
}

// MARK: - Pages, components, variables

public struct DesignPage: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var children: [String]
    public var backgroundColor: Rgba
}

public enum ComponentPropertyType: String, Codable, Hashable, Sendable {
    case boolean, text
    case instanceSwap = "instance-swap"
    case variant
}

public struct ComponentProperty: Codable, Hashable, Sendable {
    public var name: String
    public var type: ComponentPropertyType
    public var defaultValue: DesignJSONValue
    public var options: [String]?
    public var targetNodeId: String?
    public var targetField: String?
}

public struct ComponentDefinition: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var description: String
    public var rootNodeId: String
    public var properties: [ComponentProperty]
    public var variants: [String: String]
}

public enum VariableValue: Codable, Hashable, Sendable {
    case color(Rgba)
    case number(Double)
    case string(String)
    case boolean(Bool)
    case alias(String)

    private enum CodingKeys: String, CodingKey { case kind, value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "color": self = .color(try container.decode(Rgba.self, forKey: .value))
        case "number": self = .number(try container.decode(Double.self, forKey: .value))
        case "string": self = .string(try container.decode(String.self, forKey: .value))
        case "boolean": self = .boolean(try container.decode(Bool.self, forKey: .value))
        case "alias": self = .alias(try container.decode(String.self, forKey: .value))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "Unknown variable kind “\(other)”"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .color(let value):
            try container.encode("color", forKey: .kind)
            try container.encode(value, forKey: .value)
        case .number(let value):
            try container.encode("number", forKey: .kind)
            try container.encode(value, forKey: .value)
        case .string(let value):
            try container.encode("string", forKey: .kind)
            try container.encode(value, forKey: .value)
        case .boolean(let value):
            try container.encode("boolean", forKey: .kind)
            try container.encode(value, forKey: .value)
        case .alias(let value):
            try container.encode("alias", forKey: .kind)
            try container.encode(value, forKey: .value)
        }
    }
}

public struct VariableMode: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
}

public struct VariableCollection: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var modes: [VariableMode]
}

public enum VariableType: String, Codable, Hashable, Sendable {
    case color, number, string, boolean
}

public struct DesignVariable: Codable, Hashable, Sendable {
    public var id: String
    public var collectionId: String
    public var name: String
    public var type: VariableType
    public var valuesByMode: [String: VariableValue]
}

// MARK: - Prototyping and motion

/// Triggers, actions, transitions, keyframes and animations are carried
/// verbatim. The Mac does not evaluate them — the shared editor does — so they
/// are modelled as decoded JSON rather than re-specified here, which keeps one
/// definition of prototype semantics instead of two that can disagree.
public struct PrototypeInteraction: Codable, Hashable, Sendable {
    public var id: String
    public var sourceNodeId: String
    public var trigger: DesignJSONValue
    public var action: DesignJSONValue
    public var transition: DesignJSONValue
}

public struct MotionTrack: Codable, Hashable, Sendable {
    public var nodeId: String
    public var property: String
    public var keyframes: [DesignJSONValue]
}

public struct MotionAnimation: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var durationMs: Double
    public var loop: Bool
    public var tracks: [MotionTrack]
    public var state: String?
}

public struct DesignComment: Codable, Hashable, Sendable {
    public var id: String
    public var nodeId: String?
    public var pageId: String
    public var x: Double
    public var y: Double
    public var body: String
    public var authorId: String
    public var createdAt: String
    public var resolvedAt: String?
    public var transactionId: String?

    private enum CodingKeys: String, CodingKey {
        case id, nodeId, pageId, x, y, body, authorId, createdAt, resolvedAt, transactionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId)
        pageId = try c.decode(String.self, forKey: .pageId)
        x = try c.decode(Double.self, forKey: .x)
        y = try c.decode(Double.self, forKey: .y)
        body = try c.decode(String.self, forKey: .body)
        authorId = try c.decode(String.self, forKey: .authorId)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        resolvedAt = try c.decodeIfPresent(String.self, forKey: .resolvedAt)
        transactionId = try c.decodeIfPresent(String.self, forKey: .transactionId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(nodeId, forKey: .nodeId)
        try c.encode(pageId, forKey: .pageId)
        try c.encode(x, forKey: .x)
        try c.encode(y, forKey: .y)
        try c.encode(body, forKey: .body)
        try c.encode(authorId, forKey: .authorId)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(resolvedAt, forKey: .resolvedAt)
        try c.encode(transactionId, forKey: .transactionId)
    }
}

public struct AssetRef: Codable, Hashable, Sendable {
    public var id: String
    public var kind: String
    public var url: String
    public var width: Double
    public var height: Double
    public var mimeType: String
}

// MARK: - The document

public struct DesignDocument: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var id: String
    public var name: String
    public var revision: Int
    public var migratedFrom: [Int]
    public var pages: [DesignPage]
    public var nodes: [String: DesignNode]
    public var components: [String: ComponentDefinition]
    public var collections: [String: VariableCollection]
    public var variables: [String: DesignVariable]
    public var activeModes: [String: String]
    public var interactions: [String: PrototypeInteraction]
    public var animations: [String: MotionAnimation]
    public var comments: [DesignComment]
    public var assets: [String: AssetRef]
    public var updatedAt: String
}
