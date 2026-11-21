import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_DESIGNS, parseDesignPreset, validateDesignPreset } from "@/lib/design-presets";

test("each built-in look round-trips through the same format as a shared look", () => {
  for (const preset of BUILT_IN_DESIGNS) {
    assert.deepEqual(parseDesignPreset(JSON.stringify(preset)), preset);
  }
});

test("design codes accept a custom accent and trim the display name", () => {
  const preset = { ...BUILT_IN_DESIGNS[0], name: "  My design  ", accent: "#124abc" };
  assert.deepEqual(parseDesignPreset(JSON.stringify(preset)), { ...preset, name: "My design" });
});

test("design codes accept only the documented appearance fields", () => {
  const valid = BUILT_IN_DESIGNS[0];
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, name: "a\nb" },
    { ...valid, accent: "url(data:text/html,example)" },
    { ...valid, theme: "sepia" },
    { ...valid, composerShape: "100vh" },
    { ...valid, preferences: { voiceSounds: false } },
    { ...valid, css: "body { display: none; }" },
  ]) assert.equal(validateDesignPreset(invalid), null);
  assert.equal(parseDesignPreset('{"name":'), null);
  assert.equal(parseDesignPreset(" ".repeat(2049)), null);
});
