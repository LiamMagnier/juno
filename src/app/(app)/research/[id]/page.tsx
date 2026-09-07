import { ResearchWorkspace } from "@/components/research/research-workspace";
export default async function ResearchRunPage({ params }: { params: Promise<{id: string}> }) {
  const { id } = await params;
  return <ResearchWorkspace runId={id} />;
}
