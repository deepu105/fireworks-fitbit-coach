import { ConfigurationError } from "./config";

export class PublicError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) { super(message); }
}

export const privateHeaders = { "Cache-Control": "no-store, private" };
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: privateHeaders });

export function errorResponse(error: unknown) {
  if (error instanceof PublicError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof Error && (error.cause as { status?: number } | undefined)?.status === 429) {
    return json({ error: "Auth0's request limit was reached. Wait a moment, then retry the connection check.", code: "AUTH0_RATE_LIMIT" }, 429);
  }
  if (error instanceof ConfigurationError) return json({ error: error.message, code: "CONFIGURATION" }, 503);
  return json({ error: "The request failed. Check the app configuration or try again.", code: "REQUEST_FAILED" }, 502);
}

export async function requireSession(getSession: () => Promise<{ user: { sub: string } } | null>) {
  const session = await getSession();
  if (!session?.user.sub) throw new PublicError("SIGN_IN_REQUIRED", "Sign in to continue.", 401);
  return session;
}

export function requireSameOrigin(request: Request, appOrigin: string) {
  if (request.headers.get("origin") !== appOrigin) {
    throw new PublicError("ORIGIN_NOT_ALLOWED", "Use this application's page to make the request.", 403);
  }
}

export async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new PublicError("INVALID_REQUEST", "Send a JSON request.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError("INVALID_REQUEST", "Send a JSON request.", 400);
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_048) {
        await reader.cancel();
        throw new PublicError("REQUEST_TOO_LARGE", "This request is too large.", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text) as unknown; }
    catch { throw new PublicError("INVALID_REQUEST", "Send a valid JSON request.", 400); }
  } finally { reader.releaseLock(); }
}
