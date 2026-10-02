import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

import * as Icons from "@/components/ui/icons";
import * as Registries from "@/lib/app-icons";
import { PRODUCTS } from "@/components/app/product-switch";
import { WEB_SETTINGS_SECTIONS,
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  settingsHref,
} from "@/components/settings/settings-sections";
import { planRank } from "@/lib/plans";
import * as BrandNames from "@/lib/brand/names";

/*
 * THE SHELL CONTRACT HOLDS THE WEB (docs/native/MACOS_LIQUID_GLASS_REDESIGN.md
 * §A4.2, §11 Phase 6).
 *
 * `contracts/product/juno-shell-v1.json` is the web's information
 * architecture as data — products, each product's sidebar, the composer's `+`
 * menu and primary action, the Settings rail — and the Mac's enums are
 * generated from it (scripts/generate-shell-contract.mjs). Nothing else
 * represented layout, which is how the Work merge and Design moving into
 * Artifacts changed no file the Mac depended on.
 *
 * So this reads the shipped sources — the sidebar and the composer as syntax
 * trees, the registries and the Settings list as the running modules — and
 * fails on any difference. A row added, renamed, reordered, regated or given
 * another drawing on the web fails here until the contract says the same;
 * regenerating the Swift then fails the Mac build until the Mac maps it.
 */

type ProductID = "chat" | "code";
const PRODUCT_IDS: ProductID[] = ["chat", "code"];

type IconItem = { icon: string; nativeIcon?: string | null };
type KindItem = IconItem & { kind: string };
type Contract = {
  legacyDestinations: string[];
  version: number;
  plans: string[];
  products: (KindItem & { id: ProductID; label: string; href: string; webChord: string; minPlan: string })[];
  destinations: (KindItem & { id: string; label: string; href: string })[];
  sidebar: Record<
    ProductID,
    {
      actions: (KindItem & { id: string; label: string })[];
      destinations: string[];
      more: KindItem & {
        label: string;
        items: { destination: string; minPlan: string }[];
        archived: IconItem & { label: string };
      };
      sections: { id: string; label: string }[];
      empty: string[];
    }
  >;
  composer: {
    plusMenu: {
      label: string;
      rowKinds: string[];
      rows: (IconItem & { id: string; label: string; kind: string; optional?: boolean; variantOf?: string })[];
      groups: Record<string, string[][]>;
    };
    primaryAction: {
      faces: (IconItem & { id: string; fill: "accent" | "quiet" })[];
      states: Record<string, string>;
    };
  };
  settings: {
    default: string;
    sections: (IconItem & { id: string; label: string })[];
    aliases: Record<string, string>;
  };
};

const CONTRACT = JSON.parse(
  readFileSync(new URL("../contracts/product/juno-shell-v1.json", import.meta.url), "utf8"),
) as Contract;

// ── Reading the sources ─────────────────────────────────────────────────────

function sourceFile(path: string): ts.SourceFile {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

const SIDEBAR = sourceFile("src/components/app/app-sidebar.tsx");
const MOTION_ICONS = sourceFile("src/components/app/sidebar-motion-icon.tsx");
const COMPOSER = sourceFile("src/components/chat/composer.tsx");
const PLUS_MENU = sourceFile("src/components/chat/composer-plus-menu.tsx");
const COMPOSER_SHELL = sourceFile("src/components/ui/composer-shell.tsx");
const SETTINGS = sourceFile("src/components/settings/settings-sections.ts");

/** Every node under `root`, in source order. */
function descendants(root: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return nodes;
}

function functionNamed(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = descendants(file).find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `${file.fileName} declares function ${name}`);
  return found;
}

