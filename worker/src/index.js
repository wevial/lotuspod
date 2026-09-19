import { identify } from "./access.js";

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

// The route table: the one place a path is granted. Whatever is not
// granted here is refused.
function route(who, request) {
  const segment = firstSegment(request.url);
  // Files the Worker reads but never serves.
  if (segment === null || segment === "_lotuspod") return { status: 404 };
  // No /api/ route exists yet.
  if (segment === "api") return { status: 404 };
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
    if (!granted.assets) return refuse(granted.status, granted.headers);
    return env.ASSETS.fetch(request);
  },
};
