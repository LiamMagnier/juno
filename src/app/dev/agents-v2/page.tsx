import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AgentsV2Gallery } from "./gallery";

export default function AgentsV2DevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <AgentsV2Gallery />
    </Suspense>
  );
}
