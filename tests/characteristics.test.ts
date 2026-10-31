import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CHARACTERISTICS,
  CHARACTERISTIC_KEYS,
  CHARACTERISTIC_LEVELS,
  characteristicsPatch,
  characteristicsSystemPrompt,
  normalizeCharacteristics,
  type CharacteristicKey,
} from "@/lib/characteristics";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";
import { mutationOperationSchema } from "@/lib/sync-mutations";

/*
 * Tone characteristics (Settings > Personalization): five Less / Default /
 * More controls, each its own Settings column, each one short line in the
 * per-user tail of the system prompt. "default" everywhere must leave the
 * prompt exactly as it was before characteristics existed.
 */

const ROOT = path.resolve(__dirname, "..");
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const base = { memoryEnabled: true, canvas: true, voiceMode: false } as const;

test("every characteristic is in the list once, with a label, a description and both prompt lines", () => {
  assert.deepEqual(CHARACTERISTICS.map((c) => c.key), [...CHARACTERISTIC_KEYS]);
  assert.deepEqual([...CHARACTERISTIC_LEVELS], ["less", "default", "more"]);
  for (const c of CHARACTERISTICS) {
    assert.ok(c.label.trim() && c.description.trim(), c.key);
    assert.ok(c.prompt.less.trim() && c.prompt.more.trim(), c.key);
    assert.notEqual(c.prompt.less, c.prompt.more, c.key);
  }
});

test("all at default (or absent, or a row from before the columns) emits nothing", () => {
  assert.equal(characteristicsSystemPrompt(undefined), null);
  assert.equal(characteristicsSystemPrompt(null), null);
  assert.equal(characteristicsSystemPrompt({}), null);
  const allDefault = Object.fromEntries(CHARACTERISTIC_KEYS.map((key) => [key, "default"]));
  assert.equal(characteristicsSystemPrompt(allDefault), null);
  // The prompt builder's tail is byte-identical with and without the field.
  const without = buildSystemPromptSections({ ...base, personality: "concise", customInstructions: "Be brief." });
  const withDefaults = buildSystemPromptSections({
    ...base,
    personality: "concise",
    customInstructions: "Be brief.",
    characteristics: allDefault,
  });
  assert.equal(withDefaults.variable, without.variable);
  assert.equal(withDefaults.stable, without.stable);
  assert.doesNotMatch(withDefaults.variable, /Tone adjustments/);
});

for (const c of CHARACTERISTICS) {
  for (const level of ["less", "more"] as const) {
    test(`${c.key}=${level} adds exactly its own line`, () => {
      const section = characteristicsSystemPrompt({ [c.key]: level });
      assert.ok(section, "a non-default level emits a section");
      assert.ok(section.startsWith("# Tone adjustments\n"));
      const bullets = section.split("\n").filter((line) => line.startsWith("- "));
      assert.deepEqual(bullets, [`- ${c.prompt[level]}`]);
      // The other level of the same characteristic, and every other one, stay out.
      assert.ok(!section.includes(c.prompt[level === "less" ? "more" : "less"]));
      for (const other of CHARACTERISTICS.filter((o) => o.key !== c.key)) {
        assert.ok(!section.includes(other.prompt.less) && !section.includes(other.prompt.more), other.key);
      }
    });
  }
}

test("the section is scoped: tone only, never accuracy, capability or artifact content, below custom instructions", () => {
  const section = characteristicsSystemPrompt({ toneWarmth: "more", toneEmoji: "less" });
  assert.ok(section);
  assert.match(section, /tone and layout of your replies only/);
  assert.match(section, /never accuracy, never what you can do/);
  assert.match(section, /never the content of an artifact or document/);
  assert.match(section, /custom instructions take precedence over them/);
  // Short: a heading, one scope sentence and one line per moved control.
  assert.equal(section.split("\n").length, 2 + 2);
  // Lines follow the settings order, not the order of the object's keys.
  const lines = section.split("\n");
  assert.equal(lines[2], `- ${CHARACTERISTICS[0].prompt.more}`);
  assert.equal(lines[3], `- ${CHARACTERISTICS.find((c) => c.key === "toneEmoji")!.prompt.less}`);
});

test("an unknown stored level reads as default and injects nothing", () => {
  assert.equal(characteristicsSystemPrompt({ toneWarmth: "extreme", toneEmoji: 3, toneFormatting: null }), null);
  assert.deepEqual(
    normalizeCharacteristics({ toneWarmth: "extreme", toneEnthusiasm: "more" }),
    { toneWarmth: "default", toneEnthusiasm: "more", toneFormatting: "default", toneEmoji: "default", toneConciseness: "default" }
  );
  assert.deepEqual(normalizeCharacteristics(null), normalizeCharacteristics({}));
});

test("a voice turn drops the visual characteristics and keeps the rest", () => {
  const values: Partial<Record<CharacteristicKey, string>> = { toneFormatting: "more", toneEmoji: "more", toneConciseness: "more" };
  const spoken = characteristicsSystemPrompt(values, { voiceMode: true });
  assert.ok(spoken);
  assert.ok(spoken.includes(CHARACTERISTICS.find((c) => c.key === "toneConciseness")!.prompt.more));
  for (const visual of CHARACTERISTICS.filter((c) => c.visual)) {
    assert.ok(!spoken.includes(visual.prompt.more), visual.key);
  }
  // Only visual ones moved: nothing at all in voice, so no contradiction with "no Markdown".
  assert.equal(characteristicsSystemPrompt({ toneFormatting: "more", toneEmoji: "more" }, { voiceMode: true }), null);
  assert.deepEqual(
    CHARACTERISTICS.filter((c) => c.visual).map((c) => c.key),
    ["toneFormatting", "toneEmoji"]
  );
});

