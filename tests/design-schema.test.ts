import assert from "node:assert/strict";
import test from "node:test";

import { DesignValidationError, parseDesignDocument, validateHierarchy } from "../src/lib/design/schema";
import { migrateDesignDocument, parseStoredDesignDocument, readSchemaVersion, serializeDesignDocument } from "../src/lib/design/migrations";
import { applyBoundVariables, exportTokens, hexToRgba, isBindable, resolveVariable, rgbaToHex } from "../src/lib/design/variables";
import type { DesignDocument, Rgba } from "../src/lib/design/types";
import { run, signInDocument, withTokens } from "./design-fixtures";

/** Resolve a colour variable to a hex string, failing the test if it does not
 *  resolve — so a regression reads as "unresolved", not as a silent default. */
function hexOf(doc: DesignDocument, variableId: string): string {
  const resolved = resolveVariable(doc, variableId);
  assert.ok(resolved.ok, `expected ${variableId} to resolve`);
  assert.equal(typeof resolved.value, "object");
  return rgbaToHex(resolved.value as Rgba);
}

test("a well-formed document decodes and re-encodes identically", () => {
  const doc = signInDocument();
  const json = serializeDesignDocument(doc);
  assert.equal(serializeDesignDocument(parseStoredDesignDocument(json)), json);
});

test("serialization is stable regardless of key insertion order", () => {
  const doc = signInDocument();
  const shuffled = JSON.parse(JSON.stringify(doc));
  const reordered = { updatedAt: shuffled.updatedAt, nodes: shuffled.nodes, ...shuffled };
  assert.equal(serializeDesignDocument(reordered), serializeDesignDocument(doc));
});

test("a document from a newer schema is refused with an honest message", () => {
  const doc = { ...signInDocument(), schemaVersion: 99 };
  assert.throws(() => migrateDesignDocument(doc), /newer version of Juno/);
});

test("non-documents are rejected rather than coerced", () => {
  assert.throws(() => migrateDesignDocument({ hello: "world" }), DesignValidationError);
  assert.throws(() => parseStoredDesignDocument("not json"), /not valid JSON/);
  assert.equal(readSchemaVersion({ schemaVersion: 1 }), 1);
  assert.equal(readSchemaVersion({ schemaVersion: "1" }), 0);
  assert.equal(readSchemaVersion(null), 0);
});

test("hierarchy validation catches every structural lie", () => {
  const base = signInDocument();

  const orphan = JSON.parse(JSON.stringify(base));
  orphan.nodes["title"].parentId = "screen"; // still listed under card
  assert.ok(validateHierarchy(orphan).some((i) => i.includes("claims parent")));

  const missing = JSON.parse(JSON.stringify(base));
  missing.nodes["card"].children.push("nope");
  assert.ok(validateHierarchy(missing).some((i) => i.includes("missing child")));

  const cycle = JSON.parse(JSON.stringify(base));
  cycle.nodes["screen"].parentId = "card";
  assert.ok(validateHierarchy(cycle).some((i) => i.includes("own ancestor") || i.includes("orphaned")));

  const duplicated = JSON.parse(JSON.stringify(base));
  duplicated.nodes["screen"].children.push("title");
  assert.ok(validateHierarchy(duplicated).some((i) => i.includes("more than one parent")));
});

test("parseDesignDocument refuses an invalid hierarchy", () => {
  const broken = JSON.parse(JSON.stringify(signInDocument()));
  broken.nodes["card"].children.push("ghost");
  assert.throws(() => parseDesignDocument(broken), /hierarchy is invalid/);
});

test("out-of-range and unknown fields are rejected", () => {
  const doc = JSON.parse(JSON.stringify(signInDocument()));
  doc.nodes["card"].opacity = 4;
  assert.throws(() => parseDesignDocument(doc), DesignValidationError);
});

test("prototype URLs are restricted to http(s)", () => {
  const doc = signInDocument();
  assert.throws(
    () =>
      run(doc, [
        {
          op: "createInteraction",
          interaction: {
            id: "int1",
            sourceNodeId: "button",
            trigger: { type: "click" },
            action: { type: "open-url", url: "javascript:alert(1)" },
            transition: { kind: "instant", durationMs: 0, delayMs: 0, easing: { type: "linear" }, matchStableIds: false },
          },
        },
      ]),
    /http\(s\) only/
  );
});

