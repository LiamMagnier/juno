"use client";
import type { ComponentProps } from "react";
import type { SettingsContent } from "./settings";
export type CodeSettingsState = Omit<ComponentProps<typeof SettingsContent>, "pane" | "embedded">;
export function createCodeSettingsBridge() {
  let active: { owner: object; state: CodeSettingsState } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    get: () => active?.state ?? null,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(owner: object, state: CodeSettingsState) { active = { owner, state }; notify(); },
    clear(owner: object) { if (active?.owner === owner) { active = null; notify(); } },
  };
}
export const codeSettingsBridge = createCodeSettingsBridge();
