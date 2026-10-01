#!/usr/bin/env node
/**
 * Emits the Mac's half of the shell contract.
 *
 * `contracts/product/juno-shell-v1.json` is the web's information architecture
 * as data: the products, each product's sidebar (action rows, destinations,
 * More, section headings), the composer's `+` menu and primary action faces,
 * and the Settings rail — each item with the drawing it wears. The web is held
 * to it by `tests/shell-contract.test.ts`; this script projects it into Swift
 * so the Mac reads the same lists instead of restating them.
 *
 * WHY GENERATED ENUMS AND NOT A JSON FILE READ AT LAUNCH. The point is the
 * compile error. A destination added on the web lands here as a new case of
 * `JunoShellDestination`, and the Mac's exhaustive `switch` that maps it onto
 * `DesktopDestination` stops compiling until somebody decides what the Mac
 * does with it. A bundled JSON file would load, decode, and show nothing — the
 * silent drift the redesign audit (§A4) found everywhere.
 *
 * Icons are `JunoIcon` cases, so a concept the icon generator does not ship is
 * a failure here (checked against JunoBrand.swift) rather than a blank glyph.
 *
 * Run:
 *   node scripts/generate-shell-contract.mjs            write the Swift
 *   node scripts/generate-shell-contract.mjs --check    exit 1 when it is stale
 *   node scripts/generate-shell-contract.mjs --output=<path>.swift
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "contracts/product/juno-shell-v1.json");
const junoIconSource = join(root, "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoBrand.swift");
const defaultOutput = join(root, "native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift");

const args = process.argv.slice(2);
const check = args.includes("--check");
const outputArg = args.find((value) => value.startsWith("--output="));
const outputPath = outputArg ? resolve(outputArg.slice("--output=".length)) : defaultOutput;

const source = readFileSync(contractPath, "utf8");
const contract = JSON.parse(source);
const digest = createHash("sha256").update(source).digest("hex");

// ── Validation ──────────────────────────────────────────────────────────────
// Structural only: whether the contract says what the web says is the test's
// job. These are the mistakes that would otherwise surface as a Swift compile
// error pointing at a generated line.

const problems = [];
const fail = (message) => problems.push(message);

/** The `JunoIcon` cases, read from the enum's `case` lines. */
function junoIconCases() {
  const swift = readFileSync(junoIconSource, "utf8");
  const start = swift.indexOf("public enum JunoIcon");
  const end = swift.indexOf("public var symbolName", start);
  if (start < 0 || end < 0) throw new Error(`Cannot find the JunoIcon enum in ${relative(root, junoIconSource)}.`);
  const cases = new Set();
  for (const line of swift.slice(start, end).split("\n")) {
    const match = line.match(/^\s*case\s+(.+)$/);
    if (!match) continue;
    for (const name of match[1].split(",")) cases.add(name.trim());
  }
  return cases;
}
const iconCases = junoIconCases();

const REGISTRIES = new Set(["AppIcons", "CodeIcons", "ComposerIcons", "StatusIcons", "ActionIcons", "SettingsIcons"]);
const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);

/**
 * The `JunoIcon` case an item wears: `nativeIcon` when the contract states
 * one (null: the system draws it), the registry key for `AppIcons.library`,
 * and the export in lowerCamelCase for a bare `Scan`.
 */
function nativeIcon(item, where) {
  if (Object.hasOwn(item, "nativeIcon")) {
    if (item.nativeIcon === null) return null;
    if (!iconCases.has(item.nativeIcon)) fail(`${where}: nativeIcon "${item.nativeIcon}" is not a JunoIcon case.`);
    return item.nativeIcon;
  }
  const icon = item.icon;
  if (typeof icon !== "string" || icon.length === 0) {
    fail(`${where}: missing icon.`);
    return null;
  }
  let name;
  const dotted = icon.match(/^([A-Za-z]+)\.([A-Za-z0-9]+)$/);
  if (dotted) {
    if (!REGISTRIES.has(dotted[1])) fail(`${where}: "${icon}" names no registry in src/lib/app-icons.ts.`);
    name = dotted[2];
  } else if (/^[A-Z][A-Za-z0-9]*$/.test(icon)) {
    name = lowerFirst(icon);
  } else {
    fail(`${where}: "${icon}" is neither a registry key nor an icons.tsx export.`);
    return null;
  }
  if (!iconCases.has(name)) {
    fail(`${where}: "${icon}" maps to JunoIcon.${name}, which does not exist — state a nativeIcon, or add the case via scripts/generate-native-icons.mjs.`);
  }
  return name;
}

