import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FEATURED_CATEGORY_COUNT,
  allAppsLabel,
  directoryPages,
  directoryView,
  splitDirectoryCategories,
} from "@/components/connections/directory-browse";

/*
 * The app directory reaches the whole Composio catalogue.
 *
 * The catalogue itself was never allowlisted: the catalog route hands the
 * person's search, category and cursor to Composio's REST listing and drops
 * only slugs that are unsafe as a path segment. What was limited was browsing:
 * the overview showed six featured categories, no chip row and no "Load more",
 * so twelve curated categories and every app outside a featured one could only
 * be found by guessing its name. The overview now ends in "All N apps" (the
 * whole catalogue, paged) and a way into every other category.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const categories = Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, label: `Category ${i}` }));

test("the overview features six categories and links to every other one", () => {
  const { featured, more } = splitDirectoryCategories(categories);
  assert.equal(FEATURED_CATEGORY_COUNT, 6);
  assert.deepEqual(featured.map((c) => c.id), ["c0", "c1", "c2", "c3", "c4", "c5"]);
  assert.equal(more.length, 12);
  // Nothing is lost between the two.
  assert.deepEqual([...featured, ...more], categories);
  assert.deepEqual(splitDirectoryCategories(categories.slice(0, 3)), { featured: categories.slice(0, 3), more: [] });
});

test("what the directory shows follows what the person asked for", () => {
  const base = { query: "", category: null, browseAll: false, composioConfigured: true };
  assert.equal(directoryView(base), "overview");
  assert.equal(directoryView({ ...base, browseAll: true }), "all");
  assert.equal(directoryView({ ...base, query: "  slack " }), "search");
  // Typing while browsing searches the whole catalogue; a category narrows it.
  assert.equal(directoryView({ ...base, browseAll: true, query: "sl" }), "search");
  assert.equal(directoryView({ ...base, browseAll: true, category: "crm" }), "category");
  assert.equal(directoryView({ ...base, query: "   " }), "overview", "whitespace is not a search");
  assert.equal(directoryView({ ...base, composioConfigured: false, browseAll: true }), "builtin");
});

test("every paged view pages; the showcase does not", () => {
  assert.equal(directoryPages("all"), true);
  assert.equal(directoryPages("search"), true);
  assert.equal(directoryPages("category"), true);
  assert.equal(directoryPages("overview"), false);
  assert.equal(directoryPages("builtin"), false);
});

test("the way into the whole catalogue says how big it is when the API does", () => {
  assert.equal(allAppsLabel(1048), "All 1,048 apps");
  assert.equal(allAppsLabel(undefined), "All apps");
  assert.equal(allAppsLabel(0), "All apps");
});

test("the directory uses the browse rule, keeps its featured sections and pages the full list", () => {
  const source = read("src/components/connections/connector-directory.tsx");
  assert.match(source, /from "@\/components\/connections\/directory-browse"/);
  assert.match(source, /directoryView\(\{ query, category: activeCategory, browseAll, composioConfigured \}\)/);
  // The featured sections are still the first page of each featured category.
  assert.match(source, /const picked = splitDirectoryCategories\(categories\)\.featured;/);
  assert.doesNotMatch(source, /categories\.slice\(0, 6\)/);
  // The way in, and the way back.
  assert.match(source, /onClick=\{\(\) => setBrowseAll\(true\)\}/);
  assert.match(source, /moreCategories\.map\(\(more\) =>[\s\S]*?setCategory\(more\.id\)/);
  assert.match(source, /setCategory\(null\);\s*setBrowseAll\(false\);/);
  // "Load more" for every paged view, the whole catalogue included.
  assert.match(source, /cursor && !loading && !error && \(directoryPages\(view\) \|\| !\(overview && sections\.length > 0\)\)/);
  // The size comes from the unfiltered listing only.
  assert.match(source, /if \(!query\.trim\(\) && !activeCategory && typeof data\.total === "number"\) setCatalogTotal\(data\.total\);/);
});

test("the catalogue is Composio's own listing: searched, categorised and paged, never allowlisted", () => {
  const route = read("src/app/api/connectors/composio/catalog/route.ts");
  assert.match(route, /listComposioApps\(user\.id, \{ query, cursor, connectedOnly, limit: 30, category \}\)/);
  const composio = read("src/lib/composio.ts");
  const list = composio.slice(composio.indexOf("export async function listComposioApps("));
  const body = list.slice(0, list.indexOf("\n}\n"));
  assert.match(body, /search: query \|\| undefined,/);
  assert.match(body, /category: options\.category \|\| undefined,/);
  assert.match(body, /cursor: options\.cursor \|\| undefined,/);
  assert.match(body, /cursor: page\.next_cursor \?\? undefined,/);
  assert.match(body, /total: page\.total_items \?\? undefined,/);
  // The only filter on what Composio returns: a slug that is safe as a path segment.
  assert.match(body, /if \(!slug \|\| !isComposioSlug\(slug\)\) return \[\];/);
  assert.doesNotMatch(body, /\.filter\(/);
});
