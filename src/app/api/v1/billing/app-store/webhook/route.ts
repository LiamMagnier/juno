// Keep this alias on the Node runtime too. App Router does not reliably infer
// segment config through a re-export.
export const runtime = "nodejs";

export { POST } from "@/app/api/billing/app-store/webhook/route";
