/**
 * The sequencing rules behind every optimistic settings write
 * (src/components/settings/save-ledger.ts), which `useSettingsSave` and the
 * Connectors policy both lean on.
 *
 * The case that broke: two changes in flight, both refused. Each write used
 * to roll back to what the control showed just before it, and for the second
 * write that was the FIRST change, still optimistic. So an account offline
 * for a moment kept an accent, a theme or a blocked app on screen that the
 * server never stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSaveLedger } from "@/components/settings/save-ledger";

type Key = "accent" | "theme";

/** A tiny stand-in for the settings object the ledger reads "shown" values from. */
function harness(initial: Record<Key, string>) {
  const shown = { ...initial };
  const ledger = createSaveLedger<Key>();
  const begin = (patch: Partial<Record<Key, string>>) => {
    const keys = Object.keys(patch) as Key[];
    const ticket = ledger.begin(keys, (key) => shown[key]);
    Object.assign(shown, patch);
    return { ticket, keys, patch };
  };
  const fail = (write: ReturnType<typeof begin>) => {
    const rollback = ledger.settle(write.ticket, write.keys, { ok: false });
    if (rollback) Object.assign(shown, rollback);
    return rollback;
  };
  const succeed = (write: ReturnType<typeof begin>) =>
    ledger.settle(write.ticket, write.keys, { ok: true, written: write.patch });
  return { shown, begin, fail, succeed };
}

test("a refused write goes back to what was shown before it", () => {
  const h = harness({ accent: "coral", theme: "system" });
  const write = h.begin({ accent: "teal" });
  assert.deepEqual(h.fail(write), { accent: "coral" });
  assert.equal(h.shown.accent, "coral");
});

test("two overlapping writes both refused end on the server's value, not the first change", () => {
  const h = harness({ accent: "coral", theme: "system" });
  const first = h.begin({ accent: "teal" });
  const second = h.begin({ accent: "violet" });
  assert.equal(h.fail(first), null, "the first failure is overtaken and must not move anything");
  assert.equal(h.shown.accent, "violet");
  assert.deepEqual(h.fail(second), { accent: "coral" }, "the newest failure restores what the server holds");
  assert.equal(h.shown.accent, "coral");
});

test("an older failure never undoes a newer write the server accepted", () => {
  const h = harness({ accent: "coral", theme: "system" });
  const first = h.begin({ accent: "teal" });
  const second = h.begin({ accent: "violet" });
  assert.equal(h.fail(first), null);
  assert.equal(h.succeed(second), null);
  assert.equal(h.shown.accent, "violet");
});

test("a newer failure goes back to an older write the server accepted", () => {
  const h = harness({ accent: "coral", theme: "system" });
  const first = h.begin({ accent: "teal" });
  const second = h.begin({ accent: "violet" });
  h.succeed(first);
  assert.deepEqual(h.fail(second), { accent: "teal" });
});

test("a write that touched several fields gives back only the ones no newer write owns", () => {
  const h = harness({ accent: "coral", theme: "system" });
  const both = h.begin({ accent: "teal", theme: "dark" });
  h.begin({ theme: "light" });
  assert.deepEqual(h.fail(both), { accent: "coral" }, "theme belongs to the newer write");
  assert.equal(h.shown.theme, "light");
});

test("once everything has settled, the next write takes the shown value as confirmed again", () => {
  const h = harness({ accent: "coral", theme: "system" });
  h.succeed(h.begin({ accent: "teal" }));
  // Something outside the ledger moved the value (a sync from another device).
  h.shown.accent = "amber";
  assert.deepEqual(h.fail(h.begin({ accent: "sage" })), { accent: "amber" });
});

test("the theme and accent repaint only through a rollback, never on every failure", () => {
  // next-themes' theme and the root's data-accent are not driven by the
  // settings object, so General mirrors the ledger's decision into them via
  // `onRollback`. Repainting on every refusal is what let an overtaken
  // failure paint the page in a value a newer write had already replaced.
  const general = fs.readFileSync(path.join(process.cwd(), "src/components/settings/sections/general.tsx"), "utf8");
  assert.ok(!/if \(!ok\) setTheme\(/.test(general), "no unconditional theme repaint on failure");
  assert.ok(!/if \(!ok\) document\.documentElement\.dataset\.accent/.test(general), "no unconditional accent repaint");
  assert.equal((general.match(/onRollback:/g) ?? []).length, 2, "theme and accent both repaint through onRollback");

  const connectors = fs.readFileSync(
    path.join(process.cwd(), "src/components/settings/sections/connectors.tsx"),
    "utf8"
  );
  assert.ok(/createSaveLedger<"policy">\(\)/.test(connectors), "the connector policy rolls back through the ledger");
});
