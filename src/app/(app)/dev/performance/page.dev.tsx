import { notFound } from "next/navigation";
import { TranscriptBenchmark } from "./transcript-benchmark";

export default function PerformancePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TranscriptBenchmark />;
}