function variableNamed(root: ts.Node, name: string): ts.Expression {
  const found = descendants(root).find(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  assert.ok(found?.initializer, `a const ${name} with an initializer`);
  return found.initializer;
}

/** The expression under parentheses, `as const` and `satisfies`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * A name read through the display-name registry (src/lib/brand/names.ts):
 * `FEATURE_NAMES.library.label` is the sidebar's "Library" exactly as a
 * literal would be, so the contract holds the words the reader sees.
 */
function registryText(node: ts.Expression): string | undefined {
  let value: unknown = BrandNames;
  for (const key of node.getText().replace(/\s+/g, "").split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : undefined;
}

function stringOf(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const bare = unwrap(node);
  if (ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare)) return bare.text;
  if (ts.isIdentifier(bare) || ts.isPropertyAccessExpression(bare)) return registryText(bare);
  return undefined;
}

/** The words an element shows: its text, or a single `{name}` it renders. */
function childText(node: ts.Node): string | undefined {
  if (ts.isJsxText(node)) return node.text.trim() || undefined;
  if (ts.isJsxExpression(node) && node.expression) return stringOf(node.expression);
  return undefined;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && member.name.getText() === name) return member.initializer;
  }
  return undefined;
}

function tagName(node: ts.Node): string | undefined {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName.getText() : undefined;
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined {
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name || !attr.initializer) continue;
    if (ts.isStringLiteral(attr.initializer)) return attr.initializer;
    if (ts.isJsxExpression(attr.initializer)) return attr.initializer.expression;
  }
  return undefined;
}

function elements(root: ts.Node, name: string): ts.JsxOpeningLikeElement[] {
  return descendants(root).filter(
    (node): node is ts.JsxOpeningLikeElement =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === name,
  );
}

type PerProduct = Record<ProductID, string>;

/** A label the sidebar writes once, or as `isCode ? code : chat`. */
function perProduct(node: ts.Expression | undefined, where: string): PerProduct {
  assert.ok(node, `${where}: a label`);
  const bare = unwrap(node);
  const plain = stringOf(bare);
  if (plain !== undefined) return { chat: plain, code: plain };
  if (ts.isConditionalExpression(bare) && bare.condition.getText() === "isCode") {
    const code = stringOf(bare.whenTrue);
    const chat = stringOf(bare.whenFalse);
    if (code !== undefined && chat !== undefined) return { chat, code };
  }
  throw new Error(`${where}: cannot read a label from \`${bare.getText()}\``);
}

/** The products an element is drawn for, from the `isCode` guards above it. */
function productsFor(node: ts.Node, boundary: ts.Node): ProductID[] {
  let chat = true;
  let code = true;
  const conjuncts = (expression: ts.Expression): ts.Expression[] => {
    const bare = unwrap(expression);
    return ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...conjuncts(bare.left), ...conjuncts(bare.right)]
      : [bare];
  };
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent && child !== boundary) {
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && parent.right === child
    ) {
      for (const guard of conjuncts(parent.left)) {
        if (guard.getText() === "!isCode") code = false;
        if (guard.getText() === "isCode") chat = false;
      }
    }
    if (ts.isConditionalExpression(parent) && unwrap(parent.condition).getText() === "isCode") {
      if (parent.whenTrue === child) chat = false;
      if (parent.whenFalse === child) code = false;
    }
    child = parent;
    parent = parent.parent;
  }
  return PRODUCT_IDS.filter((id) => (id === "chat" ? chat : code));
}

/** The `isCode ? [...] : [...]` choice of row objects inside a function. */
function rowsByProduct(root: ts.Node): Record<ProductID, ts.ObjectLiteralExpression[]> {
  const isRowList = (node: ts.Expression) => {
    const bare = unwrap(node);
    return (
      ts.isArrayLiteralExpression(bare)
      && bare.elements.every((element) => ts.isObjectLiteralExpression(element) && property(element, "href"))
    );
  };
  const choices = descendants(root).filter(
    (node): node is ts.ConditionalExpression =>
      ts.isConditionalExpression(node)
      && unwrap(node.condition).getText() === "isCode"
      && isRowList(node.whenTrue)
      && isRowList(node.whenFalse),
  );
  assert.equal(choices.length, 1, "one `isCode ? [rows] : [rows]` choice");
  const rows = (node: ts.Expression) =>
    (unwrap(node) as ts.ArrayLiteralExpression).elements as unknown as ts.ObjectLiteralExpression[];
  return { code: rows(choices[0].whenTrue), chat: rows(choices[0].whenFalse) };
}

