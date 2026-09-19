// The second lock: validate the Cloudflare Access token on every request.
// Access in front of the hostname is the first lock; nothing here trusts it.

const HEADER = "Cf-Access-Jwt-Assertion";
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

// Team domain -> Map of key id -> CryptoKey, kept for the isolate's lifetime.
const keySets = new Map();

export function decodeBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(text) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(text)));
}

async function fetchKeySet(teamDomain) {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`key set fetch answered ${response.status}`);
  const { keys } = await response.json();
  const keySet = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    const { kty, n, e } = jwk;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty, n, e, alg: "RS256", ext: true },
      ALGORITHM,
      false,
      ["verify"],
    );
    keySet.set(jwk.kid, key);
  }
  keySets.set(teamDomain, keySet);
  return keySet;
}

// The cached key, or after one refetch on an unknown key id, the fresh one.
async function findKey(teamDomain, kid) {
  const cached = keySets.get(teamDomain);
  if (cached && cached.has(kid)) return cached.get(kid);
  return (await fetchKeySet(teamDomain)).get(kid);
}

async function verifiedClaims(token, teamDomain, audience) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const key = await findKey(teamDomain, header.kid);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const genuine = await crypto.subtle.verify(
    ALGORITHM,
    key,
    decodeBase64Url(parts[2]),
    signed,
  );
  if (!genuine) return null;
  const claims = decodeJson(parts[1]);
  if (claims === null || typeof claims !== "object") return null;
  if (claims.iss !== `https://${teamDomain}`) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

export function setting(env, name) {
  const value = env[name];
  return typeof value === "string" && value !== "" ? value : null;
}

// Who is asking: { kind: "user", email, iat } for the maintainer, iat being
// the Access token's own (null if it names none), { kind: "machine", id }
// for the configured service token, and null for nobody. Every missing setting, bad token or failure on the way is nobody.
export async function identify(request, env) {
  const teamDomain = setting(env, "ACCESS_TEAM_DOMAIN");
  const audience = setting(env, "ACCESS_AUD");
  const allowedEmail = setting(env, "ALLOWED_EMAIL");
  if (!teamDomain || !audience || !allowedEmail) return null;
  const token = request.headers.get(HEADER);
  if (!token) return null;
  let claims;
  try {
    claims = await verifiedClaims(token, teamDomain, audience);
  } catch {
    return null;
  }
  if (!claims) return null;
  if (typeof claims.email === "string" && claims.email !== "") {
    const email = claims.email.toLowerCase();
    if (email !== allowedEmail.toLowerCase()) return null;
    return { kind: "user", email, iat: typeof claims.iat === "number" ? claims.iat : null };
  }
  if (typeof claims.common_name === "string" && claims.common_name !== "") {
    const machineId = setting(env, "MACHINE_CLIENT_ID");
    return machineId && claims.common_name === machineId
      ? { kind: "machine", id: machineId }
      : null;
  }
  return null;
}
