/**
 * The web/native parity ledger.
 *
 *   node scripts/parity-ledger.mjs           # write docs/native/PARITY_MATRIX.md
 *   node scripts/parity-ledger.mjs --check   # verify; exit 1 on any gap
 *   node scripts/parity-ledger.mjs --seed    # print unclassified entries as JSON to paste in
 *
 * contracts/parity/features.json classifies every `src/app/api/**\/route.ts`
 * and every `src/app/(app)/**\/page.tsx` under a feature. The check fails when
 * a route or page exists that the ledger does not list (a web change nobody
 * weighed for native), when the ledger lists one that no longer exists, and
 * when a route's status disagrees with the Swift: a route marked `native` must
 * be named by a Swift string literal (or carry `swift` evidence saying where
 * the path is built), and a route the Swift names cannot be marked anything
 * else (unless `ignoreSwift` says why the match is wrong).
 *
 * docs/native/PARITY_MATRIX.md is this ledger's output; the hand-written
 * matrix it replaced is in docs/native/archive/.
 *
 * MACOS_LIQUID_GLASS_REDESIGN.md §A4.5 and §11 Phase 6.4.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const LEDGER = "contracts/parity/features.json";
const MATRIX = "docs/native/PARITY_MATRIX.md";
const ARCHIVE = "docs/native/archive/PARITY_MATRIX_2026-09-08.md";

const ROUTE_STATUSES = {
  native: "A Swift app calls it today (the Swift string literal is found, or `swift` says where the path is built).",
  planned: "Native should call it and does not yet; the note names the gap.",
  "web-only": "Only the web calls it, by decision (browser sign-in, admin, a web-only surface); the note says why.",
  internal: "No client UI calls it: webhooks, cron, runners, relays and other server-to-server endpoints.",
};
const PAGE_STATUSES = {
  native: "The app has the page, to web parity.",
  partial: "The app has it with known gaps (the note names them).",
  planned: "Not in the app yet; it should be.",
  "web-only": "Web only, by decision; the note says why.",
};

// ---------------------------------------------------------------------------
// The web's routes and pages.
// ---------------------------------------------------------------------------

function walk(directory, visit) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, visit);
    else visit(path);
  }
}

const urlOf = (file, leaf) =>
  "/" +
  relative(join(root, "src/app"), file)
    .split(sep)
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .join("/")
    .replace(new RegExp(`/?${leaf}$`), "");

const routes = new Map();
walk(join(root, "src/app/api"), (file) => {
  if (!file.endsWith(`${sep}route.ts`)) return;
  const source = readFileSync(file, "utf8");
  const methods = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) methods.add(match[1]);
  for (const match of source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) methods.add(match[1]);
  // `export { handler as GET }` and `export const { GET, POST } = handlers`.
  for (const block of source.matchAll(/export\s*(?:const\s*)?\{([^}]*)\}/g)) {
    for (const match of block[1].matchAll(/\b(?:as\s+)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) methods.add(match[1]);
  }
  const order = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  routes.set(urlOf(file, ""), {
    file: relative(root, file),
    methods: [...methods].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  });
});

const pages = new Map();
walk(join(root, "src/app/(app)"), (file) => {
  if (!file.endsWith(`${sep}page.tsx`)) return;
  const url = urlOf(file, "") || "/";
  pages.set(url, { file: relative(root, file) });
});

// ---------------------------------------------------------------------------
// Where the Swift names a route. String literals only, outside comments, in
// app and package sources (never tests: their fixtures name paths nobody
// calls). An interpolation `\(…)` stands for one dynamic segment.
// ---------------------------------------------------------------------------

function swiftFiles() {
  const files = [];
  const skip = (name) => name === "Tests" || name === "UITests" || name.endsWith("Tests") || name === ".build" || name === "node_modules" || name === "desktop-electron" || name === "JunoPreviewSupport";
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (!skip(name)) visit(path);
      } else if (name.endsWith(".swift")) files.push(path);
    }
  };
  visit(join(root, "native"));
  return files;
}

function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"' && source[cursor] !== "\n") {
        if (source[cursor] === "\\" && source[cursor + 1] === "(") {
          let depth = 0;
          cursor += 1;
          for (; cursor < source.length; cursor += 1) {
            if (source[cursor] === "(") depth += 1;
            else if (source[cursor] === ")") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          cursor += 1;
        } else cursor += source[cursor] === "\\" ? 2 : 1;
      }
      out += source.slice(index, cursor + 1);
      index = cursor + 1;
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

function interpolationsToPlaceholders(literal) {
  let out = "";
  for (let index = 0; index < literal.length; index += 1) {
    if (literal[index] === "\\" && literal[index + 1] === "(") {
      let depth = 0;
      index += 1;
      for (; index < literal.length; index += 1) {
        if (literal[index] === "(") depth += 1;
        else if (literal[index] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out += "{}";
    } else out += literal[index];
  }
  return out;
}

function swiftPaths() {
  const found = [];
  for (const file of swiftFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
      // `"/api/…"` anywhere in the literal, or a relative `"api/…"` handed to
      // `URL.appending(path:)`.
      const raw = match[1].startsWith("api/") ? `/${match[1]}` : match[1];
      const at = raw.indexOf("/api/");
      if (at === -1) continue;
      const path = interpolationsToPlaceholders(raw.slice(at)).split(/[?#]/)[0];
      found.push({ path, file: relative(root, file) });
    }
  }
  return found;
}

const segmentsOf = (path) => path.split("/").filter((segment, index) => index > 0 || segment !== "");

/** Static-to-static matches for this literal against this route, or -1 when it does not match. */
function matchScore(literal, route) {
  const prefix = literal.endsWith("/");
  const left = segmentsOf(prefix ? literal.slice(0, -1) : literal);
  const right = segmentsOf(route);
  let score = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const segment = right[j];
    const dynamic = segment.startsWith("[");
    if (/^\[\[?\.\.\./.test(segment)) {
      // A catch-all takes the rest of the literal.
      return score;
    }
    if (dynamic) {
      i += 1;
      j += 1;
      continue;
    }
    if (left[i] !== segment) return -1;
    score += 1;
    i += 1;
    j += 1;
  }
  if (i < left.length) return -1;
  if (j === right.length) return prefix ? -1 : score;
  // The literal is shorter than the route.
  const next = right[j];
  if (/^\[\[\.\.\./.test(next) && j === right.length - 1) return score;
  if (prefix && next.startsWith("[")) return score;
  return -1;
}

function swiftEvidence() {
  const evidence = new Map();
  const urls = [...routes.keys()];
  for (const { path, file } of swiftPaths()) {
    let best = -1;
    let hits = [];
    for (const url of urls) {
      const score = matchScore(path, url);
      if (score < 0) continue;
      if (score > best) {
        best = score;
        hits = [url];
      } else if (score === best) hits.push(url);
    }
    for (const url of hits) {
      if (!evidence.has(url)) evidence.set(url, new Set());
      evidence.get(url).add(file);
    }
  }
  return evidence;
}

const moduleOf = (file) => {
  const parts = file.split("/");
  const sources = parts.indexOf("Sources");
  if (sources !== -1) return parts[sources + 1];
  if (parts[1] === "macOS" || parts[1] === "iOS") return parts[2];
  return parts[1];
};

// ---------------------------------------------------------------------------
// Check the ledger.
// ---------------------------------------------------------------------------

const ledger = JSON.parse(readFileSync(join(root, LEDGER), "utf8"));
const errors = [];
const routeEntries = new Map();
const pageEntries = new Map();
const evidence = swiftEvidence();

for (const feature of ledger.features) {
  if (!feature.id || !feature.title) errors.push(`A feature needs an id and a title: ${JSON.stringify(feature).slice(0, 80)}`);
  for (const [url, raw] of Object.entries(feature.routes ?? {})) {
    const entry = typeof raw === "string" ? { status: raw } : raw;
    if (routeEntries.has(url)) errors.push(`${url} is listed twice (${routeEntries.get(url).feature} and ${feature.id})`);
    routeEntries.set(url, { ...entry, feature: feature.id });
    if (!Object.hasOwn(ROUTE_STATUSES, entry.status)) errors.push(`${url}: "${entry.status}" is not one of ${Object.keys(ROUTE_STATUSES).join(", ")}`);
    if (!routes.has(url)) {
      errors.push(`${url} is in the ledger but there is no src/app${url}/route.ts: remove it from ${LEDGER}`);
      continue;
    }
    const seen = evidence.get(url);
    if (entry.status === "native" && !seen && !entry.swift) {
      errors.push(`${url} is "native" but no Swift string literal names it: add \`swift\` saying where the path is built, or reclassify`);
    }
    if (entry.status !== "native" && seen && !entry.ignoreSwift) {
      errors.push(`${url} is "${entry.status}" but the Swift calls it (${[...seen].join(", ")}): mark it native, or add \`ignoreSwift\` saying why the match is wrong`);
    }
    if ((entry.status === "planned" || entry.status === "web-only") && !entry.note) {
      errors.push(`${url} is "${entry.status}" and needs a note saying why`);
    }
  }
  for (const [url, entry] of Object.entries(feature.pages ?? {})) {
    if (pageEntries.has(url)) errors.push(`page ${url} is listed twice (${pageEntries.get(url).feature} and ${feature.id})`);
    pageEntries.set(url, { ...entry, feature: feature.id });
    for (const platform of ["mac", "ios"]) {
      if (!Object.hasOwn(PAGE_STATUSES, entry[platform])) {
        errors.push(`page ${url}: ${platform} "${entry[platform]}" is not one of ${Object.keys(PAGE_STATUSES).join(", ")}`);
      }
    }
    if (!pages.has(url)) errors.push(`page ${url} is in the ledger but there is no page.tsx for it under src/app/(app): remove it from ${LEDGER}`);
    if ([entry.mac, entry.ios].some((status) => status !== "native") && !entry.note) {
      errors.push(`page ${url} is not native on both platforms and needs a note saying what is missing or why`);
    }
  }
}

const unclassifiedRoutes = [...routes.keys()].filter((url) => !routeEntries.has(url));
const unclassifiedPages = [...pages.keys()].filter((url) => !pageEntries.has(url));
for (const url of unclassifiedRoutes) {
  errors.push(`${url} (${routes.get(url).file}) is not in ${LEDGER}: classify it under a feature as ${Object.keys(ROUTE_STATUSES).join(", ")}`);
}
for (const url of unclassifiedPages) {
  errors.push(`page ${url} (${pages.get(url).file}) is not in ${LEDGER}: classify it under a feature`);
}

if (process.argv.includes("--seed")) {
  const seed = {
    routes: Object.fromEntries(
      unclassifiedRoutes.map((url) => [url, { status: evidence.has(url) ? "native" : "?", methods: routes.get(url).methods, swift: [...(evidence.get(url) ?? [])] }]),
    ),
    pages: Object.fromEntries(unclassifiedPages.map((url) => [url, { mac: "?", ios: "?" }])),
  };
  console.log(JSON.stringify(seed, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Render the matrix.
// ---------------------------------------------------------------------------

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (text) => `\`${text}\``;
const statusWord = { native: "Native", partial: "Partial", planned: "Planned", "web-only": "Web only", internal: "Internal" };

function render() {
  const lines = [];
  const count = (entries, key, value) => entries.filter((entry) => entry[key] === value).length;
  const allRoutes = [...routeEntries.values()];
  const allPages = [...pageEntries.values()];

  lines.push("# Juno native parity matrix");
  lines.push("");
  lines.push(
    `Generated by \`npm run native:parity\` from [\`${LEDGER}\`](../../${LEDGER}); do not edit by hand. \`npm run native:parity:check\` fails when a web route or page is not in the ledger, when the ledger names one that is gone, when a route marked native is not called by any Swift source, or when the Swift calls a route marked anything else. The hand-written matrix this replaces (history to 2026-09-08) is [\`${ARCHIVE.replace("docs/native/", "")}\`](${ARCHIVE.replace("docs/native/", "")}).`,
  );
  lines.push("");
  lines.push(
    "The chat request and its stream are classified field by field in [`contracts/chat/juno-chat-wire-v1.schema.json`](../../contracts/chat/juno-chat-wire-v1.schema.json) (`npm run native:wire:check`), and every deliberate design difference is registered in [`WEB_TO_NATIVE_DESIGN.md`](WEB_TO_NATIVE_DESIGN.md#register-of-deliberate-differences).",
  );
  lines.push("");
  lines.push("## Legend");
  lines.push("");
  lines.push("Routes (`src/app/api/**/route.ts`):");
  lines.push("");
  for (const [status, meaning] of Object.entries(ROUTE_STATUSES)) lines.push(`- **${statusWord[status]}.** ${meaning}`);
  lines.push("");
  lines.push("Pages (`src/app/(app)/**/page.tsx`), per app (Mac, iPhone and iPad):");
  lines.push("");
  for (const [status, meaning] of Object.entries(PAGE_STATUSES)) lines.push(`- **${statusWord[status]}.** ${meaning}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `${allRoutes.length} routes: ${count(allRoutes, "status", "native")} native, ${count(allRoutes, "status", "planned")} planned, ${count(allRoutes, "status", "web-only")} web only, ${count(allRoutes, "status", "internal")} internal. ${allPages.length} pages: on the Mac ${count(allPages, "mac", "native")} native, ${count(allPages, "mac", "partial")} partial, ${count(allPages, "mac", "planned")} planned, ${count(allPages, "mac", "web-only")} web only; on iOS ${count(allPages, "ios", "native")} native, ${count(allPages, "ios", "partial")} partial, ${count(allPages, "ios", "planned")} planned, ${count(allPages, "ios", "web-only")} web only.`,
  );
  lines.push("");
  lines.push("| Feature | Pages (Mac) | Pages (iOS) | Routes native | Planned | Web only | Internal |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const feature of ledger.features) {
    const featurePages = Object.values(feature.pages ?? {});
    const featureRoutes = Object.values(feature.routes ?? {}).map((raw) => (typeof raw === "string" ? { status: raw } : raw));
    const pageCell = (platform) =>
      featurePages.length
        ? `${featurePages.filter((page) => page[platform] === "native").length}/${featurePages.length}` +
          (featurePages.some((page) => page[platform] === "partial") ? ` (+${featurePages.filter((page) => page[platform] === "partial").length} partial)` : "")
        : "–";
    lines.push(
      `| [${cell(feature.title)}](#${feature.id}) | ${pageCell("mac")} | ${pageCell("ios")} | ${count(featureRoutes, "status", "native")} | ${count(featureRoutes, "status", "planned")} | ${count(featureRoutes, "status", "web-only")} | ${count(featureRoutes, "status", "internal")} |`,
    );
  }
  for (const feature of ledger.features) {
    lines.push("");
    lines.push(`<a id="${feature.id}"></a>`);
    lines.push("");
    lines.push(`## ${feature.title}`);
    if (feature.note) {
      lines.push("");
      lines.push(feature.note);
    }
    const featurePages = Object.entries(feature.pages ?? {});
    if (featurePages.length) {
      lines.push("");
      lines.push("| Page | Mac | iOS | Native screen | Note |");
      lines.push("|---|---|---|---|---|");
      for (const [url, entry] of featurePages) {
        lines.push(`| ${code(url)} | ${statusWord[entry.mac] ?? entry.mac} | ${statusWord[entry.ios] ?? entry.ios} | ${cell(entry.screen ?? "")} | ${cell(entry.note ?? "")} |`);
      }
    }
    const featureRoutes = Object.entries(feature.routes ?? {});
    if (featureRoutes.length) {
      lines.push("");
      lines.push("| Route | Methods | Status | Called from | Note |");
      lines.push("|---|---|---|---|---|");
      for (const [url, raw] of featureRoutes) {
        const entry = typeof raw === "string" ? { status: raw } : raw;
        const modules = [...new Set([...(evidence.get(url) ?? [])].map(moduleOf))].sort();
        const from = entry.status === "native" ? (modules.length ? modules.join(", ") : cell(entry.swift)) : "";
        lines.push(`| ${code(url)} | ${(routes.get(url)?.methods ?? []).join(", ")} | ${statusWord[entry.status] ?? entry.status} | ${from} | ${cell(entry.note ?? "")} |`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

const rendered = render();
if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(join(root, MATRIX), "utf8");
  } catch {
    errors.push(`${MATRIX} is missing. Run: npm run native:parity`);
  }
  if (existing && existing !== rendered && !errors.length) errors.push(`${MATRIX} is out of date. Run: npm run native:parity`);
  if (errors.length) {
    for (const error of errors) console.error(`[parity] ${error}`);
    process.exit(1);
  }
  const statusCounts = Object.keys(ROUTE_STATUSES).map((status) => `${[...routeEntries.values()].filter((entry) => entry.status === status).length} ${status}`);
  console.log(`[parity] ${routes.size} routes (${statusCounts.join(", ")}) and ${pages.size} pages classified; ${MATRIX} up to date`);
} else {
  if (errors.length) {
    for (const error of errors) console.error(`[parity] ${error}`);
    console.error(`[parity] ${MATRIX} not written: fix the ledger first`);
    process.exit(1);
  }
  writeFileSync(join(root, MATRIX), rendered);
  console.log(`[parity] wrote ${MATRIX}`);
}
