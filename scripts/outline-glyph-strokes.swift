// Outlines stroked SVG drawings into single filled paths, with Core Graphics.
//
// `scripts/generate-native-icons.mjs --outline-juno` runs this, on a Mac, when
// one of Juno's own marks changes. An SF Symbol template is fills only — a
// stroke in a symbol is silently dropped — and Juno's marks are drawn as
// strokes (`src/components/ui/juno-glyph-paths.ts`), so each cut is outlined
// once here and the result committed under `scripts/icon-sources/juno/`. The
// generator reads those files, so CI never needs this script, a Mac, or Python.
//
// Input (a JSON file, argv[1]): `[{ name, viewBox, elements: [...] }]`, where
// each element is a path, circle or rounded rect with its paint already
// resolved by the generator — whether it is filled (and by which rule), whether
// it is stroked (and how wide), and whether it is a knockout. Caps and joins
// are always round: that is the grid's rule.
//
// Output (stdout): `{ "<name>": "<path data on the 256 grid>" }`.
//
// Each element's painted region is the union of its fill and its stroke
// outline; the drawing is the union of its elements in order, with knockouts
// subtracted from whatever came before. The boolean operations are what make the
// result one clean, non-overlapping outline — a symbol renders overlapping
// subpaths with the nonzero rule, so an un-merged stroke crossing a fill would
// punch a hole wherever the two winding directions disagree.
//
// Run: xcrun swift scripts/outline-glyph-strokes.swift job.json

import CoreGraphics
import Foundation

struct Job: Decodable {
    let name: String
    let viewBox: Double
    let elements: [Element]
}

struct Element: Decodable {
    let kind: String
    let d: String?
    let cx: Double?
    let cy: Double?
    let r: Double?
    let x: Double?
    let y: Double?
    let width: Double?
    let height: Double?
    let rx: Double?
    let fill: Bool
    let evenOdd: Bool
    let strokeWidth: Double?
    let knockout: Bool
}

enum OutlineError: Error, CustomStringConvertible {
    case badPath(String)
    case badElement(String)

    var description: String {
        switch self {
        case .badPath(let message): "path data: \(message)"
        case .badElement(let message): "element: \(message)"
        }
    }
}

// MARK: - SVG path data

/// Parses SVG path data into a `CGPath`: every command, absolute and relative,
/// including the smooth curves and elliptical arcs the ghost's body uses.
struct PathParser {
    private let scalars: [Character]
    private var index = 0

    init(_ source: String) {
        scalars = Array(source)
    }

    static func parse(_ source: String) throws -> CGPath {
        var parser = PathParser(source)
        return try parser.run()
    }

    private mutating func skipSeparators() {
        while index < scalars.count, scalars[index].isWhitespace || scalars[index] == "," {
            index += 1
        }
    }

    private mutating func nextCommand() -> Character? {
        skipSeparators()
        guard index < scalars.count, scalars[index].isLetter, scalars[index] != "e", scalars[index] != "E" else {
            return nil
        }
        defer { index += 1 }
        return scalars[index]
    }

    private mutating func hasNumber() -> Bool {
        skipSeparators()
        guard index < scalars.count else { return false }
        let c = scalars[index]
        return c.isNumber || c == "-" || c == "+" || c == "."
    }

    private mutating func number() throws -> Double {
        skipSeparators()
        let start = index
        if index < scalars.count, scalars[index] == "-" || scalars[index] == "+" { index += 1 }
        var sawDot = false
        var sawExponent = false
        while index < scalars.count {
            let c = scalars[index]
            if c.isNumber {
                index += 1
            } else if c == ".", !sawDot, !sawExponent {
                sawDot = true
                index += 1
            } else if c == "e" || c == "E", !sawExponent {
                sawExponent = true
                index += 1
                if index < scalars.count, scalars[index] == "-" || scalars[index] == "+" { index += 1 }
            } else {
                break
            }
        }
        guard let value = Double(String(scalars[start..<index])) else {
            throw OutlineError.badPath("expected a number at \(start)")
        }
        return value
    }

    /// Arc flags may be written without separators ("0 0 1" or "001").
    private mutating func flag() throws -> Bool {
        skipSeparators()
        guard index < scalars.count, scalars[index] == "0" || scalars[index] == "1" else {
            throw OutlineError.badPath("expected an arc flag at \(index)")
        }
        defer { index += 1 }
        return scalars[index] == "1"
    }

