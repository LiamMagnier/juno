"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import LibraryFilesPage from "@/components/library/library-files-page";
import { LibraryTrash } from "@/components/library/library-trash";
import { LibraryHome } from "@/components/library/library-home";

function LibraryDestination() {
  const params = useSearchParams();
  if (params.get("view") === "trash") return <LibraryTrash />;
  return params.get("view") === "files" ? <LibraryFilesPage /> : <LibraryHome />;
}

export default function LibraryPage() {
  return <Suspense fallback={<p className="p-8 text-muted-foreground" role="status">Loading Library…</p>}><LibraryDestination /></Suspense>;
}
