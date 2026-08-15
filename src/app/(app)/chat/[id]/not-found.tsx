/**
 * /chat/[id] when the id resolves to nothing.
 *
 * tone="empty", not tone="error": a 404 is not a failure, it is a page that is
 * genuinely not there, and the destructive plate would tell the reader something
 * broke when nothing did. Same reading as the roadmap detail page's own
 * not-found branch.
 */

import Link from "next/link";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function ConversationNotFound() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <EmptyState
          icon={SearchX}
          title="This conversation isn’t here"
          description="It may have been deleted, or the link may belong to a different account. Everything else in your history is untouched."
          action={
            <Button asChild size="sm">
              <Link href="/chat">Back to chat</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