    private mutating func run() throws -> CGPath {
        let path = CGMutablePath()
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        var lastCubicControl: CGPoint?
        var lastQuadControl: CGPoint?
        var command: Character?

        while true {
            if let next = nextCommand() {
                command = next
            } else if !hasNumber() {
                break
            }
            guard let cmd = command else { throw OutlineError.badPath("data does not start with a command") }
            let relative = cmd.isLowercase
            let base = relative ? current : .zero
            func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: base.x + x, y: base.y + y) }

            switch cmd.uppercased() {
            case "M":
                current = point(try number(), try number())
                subpathStart = current
                path.move(to: current)
                // Further coordinate pairs after a moveto are implicit linetos.
                command = relative ? "l" : "L"
                lastCubicControl = nil
                lastQuadControl = nil
            case "L":
                current = point(try number(), try number())
                path.addLine(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "H":
                let x = try number()
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "V":
                let y = try number()
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
                lastCubicControl = nil
                lastQuadControl = nil
            case "C":
                let c1 = point(try number(), try number())
                let c2 = point(try number(), try number())
                let end = point(try number(), try number())
                path.addCurve(to: end, control1: c1, control2: c2)
                lastCubicControl = c2
                lastQuadControl = nil
                current = end
            case "S":
                let c1 = lastCubicControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = point(try number(), try number())
                let end = point(try number(), try number())
                path.addCurve(to: end, control1: c1, control2: c2)
                lastCubicControl = c2
                lastQuadControl = nil
                current = end
            case "Q":
                let c = point(try number(), try number())
                let end = point(try number(), try number())
                path.addQuadCurve(to: end, control: c)
                lastQuadControl = c
                lastCubicControl = nil
                current = end
            case "T":
                let c = lastQuadControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let end = point(try number(), try number())
                path.addQuadCurve(to: end, control: c)
                lastQuadControl = c
                lastCubicControl = nil
                current = end
            case "A":
                let rx = try number()
                let ry = try number()
                let rotation = try number()
                let largeArc = try flag()
                let sweep = try flag()
                let end = point(try number(), try number())
                addArc(to: path, from: current, to: end, rx: rx, ry: ry, degrees: rotation, largeArc: largeArc, sweep: sweep)
                current = end
                lastCubicControl = nil
                lastQuadControl = nil
            case "Z":
                path.closeSubpath()
                current = subpathStart
                lastCubicControl = nil
                lastQuadControl = nil
            default:
                throw OutlineError.badPath("unsupported command \(cmd)")
            }
        }
        return path
    }
}

/// An SVG elliptical arc, converted from endpoint to centre parameterisation
/// (SVG 1.1 appendix F.6.5) and drawn as a transformed unit-circle arc.
func addArc(
    to path: CGMutablePath,
    from p1: CGPoint,
    to p2: CGPoint,
    rx rxIn: Double,
    ry ryIn: Double,
    degrees: Double,
    largeArc: Bool,
    sweep: Bool
) {
    var rx = abs(rxIn)
    var ry = abs(ryIn)
    if rx == 0 || ry == 0 || p1 == p2 {
        path.addLine(to: p2)
        return
    }
    let phi = degrees * .pi / 180
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)
    let dx = (p1.x - p2.x) / 2
    let dy = (p1.y - p2.y) / 2
    let x1p = cosPhi * dx + sinPhi * dy
    let y1p = -sinPhi * dx + cosPhi * dy

    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
        rx *= lambda.squareRoot()
        ry *= lambda.squareRoot()
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    let sign: Double = largeArc == sweep ? -1 : 1
    let coefficient = sign * max(0, numerator / denominator).squareRoot()
    let cxp = coefficient * rx * y1p / ry
    let cyp = -coefficient * ry * x1p / rx
    let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2
    let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2

    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
        let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a
    }
    let ux = (x1p - cxp) / rx
    let uy = (y1p - cyp) / ry
    let vx = (-x1p - cxp) / rx
    let vy = (-y1p - cyp) / ry
    let start = angle(1, 0, ux, uy)
    var delta = angle(ux, uy, vx, vy)
    if !sweep, delta > 0 { delta -= 2 * .pi }
    if sweep, delta < 0 { delta += 2 * .pi }

    // Sweep 1 is the direction of increasing angle, which Core Graphics calls
    // counter-clockwise in its own (y-up) frame. The coordinates here are the
    // SVG's own numbers, so the two agree without flipping anything.
    let transform = CGAffineTransform(translationX: cx, y: cy)
        .rotated(by: phi)
        .scaledBy(x: rx, y: ry)
    path.addArc(
        center: .zero,
        radius: 1,
        startAngle: start,
        endAngle: start + delta,
        clockwise: delta < 0,
        transform: transform
    )
}

