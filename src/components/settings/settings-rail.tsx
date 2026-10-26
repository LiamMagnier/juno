"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Pressable } from "@/components/ui/pressable";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  ALL_SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  settingsSection,
  settingsSectionMatches,
  type SettingsSectionId,
  type SettingsSectionMeta,
} from "@/components/settings/settings-sections";
import { ChevronDown, Search, X } from "@/components/ui/icons";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The ids that tie a tab to its panel, shared with SettingsPane. */
export const settingsTabId = (id: SettingsSectionId) => `settings-tab-${id}`;
export const settingsPanelId = (id: SettingsSectionId) => `settings-panel-${id}`;
/** Marks the narrow rail's section menu, so the modal can focus it on open. */
export const SETTINGS_SECTION_MENU_ATTR = "data-settings-section-menu";

/** The rail in group order, filtered by a search (label or keywords). */
function useGroups(query: string) {
  const q = query.trim().toLowerCase();
  const groups = React.useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        label: group.label,
        sections: group.ids
          .map((id) => ALL_SETTINGS_SECTIONS.find((s) => s.id === id))
          .filter((s): s is SettingsSectionMeta => !!s)
          .filter((s) => settingsSectionMatches(s, q)),
      })).filter((group) => group.sections.length > 0),
    [q]
  );
  const ordered = React.useMemo(() => groups.flatMap((g) => g.sections), [groups]);
  return { q, groups, ordered };
}

/**
 * The search field. Enter opens the first section the search left, the way a
 * command menu does; Esc clears a query first, then lets go of the field (it
 * never reaches the page's own Esc, which leaves settings). The browser's own
 * clear glyph is hidden (it drew in a foreign style) and a touch keyboard has
 * no Esc, so a ✕ takes its place while there is a query.
 */
function SearchField({
  inputRef,
  query,
  onQuery,
  onSubmit,
  className,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  onSubmit: () => void;
  className?: string;
}) {
  return (
    <div className={cn("group/search relative", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors duration-fast ease-out-soft group-focus-within/search:text-foreground"
      />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (query.trim()) onSubmit();
            return;
          }
          if (e.key !== "Escape") return;
          if (query) {
            e.preventDefault();
            e.stopPropagation();
            onQuery("");
            return;
          }
          // Inside the sheet an empty field's Esc closes the sheet (Radix);
          // in the column it lets go of the field.
          if (!e.currentTarget.closest("[role=dialog][data-settings-sheet]")) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        enterKeyHint="go"
        className="peer h-9 w-full rounded-control border border-transparent bg-foreground/[0.045] pl-8 pr-8 text-ui text-foreground outline-none transition-[background-color,border-color,box-shadow] duration-fast ease-out-soft placeholder:text-muted-foreground hover:bg-foreground/[0.07] focus:border-border focus:bg-background focus:shadow-[0_1px_2px_hsl(var(--foreground)/0.06)] kbd-focus:border-[hsl(var(--ring)/0.55)] kbd-focus:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)] coarse:h-11 coarse:pr-12 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onQuery("");
            inputRef.current?.focus();
          }}
          className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-control text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground coarse:size-11"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
      {/* The key that opens the field, shown only while it is empty and idle. */}
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 grid h-5 min-w-5 -translate-y-1/2 place-items-center rounded-xs border border-border/80 px-1 font-mono text-micro leading-none text-muted-foreground transition-opacity duration-fast ease-out-soft peer-focus:opacity-0 peer-[:not(:placeholder-shown)]:opacity-0 coarse:hidden"
      >
        /
      </kbd>
    </div>
  );
}

const groupLabelClass = "px-2.5 pb-1.5 pt-5 text-caption text-muted-foreground first:pt-0";

function NoMatch({ query }: { query: string }) {
  return <p className="px-2.5 py-2 text-ui text-muted-foreground">No setting matches “{query.trim()}”.</p>;
}

