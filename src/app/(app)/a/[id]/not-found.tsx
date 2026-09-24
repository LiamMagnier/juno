/**
 * /a/[id] when the id resolves to nothing the reader can open.
 *
 * One page for "never existed", "deleted" and "someone else's": telling a
 * signed-in stranger that an id is real but not theirs would let anyone probe
 * which ids exist. The sentence covers all three without choosing.
 *
 * tone="empty", not tone="error": a 404 is not a failure, it is a page that is
 * genuinely not there, and the destructive plate would tell the reader
 * something broke when nothing did.
 */

import Link from "next/link";
import { SearchX } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ARTIFACTS_HOME } from "@/lib/artifact-links";

export default function ArtifactNotFound() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <EmptyState
          icon={SearchX}
          title="This artifact isn’t here"
          description="It may have been deleted, or it may belong to a conversation on another account. Your other artifacts are untouched."
          action={
            <Button asChild size="sm">
              <Link href={ARTIFACTS_HOME}>All artifacts</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
