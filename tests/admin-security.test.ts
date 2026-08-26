import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function routeFiles(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "route.ts")
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("the account menu derives Admin Panel visibility from the server bootstrap", () => {
  const menu = source("src/components/app/user-menu.tsx");
  const bootstrap = source("src/lib/app-data.ts");

  assert.match(bootstrap, /features:\s*\{[\s\S]*?isOwner:\s*isOwnerEmail\(user\.email\)/);
  assert.match(menu, /features\.isOwner\s*&&\s*\(/);
  assert.match(menu, /href="\/admin"/);
  assert.match(menu, /label="Admin Panel"/);
  assert.doesNotMatch(menu, /isOwnerEmail|OWNER_EMAILS/);
});

test("the complete Admin page tree has one fail-closed server layout", () => {
  const layout = source("src/app/(app)/admin/layout.tsx");
  const landing = source("src/app/(app)/admin/page.tsx");

  assert.match(layout, /await requireOwnerPage\(\)/);
  assert.match(landing, /await requireOwnerPage\(\)/);
  assert.match(landing, /redirect\("\/admin\/users"\)/);
});

test("every Admin API route checks the canonical owner policy", () => {
  const routes = routeFiles("src/app/api/admin");
  assert.ok(routes.length >= 9, `expected the Admin API surface, found ${routes.length} routes`);

  for (const absolutePath of routes) {
    const route = readFileSync(absolutePath, "utf8");
    const relativePath = path.relative(ROOT, absolutePath);
    assert.match(route, /import\s+\{\s*getOwnerUser\s*\}\s+from\s+"@\/lib\/admin"/, relativePath);
    assert.match(route, /const owner = await getOwnerUser\(\)/, relativePath);
    assert.match(
      route,
      /if \(!owner\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/,
      relativePath,
    );
  }
});

test("the canonical owner policy is authenticated and email-normalized", () => {
  const admin = source("src/lib/admin.ts");
  const owner = source("src/lib/owner.ts");

  assert.match(admin, /const user = await getCurrentUser\(\)/);
  assert.match(admin, /isOwnerEmail\(user\?\.email\)/);
  assert.match(admin, /const user = await requireUser\(\)/);
  assert.match(admin, /if \(!isOwnerEmail\(user\.email\)\) notFound\(\)/);
  assert.match(owner, /\.map\(\(s\) => s\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(owner, /list\.includes\(email\.toLowerCase\(\)\)/);
});
