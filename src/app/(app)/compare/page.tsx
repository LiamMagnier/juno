import type { Metadata } from "next";
import { CompareView } from "@/components/compare/compare-view";
import { PageRoot } from "@/components/app/page-root";

export const metadata: Metadata = { title: "Compare" };

export default function ComparePage() {
  return (
    <PageRoot>
      <CompareView />
    </PageRoot>
  );
}
