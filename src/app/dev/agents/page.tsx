import { Suspense } from "react";
import { notFound } from "next/navigation";
import nextDynamic from "next/dynamic";

const AgentsGallery = nextDynamic(() => import("./gallery").then((m) => m.AgentsGallery));

/** Dev-only: every reworked Agents surface over fixtures (docs/design/agents-rework/DIRECTION.md). */
export default function AgentsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <AgentsGallery />
    </Suspense>
  );
}
