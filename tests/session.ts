import { hkdfSync } from "node:crypto";
import { EncryptJWT } from "jose";

export const testSecret = "b3".repeat(32);
export const testScopes = "openid profile email offline_access read:me:connected_accounts create:me:connected_accounts delete:me:connected_accounts";

export async function encryptedSession(subject: string, tenantOrigin: string) {
  const now = Math.floor(Date.now() / 1000);
  const key = new Uint8Array(hkdfSync("sha256", testSecret, "", "JWE CEK", 32));
  return new EncryptJWT({
    user: { sub: `auth0|${subject}`, name: subject, email: `${subject}@example.test` },
    tokenSet: { accessToken: `${subject}-auth0-access`, refreshToken: `${subject}-auth0-refresh`, expiresAt: now + 3600, scope: testScopes, audience: `${tenantOrigin}/me/` },
    internal: { sid: `${subject}-session`, createdAt: now },
  }).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setExpirationTime(now + 3600).encrypt(key);
}
