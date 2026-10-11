"use client";
import * as React from "react";
import "@/components/code/v2/code-v2.css";
import { SettingsContent, GenerationModelsGroup, CodeKeyboardGroup, type SettingsPane } from "@/components/code/v2/settings";
import { codeSettingsBridge } from "@/components/code/v2/settings-bridge";
import { SettingsGroup } from "@/components/settings/setting-row";
function CodeSection({ pane }: { pane: SettingsPane }) {
  const state = React.useSyncExternalStore(codeSettingsBridge.subscribe, codeSettingsBridge.get, () => null);
  if (!state) return <SettingsGroup><p className="py-4 text-ui text-muted-foreground">Open a Code session to change its {pane === "permissions" ? "permissions" : pane === "orchestration" ? "team and budget" : "work log"}. Changes apply to that session.</p>{pane === "general" && <div className="cv2 pb-4"><GenerationModelsGroup /></div>}</SettingsGroup>;
  return <div className="cv2"><SettingsContent {...state} pane={pane} embedded /></div>;
}
export function CodeSessionSection() { return <CodeSection pane="general" />; }
export function CodeAgentSection() { return <CodeSection pane="orchestration" />; }
export function CodePermissionsSection() { return <CodeSection pane="permissions" />; }
export function CodeKeyboardSection() { return <div className="cv2"><CodeKeyboardGroup /></div>; }
