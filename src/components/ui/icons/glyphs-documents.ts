/**
 * Documents, folders and lists — the containers.
 *
 * One page silhouette and one folder silhouette are reused by every member of
 * their family, so a code file and a spreadsheet are visibly the same object
 * with a different thing written on it. The alternative (each variant redrawn
 * to fit its payload) is what makes a file list look ragged at 16px.
 *
 * Folders carry `data-part="lid"`: on hover the front face tips forward, which
 * is the one glyph gesture in the set that reports a state rather than
 * decorating one — closed becoming open.
 */
import { createIcon as icon, p, c, rect, dot } from "./create-icon";

/** The shared page: 5 → 19 wide, 3.4 → 20.6 tall, corner folded at 13.8. */
const PAGE = p(
  "M13.8 3.4H7.6A2.6 2.6 0 0 0 5 6v12a2.6 2.6 0 0 0 2.6 2.6h8.8a2.6 2.6 0 0 0 2.6-2.6V8.6z"
);
const FOLD = p("M13.8 3.4v3.4a1.8 1.8 0 0 0 1.8 1.8H19");

/** The shared folder body, tab on the left, 3.4 → 20.6 wide. */
const FOLDER = p(
  "M3.4 7.4a2.6 2.6 0 0 1 2.6-2.6h3.1a1.8 1.8 0 0 1 1.5.8l.8 1.2a1.8 1.8 0 0 0 1.5.8H18a2.6 2.6 0 0 1 2.6 2.6v6.6A2.6 2.6 0 0 1 18 19.6H6a2.6 2.6 0 0 1-2.6-2.6z"
);

/* — Pages ——————————————————————————————————————————————————————————— */

export const FileText = icon("file-text", [PAGE, FOLD, p("M8.4 12.6h6"), p("M8.4 16.2h4.2")]);
export const FileCode = icon("file-code", [
  PAGE,
  FOLD,
  p("M10.4 12.4 8.2 14.6l2.2 2.2"),
  p("M13.6 12.4l2.2 2.2-2.2 2.2"),
]);
export const FileCode2 = FileCode;
export const FileSearch = icon("file-search", [
  PAGE,
  FOLD,
  c(11.4, 14.4, 2.6),
  p("M13.3 16.3 15.4 18.4"),
]);
export const FileSpreadsheet = icon("file-spreadsheet", [
  PAGE,
  FOLD,
  p("M8.2 12.6h7.6"),
  p("M8.2 16.4h7.6"),
  p("M12 12.6v5.6"),
]);
export const FileUp = icon("file-up", [
  PAGE,
  FOLD,
  p("M12 18.2v-5"),
  p("M9.8 15.4 12 13.2l2.2 2.2", "arrow-up"),
]);
export const ScrollText = icon("scroll-text", [
  p("M6.8 4.4h10.6a2.4 2.4 0 0 1 2.4 2.4v10.4a2.4 2.4 0 0 1-2.4 2.4H6.6"),
  p("M6.8 4.4A2.4 2.4 0 0 0 4.4 6.8v1.6h4.8V6.8a2.4 2.4 0 0 0-2.4-2.4"),
  p("M6.6 19.6a2.4 2.4 0 0 1-2.4-2.4v-1.6"),
  p("M9.2 9.6h6.6"),
  p("M9.2 13.4h6.6"),
]);
export const TextQuote = icon("text-quote", [
  p("M4.4 7.4h15.2"),
  p("M9.4 12h10.2"),
  p("M9.4 16.6h10.2"),
  p("M4.6 11.6v5.4"),
]);
export const TextSearch = icon("text-search", [
  p("M4.4 7.4h15.2"),
  p("M4.4 12h5.2"),
  p("M4.4 16.6h4.2"),
  c(15.4, 15.4, 3.4),
  p("M17.9 17.9 20.4 20.4"),
]);
export const BookOpen = icon("book-open", [
  p("M12 7.6v12"),
  p("M12 7.6C10.8 6.1 9 5.4 6.6 5.4H4.4a.8.8 0 0 0-.8.8v10.4a.8.8 0 0 0 .8.8h2.2c2.4 0 4.2.7 5.4 2.2"),
  p("M12 7.6c1.2-1.5 3-2.2 5.4-2.2h2.2a.8.8 0 0 1 .8.8v10.4a.8.8 0 0 1-.8.8h-2.2c-2.4 0-4.2.7-5.4 2.2"),
]);
export const LibraryBig = icon("library-big", [
  rect(3.2, 4.6, 4.4, 14.8, 1.8),
  rect(9.4, 4.6, 4.4, 14.8, 1.8),
  p("M16.6 5.6l2.6.7a1.2 1.2 0 0 1 .8 1.5l-3 11.1a1.2 1.2 0 0 1-1.5.8l-.4-.1"),
]);
export const BookmarkPlus = icon("bookmark-plus", [
  p("M18.4 20.4 12 16l-6.4 4.4V6.2a2.6 2.6 0 0 1 2.6-2.6h7.6a2.6 2.6 0 0 1 2.6 2.6z"),
  p("M12 7.4v5"),
  p("M9.5 9.9h5"),
]);
export const NotebookPen = icon("notebook-pen", [
  p("M14.4 3.6H8a2.6 2.6 0 0 0-2.6 2.6v11.6A2.6 2.6 0 0 0 8 20.4h7.4a2.6 2.6 0 0 0 2.6-2.6v-2.6"),
  p("M5.4 8.4H3.2"),
  p("M5.4 12H3.2"),
  p("M5.4 15.6H3.2"),
  p("M18.2 4.2a1.9 1.9 0 0 1 2.7 2.7l-5.2 5.2-3 .3.3-3z", "accent"),
]);