if (![1, 2].includes(contract.version)) fail("version: this generator reads v1 and v2 of the shell contract.");

const plans = contract.plans ?? [];
if (!Array.isArray(plans) || plans.length === 0) fail("plans: missing.");
const planSet = new Set(plans);
const checkPlan = (plan, where) => {
  if (!planSet.has(plan)) fail(`${where}: minPlan "${plan}" is not one of ${plans.join(", ")}.`);
};

const products = contract.products ?? [];
for (const product of products) {
  checkPlan(product.minPlan, `products.${product.id}`);
  if (!contract.sidebar?.[product.id]) fail(`sidebar.${product.id}: missing.`);
}

const destinations = contract.destinations ?? [];
const destinationIDs = new Set(destinations.map((destination) => destination.id));

for (const [productID, sidebar] of Object.entries(contract.sidebar ?? {})) {
  if (!products.some((product) => product.id === productID)) fail(`sidebar.${productID}: no such product.`);
  for (const id of sidebar.destinations ?? []) {
    if (!destinationIDs.has(id)) fail(`sidebar.${productID}.destinations: "${id}" is not a destination.`);
  }
  for (const item of sidebar.more?.items ?? []) {
    if (!destinationIDs.has(item.destination)) fail(`sidebar.${productID}.more: "${item.destination}" is not a destination.`);
    checkPlan(item.minPlan, `sidebar.${productID}.more.${item.destination}`);
  }
}

const plus = contract.composer?.plusMenu ?? {};
const plusRows = plus.rows ?? [];
const plusRowIDs = new Set(plusRows.map((row) => row.id));
const rowKinds = new Set(plus.rowKinds ?? []);
for (const row of plusRows) {
  if (!rowKinds.has(row.kind)) fail(`composer.plusMenu.rows.${row.id}: kind "${row.kind}" is not one of the rowKinds.`);
  if (row.variantOf && !plusRowIDs.has(row.variantOf)) fail(`composer.plusMenu.rows.${row.id}: variantOf "${row.variantOf}" is not a row.`);
}
for (const [surface, groups] of Object.entries(plus.groups ?? {})) {
  for (const group of groups) {
    for (const id of group) {
      if (!plusRowIDs.has(id)) fail(`composer.plusMenu.groups.${surface}: "${id}" is not a row.`);
    }
  }
}

const faces = contract.composer?.primaryAction?.faces ?? [];
const faceIDs = new Set(faces.map((face) => face.id));
for (const face of faces) {
  if (face.fill !== "accent" && face.fill !== "quiet") fail(`composer.primaryAction.${face.id}: fill must be accent or quiet.`);
}
for (const [state, face] of Object.entries(contract.composer?.primaryAction?.states ?? {})) {
  if (!faceIDs.has(face)) fail(`composer.primaryAction.states.${state}: "${face}" is not a face.`);
}

const settings = contract.settings ?? {};
const settingsIDs = new Set((settings.sections ?? []).map((section) => section.id));
if (!settingsIDs.has(settings.default)) fail(`settings.default: "${settings.default}" is not a section.`);
for (const [alias, target] of Object.entries(settings.aliases ?? {})) {
  if (!settingsIDs.has(target)) fail(`settings.aliases.${alias}: "${target}" is not a section.`);
  if (settingsIDs.has(alias)) fail(`settings.aliases.${alias}: an alias cannot shadow a section id.`);
}

// ── Swift ───────────────────────────────────────────────────────────────────

const swiftString = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** `voice-files` → `voiceFiles`; ids that are already camelCase pass through. */
const swiftCase = (id) => id.replace(/[-_]([a-z0-9])/g, (_, character) => character.toUpperCase());
const caseDecl = (id) => (swiftCase(id) === id ? `case ${id}` : `case ${swiftCase(id)} = ${swiftString(id)}`);
const planCase = (plan) => swiftCase(plan.toLowerCase());
const iconLiteral = (icon) => (icon === null ? "nil" : `.${icon}`);

/**
 * Apple's title case, for a menu: every word capitalised except articles,
 * coordinating conjunctions and prepositions of four letters or fewer, unless
 * first or last. "Add from library" → "Add from Library".
 */
