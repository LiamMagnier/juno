import {
  Braces,
  CalendarClock,
  EyeOff,
  Fingerprint,
  GraduationCap,
  Layers,
  Search,
  SlidersHorizontal,
  Target,
  Users,
  type IconComponent,
} from "@/components/ui/icons";

import { AppIcons } from "@/lib/app-icons";
import { MEMORY_CATEGORIES } from "@/lib/memory-categories";

/**
 * One mark per memory topic.
 *
 * A topic card is read at a glance and at a distance; its icon is doing the
 * work its heading is too small to do. That only holds if the marks are
 * DISTINCT AT 16px and mean the category rather than decorating it — so
 * `Fingerprint` for identity (the one thing that is only ever you), sliders for
 * preferences (the same mark the product already uses for "adjust the knobs"),
 * a target for goals, and a calendar-clock for temporary, which is the only
 * category defined by its expiry. `projects` is the one mark borrowed from the
 * shared vocabulary rather than chosen here: facts about your projects are
 * filed under the same folder the sidebar, the command palette and the
 * projects grid draw for a project, not a second (kanban) drawing of it.
 *
 * Kept here rather than in `@/lib/app-icons` because that file is the
 * product-wide vocabulary — a mark in it is a promise that the same idea is
 * drawn the same way everywhere. These are a local mapping of one enum, and
 * promoting them would put nine marks in the shared namespace that nothing
 * outside this folder can use.
 */
const TOPIC_ICONS: Record<(typeof MEMORY_CATEGORIES)[number], IconComponent> = {
  identity: Fingerprint,
  preferences: SlidersHorizontal,
  goals: Target,
  studies: GraduationCap,
  workflows: Braces,
  projects: AppIcons.projects,
  relationships: Users,
  temporary: CalendarClock,
  suppression: EyeOff,
};

export const MemoryIcons = {
  /** The topics view itself, and the empty state that stands in for it. */
  topic: Layers,
  /** Searching what is remembered. */
  search: Search,
  /**
   * The mark for a category id read back from the server.
   *
   * Falls back to the generic stack for `null` (rows written before Memory v2
   * carry no category) and for any id a newer build might introduce — the same
   * tolerance `memoryCategoryLabel` applies to the label, for the same reason:
   * a card with an unfamiliar name is still a card, and a crash is not an
   * improvement on a generic icon.
   */
  forTopic(id: string | null | undefined): IconComponent {
    return (id && TOPIC_ICONS[id as keyof typeof TOPIC_ICONS]) || Layers;
  },
} as const;
