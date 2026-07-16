import { z } from "zod";
import { apiV1Error, apiV1Json } from "@/lib/api-v1";
import { rotateNativeRefreshToken } from "@/lib/native-auth";

export const runtime = "nodejs";

const bodySchema = z.object({ refreshToken: z.string().min(32).max(512) }).strict();

export async function POST(request: Request) {
  try {
    const { refreshToken } = bodySchema.parse(await request.json());
    return apiV1Json(await rotateNativeRefreshToken(refreshToken));
  } catch (error) {
    return apiV1Error(error);
  }
}
