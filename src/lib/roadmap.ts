// Shared metadata for the Feature Requests & Roadmap feature — used by both the
// API (validation) and the UI (labels, colors). Static class strings so Tailwind
// can see them (no dynamic class construction).

export const FEATURE_STATUSES = ["UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "SHIPPED", "DECLINED"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const STATUS_META: Record<
  FeatureStatus,
  { label: string; dot: string; badge: string; rail: string }
> = {
  UNDER_REVIEW: {
    label: "Under review",
    dot: "bg-muted-foreground",
    badge: "border-border bg-muted text-muted-foreground",
    rail: "bg-muted-foreground/40",
  },
  PLANNED: {
    label: "Planned",
    dot: "bg-source",
    badge: "border-source/30 bg-source/10 text-source",
    rail: "bg-source",
  },
  IN_PROGRESS: {
    label: "In progress",
    dot: "bg-warning",
    badge: "border-warning/30 bg-warning/10 text-warning",
    rail: "bg-warning",
  },
  SHIPPED: {
    label: "Shipped",
    dot: "bg-success",
    badge: "border-success/30 bg-success/10 text-success",
    rail: "bg-success",
  },
  DECLINED: {
    label: "Declined",
    dot: "bg-destructive",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    rail: "bg-destructive",
  },
};

// Board column order (DECLINED is collapsed/hidden by default).
export const BOARD_COLUMNS: FeatureStatus[] = ["UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "SHIPPED"];

export const FEATURE_CATEGORIES = [
  "CHAT",
  "MODELS",
  "CANVAS",
  "MEMORY",
  "VOICE",
  "FILES",
  "BILLING",
  "UI",
  "INTEGRATIONS",
  "OTHER",
] as const;
export type FeatureCategory = (typeof FEATURE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<FeatureCategory, string> = {
  CHAT: "Chat",
  MODELS: "Models",
  CANVAS: "Canvas",
  MEMORY: "Memory",
  VOICE: "Voice",
  FILES: "Files",
  BILLING: "Billing",
  UI: "Interface",
  INTEGRATIONS: "Integrations",
  OTHER: "Other",
};

export type RoadmapAuthor = { id: string; name: string | null };

export interface RoadmapRequest {
  id: string;
  title: string;
  description: string;
  category: FeatureCategory;
  status: FeatureStatus;
  pinned: boolean;
  declineReason: string | null;
  createdAt: string;
  author: RoadmapAuthor;
  voteCount: number;
  commentCount: number;
  hasVoted: boolean;
}

export interface RoadmapComment {
  id: string;
  body: string;
  official: boolean;
  createdAt: string;
  author: RoadmapAuthor;
}

export interface RoadmapEvent {
  id: string;
  status: FeatureStatus;
  note: string | null;
  createdAt: string;
}

export type SortKey = "top" | "new" | "trending";