test("the prompt tail orders preset, then characteristics, then the user's own instructions", () => {
  const { stable, variable } = buildSystemPromptSections({
    ...base,
    personality: "formal",
    characteristics: { toneEmoji: "more" },
    customInstructions: "Never use emoji with me.",
  });
  const style = variable.indexOf("# Response style");
  const tone = variable.indexOf("# Tone adjustments");
  const custom = variable.indexOf("# The user's custom instructions");
  assert.ok(style >= 0 && tone > style && custom > tone, "preset < characteristics < custom instructions");
  // Per-user data never reaches the shared, cached head.
  assert.doesNotMatch(stable, /Tone adjustments/);
});

test("the settings row itself can be passed: only the tone columns are read", () => {
  const row = { id: "s1", userId: "u1", personality: "default", customInstructions: "", toneConciseness: "less", memoryEnabled: true };
  const { variable } = buildSystemPromptSections({ ...base, characteristics: row });
  assert.ok(variable.includes(CHARACTERISTICS.find((c) => c.key === "toneConciseness")!.prompt.less));
});

test("writes accept only the three levels, through the sync patch and the patch helper", () => {
  const ok = mutationOperationSchema.safeParse({ type: "settings.update", patch: { toneWarmth: "more", toneEmoji: "less" } });
  assert.ok(ok.success);
  for (const bad of ["extreme", "", "MORE", 1, null]) {
    const parsed = mutationOperationSchema.safeParse({ type: "settings.update", patch: { toneWarmth: bad } });
    assert.equal(parsed.success, false, JSON.stringify(bad));
  }
  assert.deepEqual(characteristicsPatch({ toneWarmth: "more", toneEmoji: undefined }), { toneWarmth: "more" });
  assert.deepEqual(characteristicsPatch({}), {});
});

test("every surface that carries settings carries all five columns", () => {
  const schema = source("prisma/schema.prisma");
  const settingsModel = schema.slice(schema.indexOf("model Settings {"), schema.indexOf("}", schema.indexOf("model Settings {")));
  const migration = source("prisma/migrations/20261101000300_settings_tone_characteristics/migration.sql");
  const route = source("src/app/api/settings/route.ts");
  const exportRoute = source("src/app/api/account/export/route.ts");
  const contract = source("contracts/openapi/juno-native-v1.yaml");
  for (const key of CHARACTERISTIC_KEYS) {
    assert.match(settingsModel, new RegExp(`\\b${key}\\s+String\\s+@default\\("default"\\)`), `schema ${key}`);
    assert.match(migration, new RegExp(`ADD COLUMN "${key}" TEXT NOT NULL DEFAULT 'default'`), `migration ${key}`);
    assert.match(route, new RegExp(`${key}: true`), `GET /api/settings selects ${key}`);
    assert.match(exportRoute, new RegExp(`${key}: true`), `export carries ${key}`);
    assert.match(contract, new RegExp(`${key}: \\{ \\$ref: '#/components/schemas/ToneCharacteristicLevel' \\}`), `contract ${key}`);
  }
  // The PATCH body and the sync patch share one validator; import validates too.
  assert.match(route, /\.\.\.CHARACTERISTIC_PATCH_FIELDS/);
  // Saved only while TONE_CHARACTERISTICS_ENABLED is on.
  assert.match(route, /\.\.\.\(isToneCharacteristicsEnabled\(\) \? characteristicsPatch\(d\) : \{\}\)/);
  assert.match(source("src/lib/sync-mutations.ts"), /\.\.\.CHARACTERISTIC_PATCH_FIELDS/);
  assert.match(source("src/lib/sync-entities.ts"), /\.\.\.normalizeCharacteristics\(row\)/);
  assert.match(source("src/app/api/import/route.ts"), /enumValue\(raw\[key\], CHARACTERISTIC_LEVELS\)/);
  // Both chat paths hand the row to the prompt builder, private chats
  // included, while TONE_CHARACTERISTICS_ENABLED is on; off, they hand nothing.
  for (const file of ["src/lib/chat/turn/prompt.ts", "src/lib/chat/turn/private-turn.ts"]) {
    assert.match(source(file), /characteristics: isToneCharacteristicsEnabled\(\) \? settings : null,/, file);
  }
});

test("the settings page draws one Less / Default / More control per characteristic on the shared primitive", () => {
  const page = source("src/components/settings/sections/personalization.tsx");
  assert.match(page, /import \{ SegmentedControl, type SegmentedOption \} from "@\/components\/ui\/segmented-control"/);
  assert.match(page, /\{ value: "less", label: "Less" \},\s*\{ value: "default", label: "Default" \},\s*\{ value: "more", label: "More" \}/);
  // Both the Settings pane and the Customize page render the list, each only
  // while the server has the characteristics on (TONE_CHARACTERISTICS_ENABLED).
  assert.equal(page.match(/CHARACTERISTICS\.map\(\(c\) =>/g)?.length, 2);
  assert.match(page, /const toneOn = features\.toneCharacteristics === true;/);
  assert.equal(page.match(/\{toneOn && \(/g)?.length, 2);
  assert.match(source("src/lib/app-data.ts"), /toneCharacteristics: isToneCharacteristicsEnabled\(\),/);
  // One field per write, tracked under its own key.
  assert.match(page, /saves\.track\(key, \(\) => save\(patch\)\)/);
});
