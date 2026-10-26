import assert from "node:assert/strict";
import test from "node:test";
import { createCodeSettingsBridge, type CodeSettingsState } from "@/components/code/v2/settings-bridge";
import { SETTINGS_GROUPS, ALL_SETTINGS_SECTIONS, resolveSettingsSection } from "@/components/settings/settings-sections";

test("unified settings includes every section once and resolves Remote and Coding links", () => {
  const ids = SETTINGS_GROUPS.flatMap(group => group.ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), new Set(ALL_SETTINGS_SECTIONS.map(section => section.id)));
  // Appearance is General's now (the contract's alias), Remote is Devices',
  // and Connections, Agents and Permissions are the one Code section's.
  for (const [input, expected] of [["appearance", "general"], ["remote", "devices"], ["connections", "code"], ["code", "code"], ["code-agent", "code"], ["code-permissions", "code"]]) {
    assert.equal(resolveSettingsSection(input), expected);
  }
});

test("settings keeps the current session controls when an older workspace unmounts", () => {
  const bridge = createCodeSettingsBridge();
  const first = {}, second = {};
  let permission: string | null = null;
  const state = { runtimeMode: "ask", onRuntimeMode: (mode: string) => { permission = mode; } } as unknown as CodeSettingsState;
  let updates = 0;
  const unsubscribe = bridge.subscribe(() => { updates += 1; });
  bridge.publish(first, state);
  bridge.publish(second, state);
  bridge.clear(first);
  assert.equal(bridge.get(), state);
  bridge.get()?.onRuntimeMode?.("full");
  assert.equal(permission, "full");
  assert.equal(updates, 2);
  bridge.clear(second);
  assert.equal(bridge.get(), null);
  unsubscribe();
});