/** `SidebarMotionIcon` kind → the registry expression it draws. */
const MOTION_ICON_TABLE: Record<string, string> = (() => {
  const table = unwrap(variableNamed(MOTION_ICONS, "ICONS"));
  assert.ok(ts.isObjectLiteralExpression(table), "ICONS is an object literal");
  const entries: Record<string, string> = {};
  for (const member of table.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const key = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText();
    entries[key] = member.initializer.getText();
  }
  return entries;
})();

function assertKindWearsIcon(item: KindItem, where: string) {
  assert.equal(
    MOTION_ICON_TABLE[item.kind],
    item.icon,
    `${where}: SidebarMotionIcon kind "${item.kind}" draws ${MOTION_ICON_TABLE[item.kind]}, the contract says ${item.icon}`,
  );
}

const destinationByID = new Map(CONTRACT.destinations.map((destination) => [destination.id, destination]));

// ── Products and plans ──────────────────────────────────────────────────────

test("the plans are the Prisma enum, lowest to highest", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const body = schema.match(/enum Plan \{([^}]*)\}/)?.[1] ?? "";
  const declared = body.split(/\s+/).filter(Boolean);
  assert.deepEqual([...CONTRACT.plans].sort(), [...declared].sort(), "every plan, once");
  const ranks = CONTRACT.plans.map((plan) => planRank(plan as Parameters<typeof planRank>[0]));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "in planRank order");
  assert.equal(new Set(ranks).size, ranks.length, "no two plans share a rank");
});

test("the products are the switch's, in its order, with its plan gate", () => {
  assert.deepEqual(
    PRODUCTS.map((product) => ({
      id: product.id,
      label: product.label,
      href: product.href,
      kind: product.kind,
      webChord: product.chord,
      minPlan: product.minPlan,
    })),
    CONTRACT.products.map(({ id, label, href, kind, webChord, minPlan }) => ({ id, label, href, kind, webChord, minPlan })),
  );
  for (const product of CONTRACT.products) assertKindWearsIcon(product, `products.${product.id}`);
});

// ── The sidebar ─────────────────────────────────────────────────────────────

const APP_SIDEBAR = functionNamed(SIDEBAR, "AppSidebar");
const USER_MENU_FILE = sourceFile("src/components/app/user-menu.tsx");