/** The row's glyph, label and (while searching) the ↵ that opens it. */
function RowContent({ section, selected, enterHint }: { section: SettingsSectionMeta; selected: boolean; enterHint: boolean }) {
  return (
    <>
      {/* The ink cross-fades on a wrapper, not on the glyph: a `transition-*`
          utility on the svg would replace the base-layer transition its hover
          articulation runs on. */}
      <span
        className={cn(
          "relative flex shrink-0 transition-colors duration-fast ease-out-soft",
          selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
        )}
      >
        <section.icon className="size-4" aria-hidden="true" />
      </span>
      <span className={cn("relative truncate", selected && "text-foreground")}>{section.label}</span>
      {/* The key that opens it, in the field's own "/" keycap style. Not on
          a touch screen, whose keyboard has no ↵ and labels its own key. */}
      {enterHint && (
        <kbd
          aria-hidden="true"
          className="relative ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-xs border border-border/80 px-1 font-mono text-micro leading-none text-muted-foreground coarse:hidden"
        >
          ↵
        </kbd>
      )}
    </>
  );
}

// `group` for the glyph ink. 44px on a touch screen (WCAG 2.5.8).
const rowClass = "group w-full shrink-0 whitespace-nowrap coarse:min-h-11";

/**
 * The settings rail: one row per section, text on the surface, with the open
 * one on the selected tone. The same rail serves the modal and the `/settings`
 * page, and the two are different patterns, marked as such:
 *
 *   - In the modal the rows switch a pane in place, so the rail is a
 *     `tablist` of `tab`s with `aria-selected`, one roving tab stop and arrow
 *     keys between them, and the pane is the matching `tabpanel`.
 *   - On the page the rows are links carrying `?section=`, so a section can be
 *     bookmarked; the rail is a <nav> and the open row is
 *     `aria-current="page"`. They replace the history entry rather than
 *     pushing one, so Back leaves settings instead of replaying every section
 *     the reader glanced at.
 *
 * A COLUMN OR A MENU, decided by the width the rail is GIVEN (its
 * `@container/rail` parent) rather than the window: it has two parents that
 * go side by side at different widths. Narrower than 16rem it is the side
 * column: search, the group names, the rows. Given 16rem or more, it is the
 * stacked layout over the pane (a phone, a narrow window), and there it is
 * ONE ROW naming the open section ("Plan & usage ⌄"), which opens the same
 * grouped column in a sheet.
 *
 * It used to be a horizontal strip of all twenty sections there: about 2.5
 * chips visible in 2,574px of scroller, the group names gone, and the
 * neighbours sliced mid-word at both edges ("Notificatio", "ata & privacy").
 * ChatGPT and iOS answer the same question with a grouped list; the sheet is
 * that list, one tap away, with search at its top.
 *
 * THE SELECTION TRAVELS in the column. It is one shared `layoutId` element
 * rather than a background per row, so choosing a section slides the fill
 * from the old row to the new one on the standard spring. Under reduced
 * motion framer turns the slide into a swap: the app's root MotionConfig maps
 * Settings › Motion (System, Reduced, Full) onto framer.
 *
 * Glyph ink follows ICONS_AND_MOTION.md §1.2: muted at rest, the row's
 * foreground on hover or when selected. The accent is not used: a selected
 * rail row is a place you are, not an action.
 */