test("asset URLs must be app-relative or inline data", () => {
  const doc = JSON.parse(JSON.stringify(signInDocument()));
  doc.assets["a1"] = { id: "a1", kind: "image", url: "https://evil.example/x.png", width: 10, height: 10, mimeType: "image/png" };
  assert.throws(() => parseDesignDocument(doc), DesignValidationError);
  doc.assets["a1"].url = "/uploads/x.png";
  assert.doesNotThrow(() => parseDesignDocument(doc));
});

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

test("variables resolve per mode and follow aliases", () => {
  const doc = withTokens(signInDocument());

  assert.equal(hexOf(doc, "var-primary"), "#334de6");
  assert.equal(hexOf(doc, "var-accent"), "#334de6", "the alias resolves to its target");

  const dark = run(doc, [{ op: "setVariableMode", collectionId: "col1", modeId: "dark" }]).document;
  assert.equal(hexOf(dark, "var-primary"), "#8099ff");
});

test("a mode a variable does not declare inherits the collection default", () => {
  const doc = run(withTokens(signInDocument()), [{ op: "setVariableMode", collectionId: "col1", modeId: "dark" }]).document;
  const accent = resolveVariable(doc, "var-accent");
  assert.ok(accent.ok, "accent has no Dark value, so it falls back to its first mode");
});

test("an alias cycle is reported, not followed forever", () => {
  const doc = JSON.parse(JSON.stringify(withTokens(signInDocument())));
  doc.variables["var-primary"].valuesByMode["light"] = { kind: "alias", value: "var-accent" };
  const result = resolveVariable(doc, "var-accent");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "alias-cycle");
});

test("a missing variable resolves to a stated failure, not a default", () => {
  const doc = withTokens(signInDocument());
  const result = resolveVariable(doc, "does-not-exist");
  assert.deepEqual(result, { ok: false, reason: "missing-variable" });
});

test("binding a variable changes what renders without rewriting the node", () => {
  let doc = withTokens(signInDocument());
  doc = run(doc, [{ op: "bindVariable", nodeId: "button", property: "fills.0.color", variableId: "var-primary" }]).document;

  const authored = doc.nodes["button"].fills[0];
  assert.equal(authored.type === "solid" ? rgbaToHex(authored.color) : "", "#334de6");

  const dark = run(doc, [{ op: "setVariableMode", collectionId: "col1", modeId: "dark" }]).document;
  const stored = dark.nodes["button"].fills[0];
  assert.equal(stored.type === "solid" ? rgbaToHex(stored.color) : "", "#334de6", "the stored value is untouched");

  const resolved = applyBoundVariables(dark, dark.nodes["button"]);
  const painted = resolved.fills[0];
  assert.equal(painted.type === "solid" ? rgbaToHex(painted.color) : "", "#8099ff", "rendering follows the mode");
});

test("binding a variable to a nonexistent variable is refused", () => {
  const doc = withTokens(signInDocument());
  assert.throws(() => run(doc, [{ op: "bindVariable", nodeId: "button", property: "fills.0.color", variableId: "ghost" }]), /No variable/);
});

test("bindable paths are typed", () => {
  assert.ok(isBindable("color", "fills.0.color"));
  assert.ok(!isBindable("boolean", "cornerRadius"));
  assert.ok(isBindable("number", "cornerRadius"));
});

test("tokens export by name with modes and aliases preserved", () => {
  const exported = exportTokens(withTokens(signInDocument()));
  assert.equal(exported.version, 1);
  const theme = exported.collections.find((c) => c.name === "Theme")!;
  assert.deepEqual(theme.modes, ["Light", "Dark"]);
  const accent = theme.tokens.find((t) => t.name === "accent")!;
  assert.deepEqual(accent.values.Light, { alias: "primary" });
});

test("hex round-trips through rgba", () => {
  assert.deepEqual(hexToRgba("#ff0000"), { r: 1, g: 0, b: 0, a: 1 });
  assert.equal(rgbaToHex(hexToRgba("#12345678")!), "#12345678");
  assert.equal(hexToRgba("nope"), null);
});