/* — Folders ————————————————————————————————————————————————————————— */

export const Folder = icon("folder", [FOLDER]);
export const FolderClosed = icon("folder-closed", [FOLDER, p("M3.4 11h17.2")]);
export const FolderOpen = icon("folder-open", [
  p("M3.4 8.2V7.4a2.6 2.6 0 0 1 2.6-2.6h3.1a1.8 1.8 0 0 1 1.5.8l.8 1.2a1.8 1.8 0 0 0 1.5.8H18a2.6 2.6 0 0 1 2.6 2.6v.6"),
  p("M3.4 8.2h17.6a1.4 1.4 0 0 1 1.36 1.74l-1.7 7A2.6 2.6 0 0 1 18.1 19H5.9a2.6 2.6 0 0 1-2.52-1.98z", "lid"),
]);
export const FolderCode = icon("folder-code", [
  FOLDER,
  p("M10.4 11.6 8.4 13.6l2 2"),
  p("M13.6 11.6l2 2-2 2"),
]);
export const FolderInput = icon("folder-input", [
  FOLDER,
  p("M8.6 13.4h6.8"),
  p("M13.2 11.2l2.2 2.2-2.2 2.2", "arrow-right"),
]);
export const FolderLock = icon("folder-lock", [
  FOLDER,
  rect(9.6, 12.6, 4.8, 4, 1.2),
  p("M10.8 12.6v-1.2a1.2 1.2 0 0 1 2.4 0v1.2"),
]);

/* — Storage ————————————————————————————————————————————————————————— */

export const Archive = icon("archive", [
  rect(3.4, 4, 17.2, 4.4, 1.8, "lid"),
  p("M5.2 8.4v9.2a2.4 2.4 0 0 0 2.4 2.4h8.8a2.4 2.4 0 0 0 2.4-2.4V8.4"),
  p("M10 12.2h4"),
]);
export const ArchiveRestore = icon("archive-restore", [
  rect(3.4, 4, 17.2, 4.4, 1.8),
  p("M5.2 8.4v9.2a2.4 2.4 0 0 0 2.4 2.4h2.2"),
  p("M18.8 8.4v9.2a2.4 2.4 0 0 1-2.4 2.4h-2.2"),
  p("M12 18.4v-6.2"),
  p("M9.8 14.4 12 12.2l2.2 2.2", "arrow-up"),
]);
export const Inbox = icon("inbox", [
  p("M3.4 13.4h4l1.4 2.4h6.4l1.4-2.4h4"),
  p("M5.9 5.6h12.2a2 2 0 0 1 1.88 1.32l1.42 5.3a2 2 0 0 1 .1.66v3.72a2.6 2.6 0 0 1-2.6 2.6H5.1a2.6 2.6 0 0 1-2.6-2.6v-3.72a2 2 0 0 1 .1-.66l1.42-5.3A2 2 0 0 1 5.9 5.6"),
]);
export const Save = icon("save", [
  p("M5.4 3.6h10.2L20.4 8.4v10a2.6 2.6 0 0 1-2.6 2.6H6.2a2.6 2.6 0 0 1-2.6-2.6V6.2a2.6 2.6 0 0 1 2.6-2.6"),
  p("M7.6 3.6v4.2h7.2V3.6"),
  rect(7.6, 13.2, 8.8, 7.8, 1.6),
]);
export const Copy = icon("copy", [
  rect(8.4, 8.4, 12, 12, 3),
  p("M15.6 5.6A2.6 2.6 0 0 0 13 3H6.2A3.2 3.2 0 0 0 3 6.2V13a2.6 2.6 0 0 0 2.6 2.6"),
]);
export const Trash2 = icon("trash-2", [
  p("M4.4 6.8h15.2", "lid"),
  p("M9.4 6.8V5.4a1.8 1.8 0 0 1 1.8-1.8h1.6a1.8 1.8 0 0 1 1.8 1.8v1.4", "lid"),
  p("M6.4 6.8v11.4a2.4 2.4 0 0 0 2.4 2.4h6.4a2.4 2.4 0 0 0 2.4-2.4V6.8"),
  p("M10.2 11v5.4"),
  p("M13.8 11v5.4"),
]);