// MARK: - Regions

func region(of element: Element) throws -> CGPath {
    let geometry: CGPath
    switch element.kind {
    case "path":
        guard let d = element.d else { throw OutlineError.badElement("path without d") }
        geometry = try PathParser.parse(d)
    case "circle":
        guard let cx = element.cx, let cy = element.cy, let r = element.r else {
            throw OutlineError.badElement("circle without cx/cy/r")
        }
        geometry = CGPath(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r), transform: nil)
    case "rect":
        guard let x = element.x, let y = element.y, let w = element.width, let h = element.height else {
            throw OutlineError.badElement("rect without x/y/width/height")
        }
        let radius = min(element.rx ?? 0, w / 2, h / 2)
        geometry = CGPath(
            roundedRect: CGRect(x: x, y: y, width: w, height: h),
            cornerWidth: radius,
            cornerHeight: radius,
            transform: nil
        )
    default:
        throw OutlineError.badElement("unknown kind \(element.kind)")
    }

    var painted: CGPath?
    if element.fill {
        painted = geometry.normalized(using: element.evenOdd ? .evenOdd : .winding)
    }
    if let width = element.strokeWidth, width > 0 {
        let outline = geometry
            .copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 10)
            .normalized()
        painted = painted.map { $0.union(outline) } ?? outline
    }
    guard let painted else { throw OutlineError.badElement("\(element.kind) paints nothing") }
    return painted
}

func outline(_ job: Job) throws -> CGPath {
    var drawing: CGPath?
    for element in job.elements {
        let painted = try region(of: element)
        if element.knockout {
            drawing = drawing?.subtracting(painted)
        } else {
            drawing = drawing.map { $0.union(painted) } ?? painted
        }
    }
    guard let drawing else { throw OutlineError.badElement("\(job.name) draws nothing") }
    let scale = 256 / job.viewBox
    var transform = CGAffineTransform(scaleX: scale, y: scale)
    return drawing.copy(using: &transform) ?? drawing
}

// MARK: - Path data out

func format(_ value: Double) -> String {
    let rounded = (value * 100).rounded() / 100
    if rounded == rounded.rounded() { return String(Int(rounded)) }
    var text = String(format: "%.2f", rounded)
    while text.hasSuffix("0") { text.removeLast() }
    if text.hasSuffix(".") { text.removeLast() }
    return text == "-0" ? "0" : text
}

func pathData(_ path: CGPath) -> String {
    var parts: [String] = []
    func pt(_ p: CGPoint) -> String { "\(format(p.x)),\(format(p.y))" }
    path.applyWithBlock { pointer in
        let element = pointer.pointee
        let points = element.points
        switch element.type {
        case .moveToPoint: parts.append("M\(pt(points[0]))")
        case .addLineToPoint: parts.append("L\(pt(points[0]))")
        case .addQuadCurveToPoint: parts.append("Q\(pt(points[0])) \(pt(points[1]))")
        case .addCurveToPoint: parts.append("C\(pt(points[0])) \(pt(points[1])) \(pt(points[2]))")
        case .closeSubpath: parts.append("Z")
        @unknown default: break
        }
    }
    return parts.joined()
}

// MARK: - Main

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: outline-glyph-strokes.swift <job.json>\n".utf8))
    exit(2)
}
do {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let jobs = try JSONDecoder().decode([Job].self, from: data)
    var result: [String: String] = [:]
    for job in jobs {
        result[job.name] = pathData(try outline(job))
    }
    let out = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted])
    FileHandle.standardOutput.write(out)
} catch {
    FileHandle.standardError.write(Data("outline-glyph-strokes: \(error)\n".utf8))
    exit(1)
}
