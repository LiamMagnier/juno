"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, CalendarClock, Eye, Image as ImageIcon, Loader2, Megaphone, Plus, UploadCloud, Video } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AdminNav } from "@/components/admin/admin-nav";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import type { ClientAnnouncement } from "@/lib/announcements";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * `prefers-reduced-motion`, read as state.
 *
 * The popup list renders one AnnouncementMedia per row, and a self-starting
 * video loop per row is exactly the peripheral motion the preference exists to
 * stop — but `autoPlay` is an attribute, so the reduced-motion block in
 * globals.css cannot reach it. Starts false so SSR and the first client render
 * agree, then corrects on mount.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

type Draft = {
  title: string;
  description: string;
  imageUrl: string;
  videoUrl: string;
  provider: Provider | "none";
  modelName: string;
  newsLabel: string;
  newsHref: string;
  ctaLabel: string;
  ctaHref: string;
  startsAt: string;
  endsAt: string;
  published: boolean;
};

const EMPTY_DRAFT: Draft = {
  title: "",
  description: "",
  imageUrl: "",
  videoUrl: "",
  provider: "none",
  modelName: "",
  newsLabel: "Read The News",
  newsHref: "",
  ctaLabel: "",
  ctaHref: "",
  startsAt: "",
  endsAt: "",
  published: true,
};