/* — Editing ————————————————————————————————————————————————————————— */

export const Pencil = icon("pencil", [
  p("M17.3 3.4a2.4 2.4 0 0 1 3.3 3.3L8.6 18.8l-4.4 1.4 1.4-4.4z"),
  p("M15.2 5.5 18.5 8.8"),
]);
export const Edit3 = icon("edit-3", [
  p("M17.3 3.4a2.4 2.4 0 0 1 3.3 3.3L8.6 18.8l-4.4 1.4 1.4-4.4z"),
  p("M12.8 20.4h7.8"),
]);
export const SquarePen = icon("square-pen", [
  p("M12.6 4.4H6.6A2.6 2.6 0 0 0 4 7v10.4a2.6 2.6 0 0 0 2.6 2.6H17a2.6 2.6 0 0 0 2.6-2.6v-6"),
  p("M17.1 3.3a2.1 2.1 0 0 1 3 3L12.4 14l-3.5.9.9-3.5z"),
]);
export const PenTool = icon("pen-tool", [
  p("M12 19.2 4.6 11.8l2.2-7.2 7.2-2.2 7.4 7.4-2.2 7.2-7.2 2.2z"),
  p("M9.9 14.1 3.6 20.4"),
  c(12.9, 11.1, 2.2),
]);

/* — Lists ——————————————————————————————————————————————————————————— */

const LIST_ROWS = [p("M10 7.4h9.6"), p("M10 12h9.6"), p("M10 16.6h9.6")];

export const List = icon("list", [...LIST_ROWS, dot(5.4, 7.4, 1.15), dot(5.4, 12, 1.15), dot(5.4, 16.6, 1.15)]);
export const ListChecks = icon("list-checks", [
  p("M11.4 7.4h8.2"),
  p("M11.4 16.6h8.2"),
  p("M3.6 7.2 5.2 8.8 8.4 5.4"),
  p("M3.6 16.4 5.2 18l3.2-3.4"),
]);
export const ListTodo = icon("list-todo", [
  rect(3.4, 4.6, 5.2, 5.2, 1.6),
  p("M11.6 7.2h8"),
  p("M11.6 16.8h8"),
  p("M4.4 15.4 6 17l3.2-3.4"),
]);
export const ListPlus = icon("list-plus", [
  p("M4.4 7.4h11"),
  p("M4.4 12h11"),
  p("M4.4 16.6h6"),
  p("M16.8 14.2v5.2"),
  p("M14.2 16.8h5.2"),
]);
export const ListMinus = icon("list-minus", [
  p("M4.4 7.4h11"),
  p("M4.4 12h11"),
  p("M4.4 16.6h6"),
  p("M14.2 16.8h5.2"),
]);
export const Layers = icon("layers", [
  p("M12 3.4 20.6 8 12 12.6 3.4 8z", "lid"),
  p("M3.4 13.2 12 17.8l8.6-4.6"),
]);
export const Layers3 = icon("layers-3", [
  p("M12 3.4 20.6 7.6 12 11.8 3.4 7.6z"),
  p("M3.4 12 12 16.2l8.6-4.2"),
  p("M3.4 16.4 12 20.6l8.6-4.2"),
]);
export const LayoutGrid = icon("layout-grid", [
  rect(3.6, 3.6, 7.2, 7.2, 2.2),
  rect(13.2, 3.6, 7.2, 7.2, 2.2),
  rect(3.6, 13.2, 7.2, 7.2, 2.2),
  rect(13.2, 13.2, 7.2, 7.2, 2.2),
]);
export const LayoutTemplate = icon("layout-template", [
  rect(3.4, 4, 17.2, 16, 3),
  p("M3.4 9.6h17.2"),
  p("M12 9.6v10.4"),
]);
export const Presentation = icon("presentation", [
  p("M3.4 4h17.2"),
  p("M4.6 4v9.4a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2V4"),
  p("M9.6 20.4 12 17l2.4 3.4"),
]);
