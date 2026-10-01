/**
 * Alevr's semantic icon inventory: every row of NAMES_AND_ICONS.md
 * ("Semantic icon inventory"), each label resolved to one drawing in this set.
 *
 * Pure data (no imports), so the native generator and any audit script can
 * read it with type stripping alone, as they read drawings.ts. `icon` is the
 * name a call site should ask for; an alias is used where the brand's label
 * differs from the drawing's own name, so the call site reads like the label.
 * `direction` quotes the brand's drawing direction for that group.
 */
export type InventoryRow = {
  group: string;
  direction: string;
  items: { label: string; icon: string }[];
};

export const SEMANTIC_INVENTORY: InventoryRow[] = [
  {
    group: "Primary destinations",
    direction: "Open conversation contour; open elliptical path; bracket pair with inset cursor",
    items: [
      { label: "Chat", icon: "chat" },
      { label: "Orbit", icon: "orbit" },
      { label: "Code", icon: "code" },
    ],
  },
  {
    group: "Context destinations",
    direction: "Folded folder; aligned document spines; balanced adjustment sliders",
    items: [
      { label: "Projects", icon: "projects" },
      { label: "Library", icon: "library" },
      { label: "Customize", icon: "customize" },
    ],
  },
  {
    group: "Agent setup",
    direction: "Existing New convention; simple person outline; abstract shape swatch",
    items: [
      { label: "Create agent", icon: "create-agent" },
      { label: "Profile", icon: "profile" },
      { label: "Appearance", icon: "appearance" },
    ],
  },
  {
    group: "Extensions",
    direction: "Connected framed tiles; folded reusable instruction sheet; clock with repeat path",
    items: [
      { label: "Apps", icon: "apps" },
      { label: "Skills", icon: "skills" },
      { label: "Routines", icon: "routines" },
    ],
  },
  {
    group: "Personal context",
    direction: "Layered recall cards; ruled sheet with inset line",
    items: [
      { label: "Memory", icon: "memory" },
      { label: "Instructions", icon: "instructions" },
    ],
  },
  {
    group: "Discovery",
    direction: "Magnifier; sparse sliders; direction with ordered lines",
    items: [
      { label: "Search", icon: "search" },
      { label: "Filter", icon: "filter" },
      { label: "Sort", icon: "sort" },
    ],
  },
  {
    group: "Conversation input",
    direction: "Plus; paperclip; at sign; microphone; up arrow; square",
    items: [
      { label: "Add", icon: "add" },
      { label: "Attach", icon: "attach" },
      { label: "Mention", icon: "mention" },
      { label: "Mic", icon: "mic" },
      { label: "Send", icon: "send" },
      { label: "Stop", icon: "stop" },
    ],
  },
  {
    group: "Voice",
    direction: "Audio contour; crossed mic; speaker; mic plus insertion cursor",
    items: [
      { label: "Voice", icon: "voice" },
      { label: "Mute", icon: "mic-mute" },
      { label: "Volume", icon: "volume" },
      { label: "Dictation", icon: "dictation" },
    ],
  },
  {
    group: "Output operations",
    direction: "Overlapping sheets; check; outward link; down tray; up tray",
    items: [
      { label: "Copy", icon: "copy" },
      { label: "Copied", icon: "copied" },
      { label: "Share", icon: "share" },
      { label: "Download", icon: "download" },
      { label: "Upload", icon: "upload" },
    ],
  },
  {
    group: "Editing",
    direction: "Pencil; text cursor; paired sheets; bin; returning arrow",
    items: [
      { label: "Edit", icon: "edit" },
      { label: "Rename", icon: "rename" },
      { label: "Duplicate", icon: "duplicate" },
      { label: "Delete", icon: "delete" },
      { label: "Restore", icon: "restore" },
    ],
  },
  {
    group: "Workspace operations",
    direction: "Outward arrow; corner expansion; inset corners; split pane; cross",
    items: [
      { label: "Open", icon: "open" },
      { label: "Expand", icon: "expand" },
      { label: "Collapse", icon: "collapse" },
      { label: "Sidebar", icon: "sidebar" },
      { label: "Close", icon: "close" },
    ],
  },
  {
    group: "Navigation",
    direction: "Existing arrows/chevrons; stable ellipsis",
    items: [
      { label: "Back", icon: "back" },
      { label: "Forward", icon: "forward" },
      { label: "Previous", icon: "previous" },
      { label: "Next", icon: "next" },
      { label: "More", icon: "more" },
    ],
  },
  {
    group: "Runtime",
    direction: "Triangle; two strokes; return arrow; paired arcs; cross",
    items: [
      { label: "Play", icon: "play" },
      { label: "Pause", icon: "pause" },
      { label: "Retry", icon: "retry" },
      { label: "Refresh", icon: "refresh" },
      { label: "Cancel", icon: "cancel" },
    ],
  },
  {
    group: "Work evidence",
    direction: "Ordered steps; aligned event lines; folded slip; layered history sheets",
    items: [
      { label: "Plan", icon: "plan" },
      { label: "Activity", icon: "activity" },
      { label: "Receipt", icon: "receipt" },
      { label: "Versions", icon: "versions" },
    ],
  },
  {
    group: "Approvals",
    direction: "Check; question in open contour; barred entry; lock",
    items: [
      { label: "Approve", icon: "approve" },
      { label: "Ask first", icon: "ask-first" },
      { label: "Blocked", icon: "blocked" },
      { label: "Permission", icon: "permission" },
    ],
  },
  {
    group: "Research",
    direction: "Document plus magnifier; paired pages; quotation; chain",
    items: [
      { label: "Research", icon: "research" },
      { label: "Sources", icon: "sources" },
      { label: "Citation", icon: "citation" },
      { label: "Link", icon: "link" },
    ],
  },
  {
    group: "Code",
    direction: "Terminal prompt; fork; center node with line; plus/minus rows; inspected sheet",
    items: [
      { label: "Terminal", icon: "terminal" },
      { label: "Branch", icon: "branch" },
      { label: "Commit", icon: "commit" },
      { label: "Diff", icon: "diff" },
      { label: "Review", icon: "review" },
    ],
  },
  {
    group: "Agent tools",
    direction: "Monitor; view frame; browser rectangle; folder/document",
    items: [
      { label: "Computer", icon: "computer" },
      { label: "Preview", icon: "preview" },
      { label: "Browser", icon: "browser" },
      { label: "Files", icon: "files" },
    ],
  },
  {
    group: "Documents and media",
    direction: "File outline with meaningful internal detail, simplified at 16 px",
    items: [
      { label: "Document", icon: "document" },
      { label: "Sheet", icon: "sheet" },
      { label: "Deck", icon: "deck" },
      { label: "Image", icon: "file-image" },
      { label: "Audio", icon: "audio" },
      { label: "Video", icon: "video" },
    ],
  },
  {
    group: "Organization",
    direction: "Pin; pin with removal cut; bookmark; storage box",
    items: [
      { label: "Pin", icon: "pin" },
      { label: "Unpin", icon: "unpin" },
      { label: "Bookmark", icon: "bookmark" },
      { label: "Archive", icon: "archive" },
    ],
  },
  {
    group: "Account and settings",
    direction: "Person; gear; card; question; outward doorway",
    items: [
      { label: "Account", icon: "account" },
      { label: "Settings", icon: "settings" },
      { label: "Billing", icon: "billing" },
      { label: "Help", icon: "help" },
      { label: "Sign out", icon: "sign-out" },
    ],
  },
  {
    group: "System",
    direction: "Bell; globe; accessibility figure; half-tone circle",
    items: [
      { label: "Notifications", icon: "notifications" },
      { label: "Language", icon: "language" },
      { label: "Accessibility", icon: "accessibility" },
      { label: "Theme", icon: "theme" },
    ],
  },
  {
    group: "Truthful status",
    direction: "Check; triangle; error contour; real progress drawing only when appropriate",
    items: [
      { label: "Success", icon: "success" },
      { label: "Warning", icon: "warning" },
      { label: "Error", icon: "error" },
      { label: "Loading", icon: "loading" },
    ],
  },
];
