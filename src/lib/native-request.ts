import { authenticateNativeBearer, NativeAuthError } from "@/lib/native-auth";

export async function requireNativeRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) throw new NativeAuthError("unauthenticated", 401, "A bearer token is required.");
  return authenticateNativeBearer(authorization);
}
