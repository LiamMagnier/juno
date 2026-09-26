import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

/**
 * "That did not load", for a page whose whole list failed to arrive.
 *
 * One shape across the app pages. There were five: the page empty state with
 * the error tile (Library, Memory, Projects), the same without a tile
 * (Artifacts), a boxed panel (Connections), the page's own glyph tinted red
 * (Agents) and the Work list's red banner with a Retry (Automations, Skills).
 * Five pictures of one event read as five different problems.
 *
 * The sentence says what is safe when it can (nothing was deleted, the
 * automations keep running), because the fear on a failed load is that the
 * things themselves are gone. Try again carries the refresh mark.
 */
export function LoadError({
  title,
  description = "Check your connection and try again.",
  onRetry,
  className,
}: {
  /** "Couldn’t load your files": what did not arrive, in the page's own noun. */
  title: React.ReactNode;
  description?: React.ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      tone="error"
      icon={StatusIcons.error}
      title={title}
      description={description}
      className={className}
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <ActionIcons.refresh className="size-4" aria-hidden="true" />
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