/** The per-product `kind` of the `<SidebarMotionIcon>` an element's `icon` prop draws. */
function motionKinds(element: ts.JsxOpeningLikeElement): PerProduct | undefined {
  const icon = attribute(element, "icon");
  if (!icon) return undefined;
  const glyph = [icon, ...descendants(icon)].find(
    (node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && tagName(node) === "SidebarMotionIcon",
  );
  return glyph ? perProduct(attribute(glyph, "kind"), "the row's glyph") : undefined;
}

test("the action rows are New chat and Search, in order, in both products", () => {
  const rows = elements(APP_SIDEBAR, "NavRow")
    .filter((row) => {
      const label = attribute(row, "label");
      return label !== undefined && (stringOf(label) !== undefined || ts.isConditionalExpression(unwrap(label)));
    })
    .map((row) => ({ label: perProduct(attribute(row, "label"), "NavRow"), kind: motionKinds(row) }));
  for (const product of PRODUCT_IDS) {
    const actions = CONTRACT.sidebar[product].actions;
    assert.deepEqual(
      rows.map((row) => ({ label: row.label[product], kind: row.kind?.[product] })),
      actions.map(({ label, kind }) => ({ label, kind })),
      `${product}'s action rows`,
    );
    for (const action of actions) assertKindWearsIcon(action, `sidebar.${product}.actions.${action.id}`);
  }
});

test("each product's destination rows are the contract's, in order", () => {
  const rows = rowsByProduct(APP_SIDEBAR);
  for (const product of PRODUCT_IDS) {
    const drawn = rows[product].map((row) => ({
      href: stringOf(property(row, "href")),
      kind: stringOf(property(row, "kind")),
      label: stringOf(property(row, "label")),
    }));
    const expected = CONTRACT.sidebar[product].destinations.map((id) => {
      const destination = destinationByID.get(id);
      assert.ok(destination, `destination ${id}`);
      return { href: destination.href, kind: destination.kind, label: destination.label };
    });
    assert.deepEqual(drawn, expected, `${product}'s destinations`);
  }
});

test("each product's archive opens from the account menu, with the contract's label and glyph", () => {
  /*
   * The web has no More row (the V3 shell): with no destinations left in it,
   * the row was only the archive, which now sits in the account menu. The
   * contract keeps its `more` block for the native shells; on the web its
   * items stay empty and its archive is the account menu's row.
   */
  for (const product of PRODUCT_IDS) {
    assert.deepEqual(CONTRACT.sidebar[product].more.items, [], `${product}: More holds no destination`);
  }
  const menus = elements(APP_SIDEBAR, "UserMenu");
  assert.ok(menus.length >= 2, "the expanded and the rail account menus");
  for (const menu of menus) {
    assert.match(attribute(menu, "onOpenArchived")?.getText() ?? "", /setArchivedOpen\(true\)/, "each account menu opens the archive");
    const labels = perProduct(attribute(menu, "archivedLabel"), "the archive row");
    for (const product of PRODUCT_IDS) {
      assert.equal(labels[product], CONTRACT.sidebar[product].more.archived.label, `${product}'s archive row`);
    }
  }
  const archiveRow = elements(USER_MENU_FILE, "MenuRow").find((row) => attribute(row, "onSelect")?.getText() === "onOpenArchived");
  assert.ok(archiveRow, "the account menu has an archive row");
  const icon = attribute(archiveRow, "icon")!;
  const glyph = [icon, ...descendants(icon)].find(ts.isJsxSelfClosingElement);
  for (const product of PRODUCT_IDS) {
    assert.equal(glyph && tagName(glyph), CONTRACT.sidebar[product].more.archived.icon, `${product}'s archive glyph`);
  }
});

test("the list's section headings are the contract's, in order, per product", () => {
  // Needs you is its own fold (`NeedsYouFold`), drawn above every Section.
  const needsYouFold = functionNamed(SIDEBAR, "NeedsYouFold");
  const needsYouLabel = descendants(needsYouFold)
    .filter((node) => ts.isJsxText(node) || ts.isJsxExpression(node))
    .map(childText)
    .find(Boolean);
  const headings: { node: ts.Node; label: PerProduct }[] = [
    ...elements(APP_SIDEBAR, "NeedsYouFold").map((node) => ({
      node,
      label: { chat: needsYouLabel ?? "", code: needsYouLabel ?? "" },
    })),
    ...elements(APP_SIDEBAR, "Section").map((node) => ({
      node,
      label: perProduct(attribute(node, "label"), "Section"),
    })),
    // Orbit's head is a destination (it opens the roster), not a Section:
    // the Orbit icon and `BRAND.orbit.label`, linking to /agents.
    ...elements(APP_SIDEBAR, "JunoOrbit").map((node) => ({
      node,
      label: { chat: BrandNames.BRAND.orbit.label, code: BrandNames.BRAND.orbit.label },
    })),
  ].sort((a, b) => a.node.getStart() - b.node.getStart());

  for (const product of PRODUCT_IDS) {
    const drawn = headings
      .filter((heading) => productsFor(heading.node, APP_SIDEBAR).includes(product))
      .map((heading) => heading.label[product]);
    assert.deepEqual(
      drawn,
      CONTRACT.sidebar[product].sections.map((section) => section.label),
      `${product}'s section headings`,
    );
  }
});

test("the empty list says the contract's two lines", () => {
  const empty = elements(APP_SIDEBAR, "p").find((element) => stringOf(attribute(element, "aria-live")) === "polite");
  assert.ok(empty && ts.isJsxOpeningElement(empty), "the empty list's line");
  const body = (empty.parent as ts.JsxElement).children;
  const lines: PerProduct[] = [];
  for (const child of body) {
    if (ts.isJsxText(child) && child.text.trim()) {
      const text = child.text.trim();
      lines.push({ chat: text, code: text });
    } else if (ts.isJsxExpression(child) && child.expression) {
      lines.push(perProduct(child.expression, "the empty list"));
    }
  }
  for (const product of PRODUCT_IDS) {
    assert.deepEqual(
      lines.map((line) => line[product]),
      CONTRACT.sidebar[product].empty,
      `${product}'s empty list`,
    );
  }
});

test("every destination is navigable or explicitly retained for compatibility", () => {
  const placed = new Set(
    PRODUCT_IDS.flatMap((product) => [
      ...CONTRACT.sidebar[product].destinations,
      ...CONTRACT.sidebar[product].more.items.map((item) => item.destination),
    ]),
  );
  for (const destination of CONTRACT.destinations) {
    assert.ok(placed.has(destination.id) || CONTRACT.legacyDestinations.includes(destination.id), `${destination.id} is navigable or retained for compatibility`);
    assertKindWearsIcon(destination, `destinations.${destination.id}`);
  }
});

// ── The composer ────────────────────────────────────────────────────────────

type DrawnRow = {
  id: string;
  label: string;
  kind: string;
  icon: string;
  optional: boolean;
  /** The row that stands in for this one: `voiceCanSeeImages ? "files" : "voice-files"`. */
  alternate?: { id: string; label: string };
};

/** A `+` menu row object, as the composer writes it. */
function plusRow(object: ts.ObjectLiteralExpression, optional: boolean): DrawnRow {
  const idNode = property(object, "id");
  const labelNode = property(object, "label");
  assert.ok(idNode && labelNode, `a row with an id and a label: ${object.getText().slice(0, 80)}`);
  const bareID = unwrap(idNode);
  const bareLabel = unwrap(labelNode);
  let alternate: DrawnRow["alternate"];
  let id = stringOf(bareID);
  let label = stringOf(bareLabel);
  if (ts.isConditionalExpression(bareID) && ts.isConditionalExpression(bareLabel)) {
    id = stringOf(bareID.whenTrue);
    label = stringOf(bareLabel.whenTrue);
    const alternateID = stringOf(bareID.whenFalse);
    const alternateLabel = stringOf(bareLabel.whenFalse);
    assert.ok(alternateID && alternateLabel, "a row's alternate has an id and a label");
    alternate = { id: alternateID, label: alternateLabel };
  }
  assert.ok(id && label, `a literal id and label: ${object.getText().slice(0, 80)}`);
  const kind = stringOf(property(object, "kind"));
  const icon = property(object, "icon")?.getText();
  assert.ok(kind && icon, `${id}: a kind and an icon`);
  return { id, label, kind, icon, optional, ...(alternate ? { alternate } : {}) };
}

/** A row reached through a name: `const researchRow = researchAvailable ? {…} : null`. */
function namedRow(name: string, optional: boolean): DrawnRow {
  const initializer = unwrap(variableNamed(COMPOSER, name));
  if (ts.isObjectLiteralExpression(initializer)) return plusRow(initializer, optional);
  assert.ok(
    ts.isConditionalExpression(initializer) && ts.isObjectLiteralExpression(unwrap(initializer.whenTrue)),
    `${name} is a row, or \`condition ? row : null\``,
  );
  return plusRow(unwrap(initializer.whenTrue) as ts.ObjectLiteralExpression, true);
}

function rowsOf(elementsOf: ts.NodeArray<ts.Expression>, optional: boolean): DrawnRow[] {
  const rows: DrawnRow[] = [];
  for (const element of elementsOf) {
    const bare = unwrap(element);
    if (ts.isObjectLiteralExpression(bare)) {
      rows.push(plusRow(bare, optional));
    } else if (ts.isIdentifier(bare)) {
      rows.push(namedRow(bare.text, optional));
    } else if (ts.isSpreadElement(bare)) {
      // `...(condition ? [rows] : [])`: rows the composer leaves out.
      const spread = unwrap(bare.expression);
      assert.ok(ts.isConditionalExpression(spread), `a conditional spread: ${spread.getText().slice(0, 80)}`);
      const present = unwrap(spread.whenTrue);
      assert.ok(ts.isArrayLiteralExpression(present), "the spread's rows");
      rows.push(...rowsOf(present.elements, true));
    } else {
      assert.fail(`an unreadable + menu row: ${bare.getText().slice(0, 80)}`);
    }
  }
  return rows;
}

/** The composer's `plusSections`, per surface: groups of rows. */
const PLUS_SECTIONS: Record<"chat" | "voice", DrawnRow[][]> = (() => {
  const choice = unwrap(variableNamed(COMPOSER, "plusSections"));
  assert.ok(
    ts.isConditionalExpression(choice) && unwrap(choice.condition).getText() === "voiceActive",
    "plusSections is `voiceActive ? voice : chat`",
  );
  const groups = (surface: ts.Expression): DrawnRow[][] => {
    const list = unwrap(surface);
    assert.ok(ts.isArrayLiteralExpression(list), "a list of groups");
    return list.elements.map((group) => {
      const bare = unwrap(group);
      if (ts.isArrayLiteralExpression(bare)) return rowsOf(bare.elements, false);
      // `researchRow ? [researchRow] : []`: a group the composer leaves out.
      assert.ok(ts.isConditionalExpression(bare), `a group: ${bare.getText().slice(0, 80)}`);
      const present = unwrap(bare.whenTrue);
      assert.ok(ts.isArrayLiteralExpression(present), "the group's rows");
      return rowsOf(present.elements, true);
    });
  };
  return { voice: groups(choice.whenTrue), chat: groups(choice.whenFalse) };
})();

const rowByID = new Map(CONTRACT.composer.plusMenu.rows.map((row) => [row.id, row]));

test("the + menu's groups are the contract's, per surface, in order", () => {
  assert.deepEqual(
    Object.keys(CONTRACT.composer.plusMenu.groups).sort(),
    Object.keys(PLUS_SECTIONS).sort(),
    "the surfaces",
  );
  for (const [surface, groups] of Object.entries(PLUS_SECTIONS)) {
    assert.deepEqual(
      groups.map((group) => group.map((row) => row.id)),
      CONTRACT.composer.plusMenu.groups[surface],
      `the ${surface} composer's groups`,
    );
  }
});

test("each + menu row says, does and draws what the contract says, and is left out only where it says", () => {
  const seen = new Set<string>();
  for (const [surface, groups] of Object.entries(PLUS_SECTIONS)) {
    for (const row of groups.flat()) {
      const contract = rowByID.get(row.id);
      assert.ok(contract, `${surface}: the contract has a row "${row.id}"`);
      seen.add(row.id);
      assert.deepEqual(
        { label: row.label, kind: row.kind, icon: row.icon, optional: row.optional },
        { label: contract.label, kind: contract.kind, icon: contract.icon, optional: contract.optional ?? false },
        `${surface}: the ${row.id} row`,
      );
      if (row.alternate) {
        const alternate = rowByID.get(row.alternate.id);
        assert.ok(alternate, `the contract has the alternate "${row.alternate.id}"`);
        seen.add(alternate.id);
        assert.equal(alternate.variantOf, row.id, `${alternate.id} stands in for ${row.id}`);
        assert.equal(alternate.label, row.alternate.label, `${alternate.id}'s label`);
        assert.equal(alternate.kind, row.kind, `${alternate.id}'s kind`);
        assert.equal(alternate.icon, row.icon, `${alternate.id}'s icon`);
      }
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    CONTRACT.composer.plusMenu.rows.map((row) => row.id).sort(),
    "every contract row is drawn somewhere",
  );
});

test("the + menu's row kinds and its name are composer-plus-menu.tsx's", () => {
  const item = descendants(PLUS_MENU).find(
    (node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "PlusMenuItem",
  );
  assert.ok(item && ts.isUnionTypeNode(item.type), "PlusMenuItem is a union");
  const kinds = item.type.types.map((member) => {
    assert.ok(ts.isTypeLiteralNode(member), "each member is an object type");
    const kind = member.members.find(
      (field): field is ts.PropertySignature => ts.isPropertySignature(field) && field.name.getText() === "kind",
    );
    const literal = kind?.type;
    assert.ok(literal && ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal), "a literal kind");
    return literal.literal.text;
  });
  assert.deepEqual(kinds, CONTRACT.composer.plusMenu.rowKinds);

  // The menu's accessible name, when no compact panel is open.
  const content = elements(functionNamed(PLUS_MENU, "PlusMenu"), "DropdownMenuContent")[0];
  const name = unwrap(attribute(content, "aria-label") ?? ts.factory.createStringLiteral(""));
  const label = ts.isConditionalExpression(name) ? stringOf(name.whenFalse) : stringOf(name);
  assert.equal(label, CONTRACT.composer.plusMenu.label);
});

test("the primary action's faces, fills and glyphs are composer-shell.tsx's", () => {
  const faceType = descendants(COMPOSER_SHELL).find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "ComposerPrimaryFace",
  );
  assert.ok(faceType && ts.isUnionTypeNode(faceType.type), "ComposerPrimaryFace is a union");
  const faces = faceType.type.types.map((member) => {
    assert.ok(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal), "a literal face");
    return member.literal.text;
  });
  const contractFaces = CONTRACT.composer.primaryAction.faces;
  assert.deepEqual(faces, contractFaces.map((face) => face.id), "the faces, in order");

  const action = variableNamed(COMPOSER_SHELL, "ComposerPrimaryAction");
  const tests = descendants(action).filter(
    (node): node is ts.ConditionalExpression =>
      ts.isConditionalExpression(node) && /^face === "[a-z]+"$/.test(unwrap(node.condition).getText()),
  );
  const faceOf = (node: ts.ConditionalExpression) => unwrap(node.condition).getText().match(/"([a-z]+)"/)?.[1] ?? "";

  // The fill: `face === "voice" ? quiet : accent`, the accent being the primary fill.
  const fills = new Map<string, "accent" | "quiet">();
  const fillChoice = tests.find((node) => stringOf(node.whenTrue) !== undefined && stringOf(node.whenFalse) !== undefined);
  assert.ok(fillChoice, "one face picks the other fill");
  const accentWhenTrue = (stringOf(fillChoice.whenTrue) ?? "").split(/\s+/).includes("bg-primary");
  fills.set(faceOf(fillChoice), accentWhenTrue ? "accent" : "quiet");
  for (const face of faces) if (!fills.has(face)) fills.set(face, accentWhenTrue ? "quiet" : "accent");

  // The glyph: `face === "busy" ? <Loader2/> : face === "stop" ? <Square/> : …, else <Send/>`.
  const glyphs = new Map<string, string>();
  const firstGlyph = (node: ts.Node) =>
    descendants(node)
      .filter(ts.isJsxSelfClosingElement)
      .map((element) => tagName(element))
      .find(Boolean);
  const chain = tests.filter((node) => ts.isParenthesizedExpression(node.whenTrue) || ts.isJsxElement(unwrap(node.whenTrue)));
  for (const node of chain) {
    glyphs.set(faceOf(node), firstGlyph(node.whenTrue) ?? "");
    const rest = unwrap(node.whenFalse);
    if (!ts.isConditionalExpression(rest)) {
      const remaining = faces.filter((face) => !chain.some((link) => faceOf(link) === face));
      assert.equal(remaining.length, 1, "one face is the chain's last branch");
      glyphs.set(remaining[0], firstGlyph(rest) ?? "");
    }
  }

  for (const face of contractFaces) {
    assert.equal(fills.get(face.id), face.fill, `${face.id}'s fill`);
    assert.equal(glyphs.get(face.id), face.icon, `${face.id}'s glyph`);
  }

  // Which face each of the composer's states wears (`PRIMARY_FACES`).
  const table = unwrap(variableNamed(COMPOSER, "PRIMARY_FACES"));
  assert.ok(ts.isObjectLiteralExpression(table), "PRIMARY_FACES is an object literal");
  const states: Record<string, string> = {};
  for (const member of table.properties) {
    if (ts.isPropertyAssignment(member)) states[member.name.getText()] = stringOf(member.initializer) ?? "";
  }
  assert.deepEqual(states, CONTRACT.composer.primaryAction.states);
});