function toDateTimeLocal(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function draftFromAnnouncement(item: ClientAnnouncement): Draft {
  return {
    title: item.title,
    description: item.description,
    imageUrl: item.imageUrl ?? "",
    videoUrl: item.videoUrl ?? "",
    provider: item.provider ?? "none",
    modelName: item.modelName ?? "",
    newsLabel: item.newsLabel ?? "Read The News",
    newsHref: item.newsHref ?? "",
    ctaLabel: item.ctaLabel ?? "",
    ctaHref: item.ctaHref ?? "",
    startsAt: toDateTimeLocal(item.startsAt),
    endsAt: toDateTimeLocal(item.endsAt),
    published: item.published,
  };
}

function payloadFromDraft(draft: Draft) {
  return {
    title: draft.title,
    description: draft.description,
    imageUrl: draft.imageUrl || null,
    videoUrl: draft.videoUrl || null,
    provider: draft.provider === "none" ? null : draft.provider,
    modelName: draft.modelName || null,
    newsLabel: draft.newsLabel || null,
    newsHref: draft.newsHref || null,
    ctaLabel: draft.ctaLabel || null,
    ctaHref: draft.ctaHref || null,
    startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
    endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
    published: draft.published,
  };
}

function statusLabel(item: ClientAnnouncement): { text: string; tone: "muted" | "active" | "ended" } {
  const now = Date.now();
  const startsAt = new Date(item.startsAt).getTime();
  const endsAt = item.endsAt ? new Date(item.endsAt).getTime() : null;
  if (!item.published) return { text: "Draft", tone: "muted" };
  if (startsAt > now) return { text: "Scheduled", tone: "muted" };
  if (endsAt && endsAt <= now) return { text: "Ended", tone: "ended" };
  return { text: "Live", tone: "active" };
}

function AnnouncementMedia({ draft, className }: { draft: Pick<Draft, "imageUrl" | "videoUrl" | "provider">; className?: string }) {
  const provider = draft.provider === "none" ? null : draft.provider;
  const reduced = useReducedMotion();
  if (draft.videoUrl) {
    return (
      <video
        src={draft.videoUrl}
        poster={draft.imageUrl || undefined}
        // Autoplay is suppressed under reduced motion, and `controls` replaces
        // it so the clip is still reachable rather than merely frozen.
        autoPlay={!reduced}
        controls={reduced}
        muted
        playsInline
        preload="metadata"
        className={cn("size-full bg-muted object-cover", className)}
      />
    );
  }
  if (draft.imageUrl) {
    const logoLike = draft.imageUrl.includes("/provider-logos/");
    return (
      <img
        src={draft.imageUrl}
        alt=""
        className={cn(logoLike ? "size-full bg-muted object-contain p-8" : "size-full object-cover", className)}
      />
    );
  }
  if (provider) {
    return (
      <div className={cn("flex size-full items-center justify-center bg-muted", className)}>
        <ProviderLogo provider={provider} className="size-16" />
      </div>
    );
  }
  return (
    <div className={cn("flex size-full items-center justify-center bg-muted text-muted-foreground", className)}>
      <div className="flex flex-col items-center gap-2">
        <ImageIcon className="size-8" />
        <Video className="size-5 opacity-70" />
      </div>
    </div>
  );
}

/** Drag-and-drop (or click / paste-URL) media field that uploads to storage
 *  and returns an inline-servable URL. */
function MediaDropzone({
  kind,
  value,
  onChange,
}: {
  kind: "image" | "video";
  value: string;
  onChange: (url: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [urlMode, setUrlMode] = React.useState(false);

  const accept = kind === "image" ? "image/*" : "video/mp4,video/webm,video/quicktime";

  const upload = (file: File) => {
    setUploading(true);
    setProgress(0);
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/announcements/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 95));
    };
    xhr.onload = () => {
      setUploading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          onChange(data.url);
          setProgress(100);
        } catch {
          toast.error("Upload failed.");
        }
      } else {
        // nginx rejects oversized bodies with an HTML 413 page before the
        // request ever reaches Next — surface that instead of a generic error.
        let msg = xhr.status === 413
          ? "File too large for the server (proxy body-size limit). Raise client_max_body_size in nginx."
          : `Upload failed (HTTP ${xhr.status}).`;
        try {
          msg = JSON.parse(xhr.responseText).error ?? msg;
        } catch {
          /* ignore */
        }
        toast.error(msg);
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      toast.error("Upload failed. Check your connection.");
    };
    xhr.send(fd);
  };

  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const ok = kind === "image" ? f.type.startsWith("image/") : f.type.startsWith("video/");
    if (!ok) {
      toast.error(`Please choose a ${kind} file.`);
      return;
    }
    upload(f);
  };

  if (urlMode) {
    return (
      <div className="flex flex-col gap-1.5">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            kind === "image"
              ? "/provider-logos/light/openai.png or https://..."
              : "/release-video.mp4 or https://..."
          }
        />
        <button
          type="button"
          onClick={() => setUrlMode(false)}
          className="self-start rounded-sm text-caption text-muted-foreground underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
        >
          Upload a file instead
        </button>
      </div>
    );
  }

  if (value) {
    return (
      <div className="group relative overflow-hidden rounded-card border border-border/70 bg-muted">
        {/* `bg-muted`, not a hardcoded `bg-black`: a literal cannot follow the
            retheme, and it drew a hard black letterbox band inside a bg-muted
            card in the light theme. Matches the image branch below. */}
        {kind === "video" ? (
          <video src={value} className="max-h-44 w-full bg-muted object-contain" muted playsInline controls />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="max-h-44 w-full object-contain" />
        )}
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`Remove ${kind}`}
          // The remove control is an affordance on touch too, so it does not
          // hide behind hover — hover only raises its contrast. Scoped
          // transition on the token ladder, not a bare 150ms `ease`.
          //
          // `bg-popover`, not `bg-background`: this floats ABOVE arbitrary
          // media, which is the popover rung's job, and --background is the
          // page token — on the true-black theme it made the one control that
          // has to stay findable over a dark video a pure-black chip held by a
          // /60 hairline. The same fix DialogCloseButton already carries.
          className="absolute right-2 top-2 grid size-7 place-items-center rounded-control border border-border/60 bg-popover/85 text-muted-foreground backdrop-blur transition-[color,background-color,border-color] duration-fast ease-out-soft hover:border-border hover:bg-popover hover:text-foreground"
        >
          <ActionIcons.dismiss className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          // `rounded-card` from the ladder, and the transition declared on the
          // token rungs — this was a bare `transition-colors`, i.e. the browser
          // default 150ms `ease`, while every other transition on this surface
          // runs duration-fast/ease-out-soft. `outline-none` is gone with it:
          // it suppressed the product's own :focus-visible rule and replaced it
          // with a ring that had no offset, so the focused dropzone was the one
          // control on the page with a different focus treatment.
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border border-dashed px-4 py-6 text-center",
          "transition-[background-color,border-color] duration-fast ease-out-soft",
          dragOver ? "border-primary bg-primary/10" : "border-border/70 hover:border-border hover:bg-accent/40"
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {uploading ? (
          <>
            <Loader2 className="size-5 animate-spin text-primary" />
            {/* A real bar, not a number that changes in place: a percentage on
                its own gives no sense of how much is left, and the same upload
                already draws one in import-history. */}
            <p className="font-mono text-caption tabular-nums text-muted-foreground">Uploading… {progress}%</p>
            <div className="h-1 w-40 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/10">
              <div
                // motion-reduce:transition-none, like the identical upload bar
                // in import-history: a width that animates is motion, and this
                // one ran regardless of the preference.
                className="h-full rounded-full bg-primary transition-[width] duration-base ease-out-soft motion-reduce:transition-none"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        ) : (
          <>
            {kind === "video" ? (
              <Video className="size-5 text-muted-foreground" />
            ) : (
              <UploadCloud className="size-5 text-muted-foreground" />
            )}
            <p className="text-xs">
              <span className="font-medium text-foreground">Drag &amp; drop</span> {kind === "image" ? "an image" : "a video"}, or{" "}
              <span className="text-primary">browse</span>
            </p>
            <p className="font-mono text-caption text-muted-foreground">
              {kind === "image" ? "PNG, JPG, WebP, GIF" : "MP4, WebM, MOV"}
            </p>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => setUrlMode(true)}
        className="self-start rounded-sm text-caption text-muted-foreground underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline"
      >
        Paste a URL instead
      </button>
    </div>
  );
}

