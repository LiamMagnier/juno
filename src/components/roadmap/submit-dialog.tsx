"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { FEATURE_CATEGORIES, CATEGORY_LABEL, type FeatureCategory, type RoadmapRequest } from "@/lib/roadmap";

export function SubmitDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [category, setCategory] = React.useState<FeatureCategory>("OTHER");
  const [similar, setSimilar] = React.useState<RoadmapRequest[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setCategory("OTHER");
      setSimilar([]);
    }
  }, [open]);

  // Duplicate detection — search as you type.
  React.useEffect(() => {
    const q = title.trim();
    if (q.length < 4) {
      setSimilar([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/roadmap?q=${encodeURIComponent(q)}&sort=top`);
        if (res.ok) {
          const data = await res.json();
          setSimilar((data.requests as RoadmapRequest[]).slice(0, 3));
        }
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [title]);

  const submit = async () => {
    if (title.trim().length < 4 || description.trim().length < 10) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), category }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not submit.");
      toast.success("Request submitted — thanks!");
      onOpenChange(false);
      onCreated(data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-heading">Request a feature</DialogTitle>
          <DialogDescription>Tell us what would make Juno better. Others can vote it up.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fr-title">Title</Label>
            <Input
              id="fr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short and specific — e.g. “Export a chat as Markdown”"
              maxLength={120}
              autoFocus
            />
          </div>

          {similar.length > 0 && (
            <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
              <p className="mb-2 font-mono text-[10px] text-muted-foreground">
                Similar requests — vote instead?
              </p>
              <ul className="space-y-1">
                {similar.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/roadmap/${s.id}`}
                      onClick={() => onOpenChange(false)}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                    >
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                        <ChevronUp className="h-3 w-3" />
                        {s.voteCount}
                      </span>
                      <span className="truncate">{s.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="fr-desc">Description</Label>
            <Textarea
              id="fr-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What problem does it solve? How would it work?"
              className="min-h-[120px]"
              maxLength={4000}
            />
          </div>

          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as FeatureCategory)}>
              <SelectTrigger className="max-w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEATURE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DottedDivider className="mt-1" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || title.trim().length < 4 || description.trim().length < 10}>
            {submitting ? "Submitting…" : "Submit request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
