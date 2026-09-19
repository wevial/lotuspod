import { identify } from "./access.js";
import { issueCsrf } from "./csrf.js";

function refuse(status, headers = {}) {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

// The first path segment as the assets binding would see it: percent
// escapes decoded and empty segments skipped. Undecodable paths are null.
function firstSegment(url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  return path.split(/[/\\]/).find((segment) => segment !== "") ?? "";
}

// The /api/ routes, none of which is ever served from the assets binding.
function routeApi(who, request) {
  if (new URL(request.url).pathname !== "/api/session") return { status: 404 };
  if (who.kind !== "user") return { status: 403 };
  if (request.method !== "GET") return { status: 405, headers: { Allow: "GET" } };
  return { session: true };
}

// The signed-in address and a request token bound to this Access session.
async function session(who, env) {
  const issued = await issueCsrf(who, env);
  if (!issued) return refuse(503, { Vary: "Cookie" });
  return Response.json(
    {
      actor: who.email,
      csrf: issued.token,
      expiresAt: new Date(issued.expiresAt).toISOString(),
    },
    { headers: { "Cache-Control": "no-store", Vary: "Cookie" } },
  );
}

// The route table: the one place a path is granted. Whatever is not
// granted here is refused.
function route(who, request) {
  const segment = firstSegment(request.url);
  // Files the Worker reads but never serves.
  if (segment === null || segment === "_lotuspod") return { status: 404 };
  if (segment === "api") return routeApi(who, request);
  if (who.kind !== "user") return { status: 403 };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { status: 405, headers: { Allow: "GET, HEAD" } };
  }
  return { assets: true };
}

export default {
  async fetch(request, env) {
    const who = await identify(request, env);
    if (!who) return refuse(403);
    const granted = route(who, request);
    if (granted.session) return session(who, env);
    if (!granted.assets) return refuse(granted.status, granted.headers);
    return env.ASSETS.fetch(request);
  },
};
