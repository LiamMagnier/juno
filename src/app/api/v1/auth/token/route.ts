import { z } from "zod";
import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { exchangeNativeAuthorizationCode } from "@/lib/native-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1).max(512),
  codeVerifier: z.string().min(43).max(256),
  redirectUri: z.string().max(200),
  installationId: z.string().min(16).max(200),
  deviceName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(40),
  appVersion: z.string().trim().min(1).max(40),
}).strict();

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    return apiV1Json(await exchangeNativeAuthorizationCode(body), { status: 200 });
  } catch (error) {
    return apiV1Error(error);
  }
}