export function SettingsRail({
  active,
  onSelect,
  hrefFor,
  className,
}: {
  active: SettingsSectionId;
  onSelect?: (id: SettingsSectionId) => void;
  /** When given, rows render as links to this href. */
  hrefFor?: (id: SettingsSectionId) => string;
  className?: string;
}) {
  const router = useRouter();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const { q, groups, ordered } = useGroups(query);
  const searching = q !== "";

  // "/" puts the cursor in the search field, as it does in most full-window
  // settings, unless the reader is already typing somewhere.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable=true],[role=menu],[role=listbox]")) return;
      const field = searchRef.current;
      // Not while the field is hidden (the narrow rail, whose field lives in
      // its sheet, or a collapsed or unmounted rail).
      if (!field || field.offsetParent === null) return;
      // Inside a dialog, only the dialog the rail itself lives in (the modal).
      const dialog = target?.closest("[role=dialog]");
      if (dialog && !dialog.contains(field)) return;
      e.preventDefault();
      field.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // One indicator per rail instance: the modal and the page never mount
  // together, but a shared id would let them trade the fill if they did.
  const indicatorId = `settings-rail-active-${React.useId()}`;
  // Arrow keys move between tabs and select in the same gesture: the ARIA
  // tabs pattern with automatic activation.
  const tabOption = useRadioGroup(
    ordered,
    ordered.findIndex((s) => s.id === active),
    (section) => onSelect?.(section.id)
  );

  /** While searching, the row Enter would open. */
  const firstMatchId = searching ? ordered[0]?.id : undefined;

  const open = (id: SettingsSectionId) => {
    if (hrefFor) router.replace(hrefFor(id), { scroll: false });
    else onSelect?.(id);
  };

  /** Enter opens the first match, and the question is answered: the rail
   *  comes back whole around the section just opened. Not mid-composition. */
  const openFirstMatch = () => {
    const first = ordered[0];
    if (!first) return;
    open(first.id);
    setQuery("");
    searchRef.current?.blur();
  };
  // Picking a result by pointer answers the search the same way Enter does.
  const clearIfSearching = () => {
    if (searching) setQuery("");
  };

  const indicator = (
    <motion.span
      layoutId={indicatorId}
      aria-hidden="true"
      transition={spring.standard}
      // The radius rides `style` (rounded-control's 8px) so framer keeps the
      // corners true while it scales the fill. `-inset-px` covers the row's
      // border box.
      className="pointer-events-none absolute -inset-px bg-selected"
      style={{ borderRadius: 8 }}
    />
  );
  // The selected row's own fill is cleared: the travelling indicator paints
  // it. The first match wears the hover fill, so what Enter does is visible
  // before it is pressed.
  const columnRowClass = (id: SettingsSectionId, selected: boolean) =>
    cn(rowClass, selected ? "bg-transparent hover:bg-transparent" : id === firstMatchId && "bg-accent");

  const column = (
    <div className="flex flex-col gap-0.5">
      {groups.map((group) => (
        <React.Fragment key={group.label}>
          <p className={groupLabelClass} aria-hidden="true">
            {group.label}
          </p>
          {group.sections.map((section) => {
            const selected = section.id === active;
            const inner = (
              <>
                {selected ? indicator : null}
                <RowContent section={section} selected={selected} enterHint={section.id === firstMatchId} />
              </>
            );
            if (hrefFor) {
              return (
                <Pressable key={section.id} asChild kind="row" selected={selected} className={columnRowClass(section.id, selected)}>
                  <Link
                    href={hrefFor(section.id)}
                    replace
                    scroll={false}
                    data-active={selected}
                    aria-current={selected ? "page" : undefined}
                    onClick={clearIfSearching}
                  >
                    {inner}
                  </Link>
                </Pressable>
              );
            }
            const i = ordered.indexOf(section);
            return (
              <Pressable
                key={section.id}
                type="button"
                kind="row"
                role="tab"
                id={settingsTabId(section.id)}
                aria-selected={selected}
                aria-controls={settingsPanelId(section.id)}
                data-active={selected}
                selected={selected}
                onClick={() => {
                  onSelect?.(section.id);
                  clearIfSearching();
                }}
                className={columnRowClass(section.id, selected)}
                {...tabOption(i)}
              >
                {inner}
              </Pressable>
            );
          })}
        </React.Fragment>
      ))}
      {groups.length === 0 ? <NoMatch query={query} /> : null}
    </div>
  );

  const searchField = <SearchField inputRef={searchRef} query={query} onQuery={setQuery} onSubmit={openFirstMatch} className="mb-4" />;

  return (
    <>
      {/* The column, when the rail has a column's width. */}
      <div className={cn("@[16rem]/rail:hidden", className)}>
        {hrefFor ? (
          <nav aria-label="Settings sections">
            {searchField}
            {column}
          </nav>
        ) : (
          <>
            {searchField}
            <div role="tablist" aria-label="Settings sections" aria-orientation="vertical">
              {column}
            </div>
          </>
        )}
      </div>
      {/* The menu, when the rail is stacked over the pane. */}
      <SectionMenu active={active} open={open} hrefFor={hrefFor} className={cn("hidden @[16rem]/rail:flex", className)} />
    </>
  );
}

