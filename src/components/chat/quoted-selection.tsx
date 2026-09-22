import { Crop, SquareDashedMousePointer, TextQuote } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ParsedQuotedMessage } from "@/lib/quote-context";

/**
 * A quoted selection, read back out of a sent turn (see `parseQuotedMessage`).
 *
 * The same neutral plate the composer drew the quote on before it was sent —
 * mono label, the file or artifact it came from, where in it — so the turn
 * reads as "about THIS" followed by the person's own words, not as a block of
 * protocol. The quoted words are clamped: they are a reminder of what was
 * selected, and the full passage is in the document they came from.
 */
export function QuotedSelection({ quote, standalone }: { quote: ParsedQuotedMessage; standalone: boolean }) {
  const Glyph = quote.kind === "area" ? Crop : quote.kind === "element" ? SquareDashedMousePointer : TextQuote;
  const verb = quote.mode === "modify" ? "Modify" : quote.kind === "area" ? "Area" : "Selection";
  return (
    <div
      data-no-auto-translate
      className={cn(
        "flex w-full max-w-md items-start gap-2.5 rounded-control border border-border/70 bg-card px-3 py-2 text-left",
        !standalone && "mb-1.5",
      )}
    >
      <span aria-hidden className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-xs border border-border/70 bg-secondary text-muted-foreground">
        <Glyph className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 font-mono text-label text-muted-foreground">{verb}</span>
          <span className="min-w-0 truncate text-ui font-medium text-foreground">{quote.title}</span>
          {quote.location && <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">{quote.location}</span>}
        </div>
        {quote.text && (
          <p className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-caption leading-relaxed text-muted-foreground">
            {quote.text.replace(/[ \t]+/g, " ").trim()}
          </p>
        )}
      </div>
    </div>
  );
}
