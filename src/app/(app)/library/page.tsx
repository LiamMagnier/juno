"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import LibraryFilesPage from "@/components/library/library-files-page";
import { LibraryTrash } from "@/components/library/library-trash";
import { LibraryArtifacts } from "@/components/library/library-artifacts";
import { LibraryHome } from "@/components/library/library-home";
import { LibraryGoogleDrive } from "@/components/library/library-google-drive";

function LibraryDestination() {
  const params = useSearchParams();
  const legacy = params.get("show");
  const view = params.get("view") ?? (legacy === "made" ? "artifacts" : legacy);
  if (view === "artifacts") return <LibraryArtifacts />;
  if (view === "media") return <LibraryHome mediaOnly />;
  if (view === "trash") return <LibraryTrash />;
  if (view === "drive") return <LibraryGoogleDrive connectError={params.get("connect_error")} />;
  return view === "files" ? <LibraryFilesPage /> : <LibraryHome />;
}

export default function LibraryPage() {
  return <Suspense fallback={<p className="p-8 text-muted-foreground" role="status">Loading Library…</p>}><LibraryDestination /></Suspense>;
}
