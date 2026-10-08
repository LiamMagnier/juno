import * as React from "react";
import { CalendarClock, FileText, Folder, Globe, JunoLibrary, Mail, NotebookPen, Plug } from "@/components/ui/icons";
import type { PrivateSourceKind } from "@/lib/research/private-sources";

/*
 * One glyph per kind of the person's own source (Deep Research's own
 * sources), so a citation, a source row and the scope card's toggle all draw
 * a file as a file and an email as an email — never as a website's favicon.
 */

const ICONS: Record<PrivateSourceKind | "web", React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  web: Globe,
  file: FileText,
  project: Folder,
  library: JunoLibrary,
  memory: NotebookPen,
  calendar: CalendarClock,
  mail: Mail,
  connector: Plug,
};

export function PrivateSourceIcon({ kind, className }: { kind: PrivateSourceKind | "web"; className?: string }) {
  const Icon = ICONS[kind] ?? Plug;
  return <Icon aria-hidden className={className} />;
}
