// Next.js only recognizes segment configuration declared in this module; a
// re-exported `runtime` silently falls back to the default runtime at build.
export const runtime = "nodejs";

export { GET, POST } from "@/app/api/v1/billing/app-store/route";
