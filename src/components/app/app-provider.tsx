"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import type { AppBootstrap, AppUser, ClientFolder, ClientSettings } from "@/types/app";
import type { ClientConversation, ClientQuota } from "@/types/chat";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

interface AppContextValue {
  user: AppUser;
  settings: ClientSettings;
  features: AppBootstrap["features"];
  quota: ClientQuota;
  conversations: ClientConversation[];
  folders: ClientFolder[];
  models: ModelInfo[];
  setQuota: (q: ClientQuota) => void;
  setSettings: (patch: Partial<ClientSettings>) => void;
  upsertConversation: (c: ClientConversation) => void;
  updateConversation: (id: string, patch: Partial<ClientConversation>) => void;
  removeConversation: (id: string) => void;
  setConversations: (c: ClientConversation[]) => void;
  setFolders: (f: ClientFolder[]) => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  // mobile sidebar
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const AppContext = React.createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export function AppProvider({ bootstrap, children }: { bootstrap: AppBootstrap; children: React.ReactNode }) {
  const [settings, setSettingsState] = React.useState(bootstrap.settings);
  const [quota, setQuota] = React.useState(bootstrap.quota);
  const [conversations, setConversations] = React.useState(bootstrap.conversations);
  const [folders, setFolders] = React.useState(bootstrap.folders);
  const [activeConversationId, setActiveConversationId] = React.useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  // Live list of models from each configured provider's API (curated set until loaded).
  const [models, setModels] = React.useState<ModelInfo[]>(MODEL_LIST);
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const isCustom = settings.accent.startsWith("#");

    if (isCustom) {
      try {
        const hex = settings.accent;
        const hsl = hexToHsl(hex);
        
        let l = hsl.l;
        const isDark = resolvedTheme === "dark";
        if (isDark) {
          if (l < 55) l = 55;
        } else {
          if (l > 55) l = 55;
        }

        const hslStr = `${hsl.h} ${hsl.s}% ${l}%`;
        const fgStr = l >= 60 ? (isDark ? "40 6% 10%" : "30 3% 12%") : "0 0% 100%";

        document.documentElement.style.setProperty("--primary", hslStr);
        document.documentElement.style.setProperty("--ring", hslStr);
        document.documentElement.style.setProperty("--primary-foreground", fgStr);
      } catch (err) {
        console.error("Failed to parse custom accent color", err);
      }
    } else {
      document.documentElement.style.removeProperty("--primary");
      document.documentElement.style.removeProperty("--ring");
      document.documentElement.style.removeProperty("--primary-foreground");
    }
  }, [settings.accent, resolvedTheme]);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.models?.length) {
          React.startTransition(() => setModels(d.models));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setSettings = React.useCallback((patch: Partial<ClientSettings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }));
  }, []);

  const upsertConversation = React.useCallback((c: ClientConversation) => {
    setConversations((prev) => {
      const without = prev.filter((p) => p.id !== c.id);
      return [c, ...without];
    });
  }, []);

  const updateConversation = React.useCallback((id: string, patch: Partial<ClientConversation>) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeConversation = React.useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const value = React.useMemo<AppContextValue>(
    () => ({
      user: bootstrap.user,
      settings,
      features: bootstrap.features,
      quota,
      conversations,
      folders,
      models,
      setQuota,
      setSettings,
      upsertConversation,
      updateConversation,
      removeConversation,
      setConversations,
      setFolders,
      activeConversationId,
      setActiveConversationId,
      sidebarOpen,
      setSidebarOpen,
    }),
    [
      activeConversationId,
      bootstrap.features,
      bootstrap.user,
      conversations,
      folders,
      models,
      quota,
      removeConversation,
      settings,
      setSettings,
      sidebarOpen,
      updateConversation,
      upsertConversation,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