// ── Settings ────────────────────────────────────────────────────────────────

test("the Settings rail is settings-sections.ts's, in order, with its marks", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => ({ id: section.id, label: section.label })),
    CONTRACT.settings.sections.map(({ id, label }) => ({ id, label })),
  );
  for (const [index, section] of SETTINGS_SECTIONS.entries()) {
    assert.equal(section.icon, iconComponent(CONTRACT.settings.sections[index].icon), `${section.id}'s mark`);
  }
  assert.equal(DEFAULT_SETTINGS_SECTION, CONTRACT.settings.default);
  for (const section of CONTRACT.settings.sections) {
    const id = section.id as (typeof SETTINGS_SECTIONS)[number]["id"];
    assert.equal(
      settingsHref(id),
      id === CONTRACT.settings.default ? "/settings" : `/settings?section=${id}`,
      `${id}'s URL`,
    );
  }
});

test("the Settings aliases are settings-sections.ts's, every one", () => {
  const table = unwrap(variableNamed(SETTINGS, "ALIASES"));
  assert.ok(ts.isObjectLiteralExpression(table), "ALIASES is an object literal");
  const aliases: Record<string, string> = {};
  for (const member of table.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const key = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText();
    aliases[key] = stringOf(member.initializer) ?? "";
  }
  assert.deepEqual(aliases, CONTRACT.settings.aliases);
  // A web-only pane with the alias's name (Appearance) opens itself on the
  // web; the Mac, which has no such pane, still follows the contract's alias.
  const webOnly = new Set<string>(WEB_SETTINGS_SECTIONS.map((section) => section.id));
  for (const [alias, target] of Object.entries(CONTRACT.settings.aliases)) {
    assert.equal(resolveSettingsSection(alias), webOnly.has(alias) ? alias : target, `?section=${alias}`);
  }
  assert.equal(resolveSettingsSection("not-a-section"), CONTRACT.settings.default);
});

// ── Icons ───────────────────────────────────────────────────────────────────

/** The component an `icon` expression names: `AppIcons.library` or a bare `Scan`. */
function iconComponent(expression: string): unknown {
  const [registry, key] = expression.split(".");
  if (key !== undefined) {
    const table = (Registries as unknown as Record<string, Record<string, unknown> | undefined>)[registry];
    return table?.[key];
  }
  return (Icons as unknown as Record<string, unknown>)[registry];
}

test("every icon the contract names is a drawing the web ships", () => {
  const icons: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "icon" && typeof inner === "string") icons.push(inner);
        else walk(inner);
      }
    }
  };
  walk(CONTRACT);
  assert.ok(icons.length > 30, "the walk found the icons");
  for (const icon of icons) {
    assert.ok(iconComponent(icon), `${icon} is exported by src/lib/app-icons.ts or src/components/ui/icons.tsx`);
  }
});