const MINOR_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
  "as", "at", "by", "in", "of", "off", "on", "per", "to", "up", "via", "from", "into", "onto", "over", "with",
]);
function titleCase(label) {
  const words = label.split(" ");
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** A computed property that switches over `entries` ([id, expression]). */
function switchProperty(indent, doc, name, type, entries) {
  const pad = " ".repeat(indent);
  const lines = [];
  if (doc) lines.push(`${pad}/// ${doc}`);
  lines.push(`${pad}var ${name}: ${type} {`);
  lines.push(`${pad}    switch self {`);
  for (const [id, expression] of entries) lines.push(`${pad}    case .${swiftCase(id)}: ${expression}`);
  lines.push(`${pad}    }`);
  lines.push(`${pad}}`);
  return lines.join("\n");
}

const list = (ids) => `[${ids.map((id) => `.${swiftCase(id)}`).join(", ")}]`;
const moreItem = (item) =>
  `JunoShellMoreItem(destination: .${swiftCase(item.destination)}, minPlan: .${planCase(item.minPlan)})`;

function sidebarEnum(product) {
  const sidebar = contract.sidebar[product.id];
  const name = `JunoShell${product.label}Sidebar`;
  const actions = sidebar.actions ?? [];
  const sections = sidebar.sections ?? [];
  const more = sidebar.more;
  const archivedIcon = nativeIcon(more.archived, `sidebar.${product.id}.more.archived`);
  return `/// ${product.label}'s sidebar (\`app-sidebar.tsx\` with \`product\` = ${product.id}), top to bottom.
enum ${name} {
    /// The action rows over the destinations, in order.
    enum Action: String, CaseIterable, Sendable {
${actions.map((action) => `        ${caseDecl(action.id)}`).join("\n")}

${switchProperty(8, "The web's words.", "label", "String", actions.map((action) => [action.id, swiftString(action.label)]))}

${switchProperty(8, "The words in Title Case, for a menu.", "title", "String", actions.map((action) => [action.id, swiftString(titleCase(action.label))]))}

${switchProperty(8, null, "icon", "JunoIcon", actions.map((action) => [action.id, iconLiteral(nativeIcon(action, `sidebar.${product.id}.actions.${action.id}`))]))}
    }

    /// The destination rows, in order.
    static let destinations: [JunoShellDestination] = ${list(sidebar.destinations)}

    /// The More menu: its items, then a separator and the archive, which opens
    /// a dialog rather than a page.
    enum More {
        static let label = ${swiftString(more.label)}
        static let icon: JunoIcon = ${iconLiteral(nativeIcon(more, `sidebar.${product.id}.more`))}
        static let items: [JunoShellMoreItem] = [
${more.items.map((item) => `            ${moreItem(item)},`).join("\n")}
        ]
        static let archivedLabel = ${swiftString(more.archived.label)}
        static let archivedTitle = ${swiftString(titleCase(more.archived.label))}
        static let archivedIcon: JunoIcon = ${iconLiteral(archivedIcon)}
    }

    /// The list's section headings, in the order the list draws them.
    enum Heading: String, CaseIterable, Sendable {
${sections.map((section) => `        ${caseDecl(section.id)}`).join("\n")}

${switchProperty(8, "The web's words.", "label", "String", sections.map((section) => [section.id, swiftString(section.label)]))}
    }

    /// What the list says when there is nothing in it, line by line.
    static let emptyLines: [String] = [${(sidebar.empty ?? []).map(swiftString).join(", ")}]
}`;
}

const productCases = products.map((product) => `    ${caseDecl(product.id)}`).join("\n");
const sidebarName = (product) => `JunoShell${product.label}Sidebar`;

const destinationCases = destinations.map((destination) => `    ${caseDecl(destination.id)}`).join("\n");

const rowKindCases = [...rowKinds].map((kind) => (kind === "sub" ? `        case submenu = "sub"` : `        case ${kind}`)).join("\n");
const rowKindCase = (kind) => (kind === "sub" ? "submenu" : kind);

const settingsSections = settings.sections ?? [];

const swift = `// Generated by scripts/generate-shell-contract.mjs. Do not edit.
//
// Source of truth: contracts/product/juno-shell-v1.json, the web's shell as
// data. tests/shell-contract.test.ts holds the web to the contract, and
// \`npm run shell:contract:check\` holds this file to it. Regenerate with
// \`npm run shell:contract:generate\`; the Mac's own enums map these cases in
// DesktopShellContract.swift, where a new case fails the build until it is
// given a place.
import JunoDesignSystem

/// Which shell contract this build was generated from.
enum JunoShellContract {
    /// Bumped when the contract's shape changes.
    static let version = ${contract.version}
    /// SHA-256 of the contract this was generated from.
    static let digest = "${digest}"
}

/// An account's plan, lowest to highest (\`Plan\` in prisma/schema.prisma,
/// ranked by \`planRank\` in src/lib/plans.ts).
enum JunoShellPlan: String, CaseIterable, Comparable, Sendable {
${plans.map((plan) => `    case ${planCase(plan)} = ${swiftString(plan)}`).join("\n")}

    static func < (lhs: Self, rhs: Self) -> Bool {
        (allCases.firstIndex(of: lhs) ?? 0) < (allCases.firstIndex(of: rhs) ?? 0)
    }
}

/// The products, in the switch's order (\`PRODUCTS\` in product-switch.tsx).
enum JunoShellProduct: String, CaseIterable, Sendable {
${productCases}

${switchProperty(4, null, "label", "String", products.map((product) => [product.id, swiftString(product.label)]))}

${switchProperty(4, null, "href", "String", products.map((product) => [product.id, swiftString(product.href)]))}

${switchProperty(4, null, "icon", "JunoIcon", products.map((product) => [product.id, iconLiteral(nativeIcon(product, `products.${product.id}`))]))}

${switchProperty(4, "The plan that unlocks it. A locked product is shown greyed, never hidden.", "minPlan", "JunoShellPlan", products.map((product) => [product.id, `.${planCase(product.minPlan)}`]))}

${switchProperty(4, "The chord the web binds it to; the Mac binds ⌘1 and ⌘2 (register #4).", "webChord", "String", products.map((product) => [product.id, swiftString(product.webChord)]))}

${switchProperty(4, "The destination rows its sidebar lists under the action rows, in order.", "destinations", "[JunoShellDestination]", products.map((product) => [product.id, `${sidebarName(product)}.destinations`]))}

${switchProperty(4, "What its More menu holds, in order.", "moreItems", "[JunoShellMoreItem]", products.map((product) => [product.id, `${sidebarName(product)}.More.items`]))}
}

/// Every place a sidebar row or a More item leads, in either product.
enum JunoShellDestination: String, CaseIterable, Sendable {
${destinationCases}

${switchProperty(4, "The web's words.", "label", "String", destinations.map((destination) => [destination.id, swiftString(destination.label)]))}

${switchProperty(4, "The words in Title Case, for a menu.", "title", "String", destinations.map((destination) => [destination.id, swiftString(titleCase(destination.label))]))}

${switchProperty(4, null, "href", "String", destinations.map((destination) => [destination.id, swiftString(destination.href)]))}

${switchProperty(4, null, "icon", "JunoIcon", destinations.map((destination) => [destination.id, iconLiteral(nativeIcon(destination, `destinations.${destination.id}`))]))}
}

/// One item of a More menu, and the plan that unlocks it.
struct JunoShellMoreItem: Hashable, Sendable {
    let destination: JunoShellDestination
    let minPlan: JunoShellPlan

    /// Whether an account on \`plan\` may open it.
    func isUnlocked(for plan: JunoShellPlan) -> Bool {
        plan >= minPlan
    }
}

${products.map(sidebarEnum).join("\n\n")}

/// A row of the composer's \`+\` menu (\`plusSections\` in composer.tsx).
enum JunoShellPlusRow: String, CaseIterable, Sendable {
${plusRows.map((row) => `    ${caseDecl(row.id)}`).join("\n")}

    /// What pressing the row does (\`PlusMenuItem\` in composer-plus-menu.tsx).
    enum Kind: String, Sendable {
${rowKindCases}
    }

${switchProperty(4, "The web's words.", "label", "String", plusRows.map((row) => [row.id, swiftString(row.label)]))}

${switchProperty(4, "The words in Title Case, for a menu.", "title", "String", plusRows.map((row) => [row.id, swiftString(titleCase(row.label))]))}

${switchProperty(4, null, "kind", "Kind", plusRows.map((row) => [row.id, `.${rowKindCase(row.kind)}`]))}

${switchProperty(4, null, "icon", "JunoIcon", plusRows.map((row) => [row.id, iconLiteral(nativeIcon(row, `composer.plusMenu.rows.${row.id}`))]))}

${switchProperty(4, "Whether the web leaves the row out where it cannot apply, rather than showing it disabled with the reason.", "isOptional", "Bool", plusRows.map((row) => [row.id, row.optional ? "true" : "false"]))}

${switchProperty(4, "The row this one stands in for on some surface.", "variantOf", "JunoShellPlusRow?", plusRows.map((row) => [row.id, row.variantOf ? `.${swiftCase(row.variantOf)}` : "nil"]))}
}

/// The composer's \`+\` menu: groups of rows, a divider between groups.
enum JunoShellPlusMenu {
    /// The menu's accessible name.
    static let label = ${swiftString(plus.label)}
${Object.entries(plus.groups ?? {})
  .map(
    ([surface, groups]) => `
    /// The ${surface} composer's groups, in order.
    static let ${swiftCase(surface)}: [[JunoShellPlusRow]] = [
${groups.map((group) => `        ${list(group)},`).join("\n")}
    ]`,
  )
  .join("\n")}
}

/// The faces of the composer's primary action (\`ComposerPrimaryFace\` in
/// composer-shell.tsx), in the web's order.
enum JunoShellPrimaryFace: String, CaseIterable, Sendable {
${faces.map((face) => `    ${caseDecl(face.id)}`).join("\n")}

${switchProperty(4, "The accent disc, or the quiet secondary one. The accent means one verb.", "isAccented", "Bool", faces.map((face) => [face.id, face.fill === "accent" ? "true" : "false"]))}

${switchProperty(4, "The glyph, or nil where the system draws the face (a spinner).", "icon", "JunoIcon?", faces.map((face) => [face.id, iconLiteral(nativeIcon(face, `composer.primaryAction.${face.id}`))]))}

    /// The face the web's composer shows for one of its states (\`PRIMARY_FACES\`).
    init?(composerState: String) {
        switch composerState {
${Object.entries(contract.composer.primaryAction.states)
  .map(([state, face]) => `        case ${swiftString(state)}: self = .${swiftCase(face)}`)
  .join("\n")}
        default: return nil
        }
    }
}

/// The Settings rail (\`SETTINGS_SECTIONS\` in settings-sections.ts), in order.
enum JunoShellSettingsSection: String, CaseIterable, Sendable {
${settingsSections.map((section) => `    ${caseDecl(section.id)}`).join("\n")}

    /// What an unknown or missing section opens.
    static let defaultSection: Self = .${swiftCase(settings.default)}

${switchProperty(4, "The web's words.", "label", "String", settingsSections.map((section) => [section.id, swiftString(section.label)]))}

${switchProperty(4, null, "icon", "JunoIcon", settingsSections.map((section) => [section.id, iconLiteral(nativeIcon(section, `settings.sections.${section.id}`))]))}

    /// The \`/settings\` URL for the section: the default is the bare page.
    var href: String {
        self == Self.defaultSection ? "/settings" : "/settings?section=\\(rawValue)"
    }

    /// The other names the web routes to a section (\`ALIASES\`).
    static let aliases: [String: Self] = [
${Object.entries(settings.aliases ?? {})
  .map(([alias, target]) => `        ${swiftString(alias)}: .${swiftCase(target)},`)
  .join("\n")}
    ]

    /// The web's rule: a section id, else an alias, else the default.
    static func resolve(_ value: String?) -> Self {
        guard let value else { return defaultSection }
        return Self(rawValue: value) ?? aliases[value] ?? defaultSection
    }
}
`;

if (problems.length > 0) {
  console.error(`The shell contract is not valid (${relative(root, contractPath)}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (check) {
  let current = null;
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    // Reported below.
  }
  if (current !== swift) {
    console.error(
      `${relative(root, outputPath)} is ${current === null ? "missing" : "stale"}: `
        + `${relative(root, contractPath)} changed without it. Run: npm run shell:contract:generate`,
    );
    process.exit(1);
  }
  console.log(`Swift shell contract matches ${relative(root, contractPath)} (v${contract.version}, ${digest.slice(0, 12)}…).`);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, swift, "utf8");
  console.log(`Wrote ${relative(root, outputPath)} (v${contract.version}, ${digest.slice(0, 12)}…).`);
}
