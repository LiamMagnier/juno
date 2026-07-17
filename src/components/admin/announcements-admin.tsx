"use client";

import * as React from "react";
import { toast } from "sonner";
import { CalendarClock, Edit3, Eye, Image as ImageIcon, Loader2, Megaphone, Plus, Trash2, UploadCloud, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AdminNav } from "@/components/admin/admin-nav";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import type { ClientAnnouncement } from "@/lib/announcements";
import { cn } from "@/lib/utils";

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
  if (draft.videoUrl) {
    return (
      <video
        src={draft.videoUrl}
        poster={draft.imageUrl || undefined}
        autoPlay
        muted
        playsInline
        preload="metadata"
        className={cn("h-full w-full bg-muted object-cover", className)}
      />
    );
  }
  if (draft.imageUrl) {
    const logoLike = draft.imageUrl.includes("/provider-logos/");
    return (
      <img
        src={draft.imageUrl}
        alt=""
        className={cn(logoLike ? "h-full w-full bg-muted object-contain p-8" : "h-full w-full object-cover", className)}
      />
    );
  }
  if (provider) {
    return (
      <div className={cn("flex h-full w-full items-center justify-center bg-muted", className)}>
        <ProviderLogo provider={provider} className="h-16 w-16 rounded-[24%]" />
      </div>
    );
  }
  return (
    <div className={cn("flex h-full w-full items-center justify-center bg-muted text-muted-foreground", className)}>
      <div className="flex flex-col items-center gap-2">
        <ImageIcon className="h-8 w-8" />
        <Video className="h-5 w-5 opacity-70" />
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
          className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Upload a file instead
        </button>
      </div>
    );
  }

  if (value) {
    return (
      <div className="group relative overflow-hidden rounded-lg border bg-muted">
        {kind === "video" ? (
          <video src={value} className="max-h-44 w-full bg-black object-contain" muted playsInline controls />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="max-h-44 w-full object-contain" />
        )}
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`Remove ${kind}`}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-background/80 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" />
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
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          dragOver ? "border-primary bg-primary/5" : "hover:bg-muted/50"
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
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Uploading… {progress}%</p>
          </>
        ) : (
          <>
            {kind === "video" ? (
              <Video className="h-6 w-6 text-muted-foreground" />
            ) : (
              <UploadCloud className="h-6 w-6 text-muted-foreground" />
            )}
            <p className="text-xs">
              <span className="font-medium text-foreground">Drag &amp; drop</span> {kind === "image" ? "an image" : "a video"}, or{" "}
              <span className="text-primary">browse</span>
            </p>
            <p className="text-[11px] text-muted-foreground">
              {kind === "image" ? "PNG, JPG, WebP, GIF" : "MP4, WebM, MOV"}
            </p>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => setUrlMode(true)}
        className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
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

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/announcements");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not load announcements.");
      setItems(data.announcements ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load announcements.");
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-label uppercase text-muted-foreground">
              <Megaphone className="h-4 w-4" />
              Owner
            </div>
            <h1 className="font-serif text-display font-medium tracking-tight">Announcements</h1>
            <p className="mt-1 text-sm text-muted-foreground">Publish model-release popups and product messages.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AdminNav current="announcements" />
            <Button variant="outline" onClick={reset} className="gap-1.5">
              <Plus className="h-4 w-4" />
              New draft
            </Button>
          </div>
        </div>

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
                  <p className="text-[11px] text-muted-foreground">Videos autoplay muted, play inline, and stop at the end.</p>
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label>Image</Label>
                  <MediaDropzone kind="image" value={draft.imageUrl} onChange={(v) => updateDraft("imageUrl", v)} />
                  <p className="text-[11px] text-muted-foreground">Used as the poster image or a static visual.</p>
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
                  <Megaphone className="h-4 w-4" />
                  {saving ? "Saving..." : editingId ? "Update popup" : "Publish popup"}
                </Button>
              </div>
            </div>
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="overflow-hidden p-0">
              <div className="border-b border-border/70 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Eye className="h-4 w-4 text-muted-foreground" />
                  Preview
                </div>
              </div>
              <div className="grid gap-0 sm:grid-cols-[13rem_minmax(0,1fr)]">
                <div className="h-44 sm:h-full">
                  <AnnouncementMedia draft={draft} />
                </div>
                <div className="flex min-h-44 flex-col justify-between gap-6 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      {draft.modelName && <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-primary">{draft.modelName}</p>}
                      <h2 className="font-serif text-2xl font-medium">{draft.title || "[model] just got released"}</h2>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        {draft.description || "Write a short release description for users here."}
                      </p>
                    </div>
                    {draft.provider !== "none" && <ProviderLogo provider={draft.provider} className="h-9 w-9 rounded-[24%]" />}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    {draft.newsHref ? (
                      <span className="text-sm font-medium underline underline-offset-4">{draft.newsLabel || "Read The News"}</span>
                    ) : (
                      <span />
                    )}
                    {draft.ctaLabel && (
                      <Button size="sm" className="w-fit rounded-full px-5">
                        {draft.ctaLabel}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Current popups</h2>
                <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
                  Refresh
                </Button>
              </div>

              {loading ? (
                <div className="flex flex-col gap-2">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="skeleton h-20 rounded-lg" />
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No announcements yet.</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {items.map((item) => {
                    const status = statusLabel(item);
                    return (
                      <div key={item.id} className="rounded-lg border bg-card p-3">
                        <div className="flex items-start gap-3">
                          <div className="flex h-12 w-12 shrink-0 overflow-hidden rounded-lg border bg-muted">
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
                                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                  status.tone === "active" && "bg-primary/10 text-primary",
                                  status.tone === "muted" && "bg-muted text-muted-foreground",
                                  status.tone === "ended" && "bg-destructive/10 text-destructive"
                                )}
                              >
                                {status.text}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <CalendarClock className="h-3.5 w-3.5" />
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
                            <Edit3 className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button variant="ghost" size="sm" className="gap-1.5 text-destructive danger-hover" onClick={() => setDeleteTarget(item)}>
                            <Trash2 className="h-3.5 w-3.5" />
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
    </div>
  );
}