/**
 * The narrow rail: the open section as one row, and the grouped column with
 * its search in a sheet. A pick closes the sheet; so does Esc, a scrim tap or
 * a flick down (the dialog's own sheet gestures).
 */
function SectionMenu({
  active,
  open,
  hrefFor,
  className,
}: {
  active: SettingsSectionId;
  open: (id: SettingsSectionId) => void;
  hrefFor?: (id: SettingsSectionId) => string;
  className?: string;
}) {
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLElement>(null);
  const { q, groups, ordered } = useGroups(query);
  const current = settingsSection(active);
  const firstMatchId = q ? ordered[0]?.id : undefined;

  const choose = (id: SettingsSectionId) => {
    setSheetOpen(false);
    setQuery("");
    if (id !== active) open(id);
  };

  return (
    <>
      <button
        type="button"
        {...{ [SETTINGS_SECTION_MENU_ATTR]: "" }}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        onClick={() => setSheetOpen(true)}
        className={cn(
          "group h-11 w-full min-w-0 items-center gap-2.5 rounded-control bg-foreground/[0.045] px-3 text-left text-body text-foreground outline-none transition-colors duration-fast ease-out-soft hover:bg-foreground/[0.07] active:bg-selected focus-visible:outline-none kbd-focus:shadow-[0_0_0_2px_hsl(var(--ring)/0.55)]",
          className
        )}
      >
        <current.icon className="size-4 shrink-0 text-foreground" aria-hidden="true" />
        <span className="sr-only">Settings section: </span>
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <Dialog
        open={sheetOpen}
        onOpenChange={(next) => {
          setSheetOpen(next);
          if (!next) setQuery("");
        }}
      >
        <DialogContent
          data-settings-sheet=""
          hideClose
          aria-describedby={undefined}
          // Focus the open section, not the search field: on a phone a
          // focused field raises the keyboard over the list it filters.
          onOpenAutoFocus={(event) => {
            const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
            if (!row) return;
            event.preventDefault();
            row.focus({ preventScroll: true });
            // Only as far as it takes: the list opens at its top (the group
            // names in view) unless the open section is further down.
            row.scrollIntoView({ block: "nearest" });
          }}
          // A fixed height, so the sheet does not shrink and jump down under
          // the thumb as a search narrows the list.
          className="flex h-[min(85dvh,44rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-sm sm:p-0"
        >
          <div className="shrink-0 px-4 pb-3 pt-4">
            <DialogTitle className="mb-3 px-1 text-heading font-medium">Settings</DialogTitle>
            <SearchField
              inputRef={searchRef}
              query={query}
              onQuery={setQuery}
              onSubmit={() => {
                const first = ordered[0];
                if (first) choose(first.id);
              }}
            />
          </div>
          <nav ref={listRef} aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
            <div className="flex flex-col gap-0.5">
              {groups.map((group) => (
                <React.Fragment key={group.label}>
                  <p className={groupLabelClass} aria-hidden="true">
                    {group.label}
                  </p>
                  {group.sections.map((section) => {
                    const selected = section.id === active;
                    const content = <RowContent section={section} selected={selected} enterHint={section.id === firstMatchId} />;
                    const rowClasses = cn(rowClass, !selected && section.id === firstMatchId && "bg-accent");
                    return hrefFor ? (
                      <Pressable key={section.id} asChild kind="row" selected={selected} className={rowClasses}>
                        <Link
                          href={hrefFor(section.id)}
                          replace
                          scroll={false}
                          data-active={selected}
                          aria-current={selected ? "page" : undefined}
                          onClick={() => {
                            setSheetOpen(false);
                            setQuery("");
                          }}
                        >
                          {content}
                        </Link>
                      </Pressable>
                    ) : (
                      <Pressable
                        key={section.id}
                        type="button"
                        kind="row"
                        selected={selected}
                        data-active={selected}
                        aria-current={selected ? "true" : undefined}
                        onClick={() => choose(section.id)}
                        className={rowClasses}
                      >
                        {content}
                      </Pressable>
                    );
                  })}
                </React.Fragment>
              ))}
              {groups.length === 0 ? <NoMatch query={query} /> : null}
            </div>
          </nav>
        </DialogContent>
      </Dialog>
    </>
  );
}