export function AnnouncementsAdmin() {
  const [items, setItems] = React.useState<ClientAnnouncement[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = React.useState<ClientAnnouncement | null>(null);

  // Same gap as the other two admin surfaces: a failed load left the list empty
  // and said "No announcements yet", which is a claim about the database rather
  // than about the request that failed.
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch("/api/admin/announcements");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not load announcements.");
      setItems(data.announcements ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load announcements.");
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const reset = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const submit = async () => {
    if (!draft.title.trim() || !draft.description.trim()) {
      toast.error("Title and description are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(editingId ? `/api/admin/announcements/${editingId}` : "/api/admin/announcements", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFromDraft(draft)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save announcement.");
      toast.success(editingId ? "Announcement updated." : "Announcement created.");
      reset();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save announcement.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/admin/announcements/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not delete announcement.");
      toast.success("Announcement deleted.");
      setDeleteTarget(null);
      if (editingId === deleteTarget.id) reset();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete announcement.");
    }
  };

  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <AppPage measure="wide" contentClassName="flex flex-col gap-6">
        <AppPageHeader
          className="mb-0"
          eyebrow="Owner"
          heading="Announcements"
          icon={Megaphone}
          lede="Publish model-release popups and product messages."
          actions={
            <>
              <AdminNav current="announcements" />
              <Button variant="outline" size="sm" onClick={reset} className="gap-1.5">
                <Plus className="size-4" />
                New draft
              </Button>
            </>
          }
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <Card className="p-4">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">{editingId ? "Edit popup" : "Create popup"}</h2>
                  <p className="text-xs text-muted-foreground">Users will see the newest active popup until they dismiss it.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="announcement-published" className="text-xs text-muted-foreground">
                    Published
                  </Label>
                  <Switch
                    id="announcement-published"
                    checked={draft.published}
                    onCheckedChange={(checked) => updateDraft("published", checked)}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="announcement-title">Title</Label>
                  <Input
                    id="announcement-title"
                    value={draft.title}
                    onChange={(e) => updateDraft("title", e.target.value)}
                    placeholder="GPT-5.5 just got released"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Provider</Label>
                  <Select value={draft.provider} onValueChange={(value) => updateDraft("provider", value as Draft["provider"])}>
                    <SelectTrigger>
                      <SelectValue placeholder="Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No provider</SelectItem>
                      {PROVIDER_LIST.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {PROVIDERS[provider].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-model">Model name</Label>
                  <Input
                    id="announcement-model"
                    value={draft.modelName}
                    onChange={(e) => updateDraft("modelName", e.target.value)}
                    placeholder="GPT-5.5"
                  />
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="announcement-description">Description</Label>
                  <Textarea
                    id="announcement-description"
                    value={draft.description}
                    onChange={(e) => updateDraft("description", e.target.value)}
                    placeholder="A faster reasoning model with stronger coding and better instruction following is now available in the model picker."
                    className="min-h-28"
                  />
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label>Video</Label>
                  <MediaDropzone kind="video" value={draft.videoUrl} onChange={(v) => updateDraft("videoUrl", v)} />
                  <p className="text-caption text-muted-foreground">Videos autoplay muted, play inline, and stop at the end.</p>
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label>Image</Label>
                  <MediaDropzone kind="image" value={draft.imageUrl} onChange={(v) => updateDraft("imageUrl", v)} />
                  <p className="text-caption text-muted-foreground">Used as the poster image or a static visual.</p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-news-label">News label</Label>
                  <Input
                    id="announcement-news-label"
                    value={draft.newsLabel}
                    onChange={(e) => updateDraft("newsLabel", e.target.value)}
                    placeholder="Read The News"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-news-href">News link</Label>
                  <Input
                    id="announcement-news-href"
                    value={draft.newsHref}
                    onChange={(e) => updateDraft("newsHref", e.target.value)}
                    placeholder="https://www.anthropic.com/news/..."
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-cta-label">CTA label</Label>
                  <Input
                    id="announcement-cta-label"
                    value={draft.ctaLabel}
                    onChange={(e) => updateDraft("ctaLabel", e.target.value)}
                    placeholder="Try it now"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-cta-href">CTA link</Label>
                  <Input
                    id="announcement-cta-href"
                    value={draft.ctaHref}
                    onChange={(e) => updateDraft("ctaHref", e.target.value)}
                    placeholder="/chat"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-starts">Starts</Label>
                  <Input
                    id="announcement-starts"
                    type="datetime-local"
                    value={draft.startsAt}
                    onChange={(e) => updateDraft("startsAt", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="announcement-ends">Ends</Label>
                  <Input
                    id="announcement-ends"
                    type="datetime-local"
                    value={draft.endsAt}
                    onChange={(e) => updateDraft("endsAt", e.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
                {editingId && (
                  <Button variant="ghost" onClick={reset}>
                    Cancel edit
                  </Button>
                )}
                <Button onClick={submit} disabled={saving} className="gap-1.5">
                  <Megaphone className="size-4" />
                  {saving ? "Saving..." : editingId ? "Update popup" : "Publish popup"}
                </Button>
              </div>
            </div>
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="overflow-hidden p-0">
              <div className="border-b border-border/70 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Eye className="size-4 text-muted-foreground" />
                  Preview
                </div>
              </div>
              <div className="grid gap-0 sm:grid-cols-[13rem_minmax(0,1fr)]">
                <div className="h-44 sm:h-full">
                  <AnnouncementMedia draft={draft} />
                </div>
                <div className="flex min-h-44 flex-col justify-between gap-6 p-5">
                  <div className="flex items-start justify-between gap-4">
                    {/* Every rung here is the one announcement-popup.tsx
                        actually renders, because a preview that is off the
                        scale of the thing it previews is a preview of nothing:
                        the eyebrow was caption/primary against the popup's
                        label/muted, the title was `text-2xl` — a Tailwind
                        default, not a rung — against `text-title`, and the body
                        was text-sm against text-body. An editor was choosing
                        copy length against type that ships two sizes off. */}
                    <div>
                      {draft.modelName && <p className="mb-2 font-mono text-label text-muted-foreground">{draft.modelName}</p>}
                      <h2 className="font-serif text-title leading-tight text-foreground">{draft.title || "[model] just got released"}</h2>
                      <p className="mt-2 text-body leading-relaxed text-muted-foreground">
                        {draft.description || "Write a short release description for users here."}
                      </p>
                    </div>
                    {draft.provider !== "none" && <ProviderLogo provider={draft.provider} className="size-9" />}
                  </div>
                  {/* The popup's own action row: both controls right-aligned,
                      the news link an outline Button and the CTA the solid one
                      with its arrow. The preview drew the news label as bare
                      underlined text pinned to the opposite edge and the CTA as
                      a pill, so the one thing this pane exists to show — how
                      the two labels weigh against each other — was the thing it
                      got wrong. Buttons here are inert; this is a picture. */}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {draft.newsHref && (
                      <Button variant="outline" size="sm" tabIndex={-1}>
                        {draft.newsLabel || "Read The News"}
                      </Button>
                    )}
                    {draft.ctaLabel && (
                      <Button size="sm" className="group gap-1.5" tabIndex={-1}>
                        {draft.ctaLabel}
                        <ArrowRight className="size-4 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 motion-reduce:transition-none" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Current popups</h2>
                {/* The spinner is the point of a Refresh button: disabled alone
                    gives no sign anything is happening on a fast connection. */}
                <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-1.5">
                  {loading && <Loader2 className="size-3.5 animate-spin" />}
                  Refresh
                </Button>
              </div>

              {loading ? (
                <div className="flex flex-col gap-2" aria-hidden>
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="skeleton h-20 rounded-field" style={staggerDelay(i)} />
                  ))}
                </div>
              ) : failed ? (
                <EmptyState
                  tone="error"
                  size="panel"
                  icon={Megaphone}
                  title="Couldn't load announcements"
                  description="The list didn't come back. Publishing still works — this is only the read."
                  action={
                    <Button variant="outline" size="sm" onClick={load}>
                      Try again
                    </Button>
                  }
                />
              ) : items.length === 0 ? (
                <EmptyState
                  tone="empty"
                  size="panel"
                  icon={Megaphone}
                  title="No announcements yet"
                  description="Fill in the form on the left and publish — the newest active popup is the one users see."
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {items.map((item) => {
                    const status = statusLabel(item);
                    return (
                      // A rung LIGHTER and a rung TIGHTER than the card that
                      // holds it. These were `bg-card` rows nested inside a
                      // `bg-card` Card — identical fills stacked, so on black
                      // the rows had no ground of their own — at rounded-lg
                      // (16px, the surface rung), one step above their own
                      // container.
                      <div
                        key={item.id}
                        className="rounded-field border border-border/60 bg-secondary p-3 transition-colors duration-fast ease-out-soft hover:border-border"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex size-12 shrink-0 overflow-hidden rounded-control border border-border/60 bg-muted">
                            <AnnouncementMedia
                              draft={{ imageUrl: item.imageUrl ?? "", videoUrl: item.videoUrl ?? "", provider: item.provider ?? "none" }}
                              className="p-2"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">{item.title}</p>
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-2 py-0.5 font-mono text-caption font-semibold",
                                  status.tone === "active" && "bg-primary/10 text-primary",
                                  status.tone === "muted" && "bg-muted text-muted-foreground",
                                  status.tone === "ended" && "bg-destructive/10 text-destructive"
                                )}
                              >
                                {status.text}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                            <div className="mt-2 flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
                              <CalendarClock className="size-3.5 shrink-0" />
                              <span>{new Date(item.startsAt).toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => {
                              setEditingId(item.id);
                              setDraft(draftFromAnnouncement(item));
                            }}
                          >
                            <ActionIcons.edit className="size-3.5" />
                            Edit
                          </Button>
                          <Button variant="ghost" size="sm" className="gap-1.5 text-destructive danger-hover" onClick={() => setDeleteTarget(item)}>
                            <ActionIcons.delete className="size-3.5" />
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete announcement?</DialogTitle>
            <DialogDescription>This removes the popup and every user dismissal record for it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
