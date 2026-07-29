import { z } from "zod";
import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { signInNativeWithPassword } from "@/lib/native-auth";
import { ipFromHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(200),
  installationId: z.string().min(16).max(200),
  deviceName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(40),
  appVersion: z.string().trim().min(1).max(40),
}).strict();

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await signInNativeWithPassword({
      ...body,
      ip: ipFromHeaders(request.headers),
    });
    return apiV1Json(result, { status: 200 });
  } catch (error) {
    return apiV1Error(error);
  }
}
