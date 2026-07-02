"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";
import { toast } from "sonner";
import { ArrowLeft, Brain, Check, Download, Monitor, Moon, Sun, Trash2, Plus, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardEyebrow } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DotFillBar } from "@/components/signature/dot-matrix";
import { useApp } from "@/components/app/app-provider";
import { resolveModel } from "@/lib/models";
import { PROVIDERS, type Provider } from "@/lib/providers";
import { PLANS, canUseModel } from "@/lib/plans";
import { ACCENTS } from "@/lib/accents";
import { cn } from "@/lib/utils";
import type { ClientSettings } from "@/types/app";

const LANGUAGES = ["auto", "English", "Spanish", "French", "German", "Portuguese", "Italian", "Japanese", "Korean", "Chinese", "Hindi", "Arabic"];

function Tile({
  eyebrow,
  i,
  span,
  className,
  children,
}: {
  eyebrow: string;
  i: number;
  span?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      style={{ animationDelay: `${i * 55}ms` }}
      className={cn("p-5 rounded-[28px] motion-safe:animate-rise-in [animation-fill-mode:backwards]", span && "sm:col-span-2", className)}
    >
      <CardEyebrow className="mb-3">{eyebrow}</CardEyebrow>
      {children}
    </Card>
  );
}

function CustomPickerButton({
  selected,
  customColor,
  onChange,
}: {
  selected: boolean;
  customColor: string;
  onChange: (color: string) => void;
}) {
  const pickerRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <input
        ref={pickerRef}
        type="color"
        value={customColor}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => pickerRef.current?.click()}
        aria-label="Custom accent color"
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-fast hover:scale-110 coarse:h-11 coarse:w-11 relative overflow-hidden",
          selected && "ring-2 ring-foreground"
        )}
        style={{
          background: selected
            ? customColor
            : "linear-gradient(135deg, #ff007f, #7f00ff, #00ffff, #00ff7f, #ffea00)",
        }}
      >
        {selected ? (
          <Check className="h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        ) : (
          <Plus className="h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        )}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, settings, setSettings, quota, features, models } = useApp();
  const { setTheme } = useTheme();
  const [instructions, setInstructions] = React.useState(settings.customInstructions);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteChatsOpen, setDeleteChatsOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deletingChats, setDeletingChats] = React.useState(false);
  const [portalLoading, setPortalLoading] = React.useState(false);

  const save = React.useCallback(
    async (patch: Partial<ClientSettings>) => {
      setSettings(patch);
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) toast.error("Could not save settings.");
    },
    [setSettings]
  );

  const setAccent = (accent: string) => {
    document.documentElement.dataset.accent = accent;
    save({ accent });
  };

  const setThemePref = (theme: ClientSettings["theme"]) => {
    setTheme(theme);
    save({ theme });
  };

  const saveInstructions = () => {
    if (instructions !== settings.customInstructions) save({ customInstructions: instructions });
  };

  const exportData = () => {
    window.location.href = "/api/account/export";
  };

  const deleteAccount = async () => {
    setDeleting(true);
    const res = await fetch("/api/account", { method: "DELETE" });
    if (res.ok) {
      toast.success("Account deleted.");
      signOut({ callbackUrl: "/sign-in" });
    } else {
      setDeleting(false);
      toast.error("Could not delete account.");
    }
  };

  const deleteAllChats = async () => {
    setDeletingChats(true);
    const res = await fetch("/api/conversations", { method: "DELETE" });
    if (res.ok) {
      toast.success("All conversations deleted.");
      window.location.href = "/chat";
    } else {
      setDeletingChats(false);
      toast.error("Could not delete conversations.");
    }
  };

  const openPortal = async () => {
    setPortalLoading(true);
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else {
      setPortalLoading(false);
      toast.error(data.error ?? "Could not open billing portal.");
    }
  };

  const themeOptions: { value: ClientSettings["theme"]; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];

  const plan = PLANS[quota.plan];
  const limit = quota.limit;
  const used = quota.used;
  const remaining = quota.remaining;
  const low = limit != null && remaining != null && remaining <= Math.max(1, Math.round(limit * 0.1));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="font-serif text-title font-medium">Settings</h1>
            <p className="text-caption text-muted-foreground">{user.email}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Usage dashboard */}
          <Tile eyebrow="Usage this month" i={0} span>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-5 items-stretch mt-1">
              {/* Plan info (Left) */}
              <div className="field-well md:col-span-2 flex flex-col justify-between rounded-[18px] bg-accent/40 border border-border/50 p-4">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-serif text-heading font-semibold tracking-tight">
                      {plan.name} Plan
                    </span>
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {plan.tagline}
                  </p>
                  
                  {/* Plan Features */}
                  <ul className="mt-4 space-y-1.5">
                    {plan.features.slice(0, 3).map((feat, idx) => (
                      <li key={idx} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Check className="h-3 w-3 text-primary shrink-0" />
                        <span className="truncate">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                
                <div className="mt-4 flex items-center justify-between gap-2 pt-3 border-t border-border/40">
                  <span className="text-caption text-muted-foreground uppercase tracking-wider font-mono">
                    {plan.price > 0 ? `$${plan.price}/mo` : "Active tier"}
                  </span>
                  {quota.plan === "FREE" && features.billing && (
                    <Button asChild size="sm" className="h-7 px-3 text-xs">
                      <Link href="/upgrade">Upgrade</Link>
                    </Button>
                  )}
                </div>
              </div>

              {/* Usage metrics (Right) */}
              <div className="field-well md:col-span-3 flex flex-col justify-between rounded-[18px] border border-border/50 p-4 bg-card">
                <div>
                  <span className="font-mono text-[10px] text-label uppercase text-muted-foreground/80 tracking-widest block mb-2">
                    Monthly Quota
                  </span>
                  
                  {/* Stats Row */}
                  <div className="grid grid-cols-3 gap-3 my-3">
                    <div className="text-left">
                      <span className="block text-caption text-muted-foreground uppercase tracking-wider font-mono">Used</span>
                      <span className="text-lg font-serif font-bold text-foreground mt-0.5 block">{used.toLocaleString()}</span>
                    </div>
                    <div className="text-left">
                      <span className="block text-caption text-muted-foreground uppercase tracking-wider font-mono">Limit</span>
                      <span className="text-lg font-serif font-bold text-foreground mt-0.5 block">
                        {limit != null ? limit.toLocaleString() : "Unlimited"}
                      </span>
                    </div>
                    <div className="text-left">
                      <span className="block text-caption text-muted-foreground uppercase tracking-wider font-mono">Remaining</span>
                      <span className="text-lg font-serif font-bold text-foreground mt-0.5 block">
                        {remaining != null ? remaining.toLocaleString() : "∞"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Progress bar / animated dots */}
                <div className="mt-3">
                  {limit != null ? (
                    <div>
                      <div className="relative w-full h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="absolute top-0 left-0 h-full rounded-full bg-gradient-to-r from-primary/80 to-primary transition-all duration-base"
                          style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
                        />
                      </div>
                      <p className={cn("mt-2 text-[11px] leading-relaxed", low ? "text-warning" : "text-muted-foreground")}>
                        {remaining != null ? `${remaining.toLocaleString()} messages left — resets at the start of next month.` : null}
                      </p>
                    </div>
                  ) : (
                    <div>
                      {/* Pulsing dot matrix */}
                      <div className="flex items-center gap-[3.5px] py-1.5" aria-hidden>
                        {Array.from({ length: 32 }).map((_, i) => (
                          <span
                            key={i}
                            className="h-[5px] w-[5px] rounded-full bg-primary/75 animate-pulse"
                            style={{
                              animationDelay: `${i * 65}ms`,
                              animationDuration: "1.6s",
                            }}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                        Your account has unlimited message credits. Enjoy uninterrupted premium access.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Tile>

          {/* Appearance */}
          <Tile eyebrow="Appearance" i={1} span>
            <div className="grid gap-6 sm:grid-cols-2 sm:gap-12">
              <div>
                <Label className="mb-2 block text-xs text-muted-foreground">Theme</Label>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
                  {themeOptions.map((t) => {
                    const selected = settings.theme === t.value;
                    return (
                      <button
                        key={t.value}
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setThemePref(t.value)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-xl border p-3 text-sm shadow-pop transition-all duration-fast ease-out-soft hover:-translate-y-0.5 hover:bg-accent hover:shadow-float",
                          selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/70"
                        )}
                      >
                        <t.icon className="h-4 w-4" />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label className="mb-2 block text-xs text-muted-foreground">Accent color</Label>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent color">
                  {ACCENTS.map((a) => {
                    const selected = settings.accent === a.id;
                    return (
                      <button
                        key={a.id}
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setAccent(a.id)}
                        aria-label={a.id}
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-fast hover:scale-110 coarse:h-11 coarse:w-11",
                          selected && "ring-2 ring-foreground"
                        )}
                        style={{ backgroundColor: a.color }}
                      >
                        {selected && <Check className="h-4 w-4 text-white" />}
                      </button>
                    );
                  })}
                  {/* Custom color picker */}
                  {(() => {
                    const isPreset = ACCENTS.some((a) => a.id === settings.accent);
                    const selected = !isPreset && settings.accent.startsWith("#");
                    const customColor = selected ? settings.accent : "#ea580c";
                    return (
                      <CustomPickerButton
                        selected={selected}
                        customColor={customColor}
                        onChange={setAccent}
                      />
                    );
                  })()}
                </div>
              </div>
            </div>
          </Tile>

          {/* Default model */}
          <Tile eyebrow="Default model" i={2}>
            <p className="mb-3 text-sm text-muted-foreground">Used for new conversations.</p>
            <Select
              value={resolveModel(settings.defaultModel)?.id ?? settings.defaultModel}
              onValueChange={(v) => save({ defaultModel: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models
                  .filter((m) => (m.modality ?? "chat") === "chat")
                  .map((m) => {
                    const configured = features.providers.includes(m.provider as Provider);
                    return (
                      <SelectItem key={m.id} value={m.id} disabled={!configured || !canUseModel(quota.plan, m.id)}>
                        {m.name}
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          · {(PROVIDERS[m.provider]?.label ?? m.provider).split(" · ")[0]}
                          {!configured ? " (no key)" : ""}
                        </span>
                      </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
          </Tile>

          {/* Language */}
          <Tile eyebrow="Response language" i={3}>
            <p className="mb-3 text-sm text-muted-foreground">The language Juno replies in.</p>
            <Select value={settings.responseLanguage} onValueChange={(v) => save({ responseLanguage: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l === "auto" ? "Auto-detect" : l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Tile>

          <Tile eyebrow="Custom instructions" i={4} span>
            <p className="mb-3 text-sm text-muted-foreground">Juno keeps these in mind in every conversation.</p>
            <div className="relative">
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={saveInstructions}
                placeholder="E.g. I'm a product manager. Keep answers concise and use bullet points."
                className="min-h-[110px] pb-8"
                maxLength={4000}
              />
              <span className="absolute bottom-2.5 right-3 font-mono text-[10px] text-muted-foreground/50 select-none">
                {instructions.length}/4000
              </span>
            </div>
          </Tile>

          {/* Memory */}
          <Tile eyebrow="Memory" i={5}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Brain className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium">Reference saved memories</p>
                  <p className="text-xs text-muted-foreground">Manage what Juno remembers</p>
                </div>
              </div>
              <Switch checked={settings.memoryEnabled} onCheckedChange={(v) => save({ memoryEnabled: v })} aria-label="Toggle memory" />
            </div>
            <Button asChild variant="link" className="mt-2 h-auto p-0">
              <Link href="/memory">Open memory manager →</Link>
            </Button>
          </Tile>

          {/* Account */}
          <Tile eyebrow="Account" i={6}>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Current plan</span>
                <span className="font-medium">{plan.name}</span>
              </div>
              {features.billing && quota.plan !== "FREE" && (
                <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading} className="w-full">
                  {portalLoading ? "Opening…" : "Manage subscription"}
                </Button>
              )}
              {features.billing && quota.plan === "FREE" && (
                <Button asChild size="sm" className="w-full">
                  <Link href="/upgrade">Upgrade plan</Link>
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={exportData} className="w-full gap-2">
                <Download className="h-4 w-4" /> Export my data
              </Button>
            </div>
          </Tile>

          {/* Danger zone */}
          <Tile eyebrow="Danger zone" i={7} span className="border-destructive/30">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/40">
                <div>
                  <p className="text-sm font-medium">Delete all conversations</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete all your chat history.
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setDeleteChatsOpen(true)} className="gap-2 shrink-0">
                  <Trash2 className="h-4 w-4" /> Delete all chats
                </Button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Delete account</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Permanently delete your account, conversations, and memories.
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} className="gap-2 shrink-0">
                  <Trash2 className="h-4 w-4" /> Delete account
                </Button>
              </div>
            </div>
          </Tile>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Delete your account?</DialogTitle>
            <DialogDescription>
              This permanently deletes your account, conversations, and memories. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAccount} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteChatsOpen} onOpenChange={setDeleteChatsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Delete all conversations?</DialogTitle>
            <DialogDescription>
              This permanently deletes all your conversations and message history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteChatsOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAllChats} disabled={deletingChats}>
              {deletingChats ? "Deleting…" : "Delete all chats"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
