const UI_ORIGIN = "https://desktop-web.echo-op.com";
const LOGIN_ORIGIN = "https://echo.echo-op.com";
const AGENT_ORIGIN = "https://agent.echo-op.com";
const AGENT_PREFIX = "/agent-api/";

// Cloudflare folds multiple Set-Cookie headers into one comma-joined header.
// Split the session and rotating refresh cookies back apart before returning them.
function splitSetCookie(value) {
  return String(value).split(/,\s*(?=[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/).map((s) => s.trim()).filter(Boolean);
}

function rebuild(resp) {
  const headers = new Headers();
  for (const [key, value] of resp.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    headers.append(key, value);
  }
  const raw = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  const cookies = (raw && raw.length ? raw : [resp.headers.get("set-cookie")].filter(Boolean))
    .flatMap(splitSetCookie);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

function isLoginSurface(pathname) {
  return pathname.startsWith("/app/") || pathname === "/sentinel-chat.js";
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(AGENT_PREFIX)) {
      const target = AGENT_ORIGIN + "/" + url.pathname.slice(AGENT_PREFIX.length) + url.search;
      const req = new Request(target, request);
      req.headers.set("Origin", url.origin);
      req.headers.set("X-Forwarded-Host", url.hostname);
      const resp = await fetch(req);
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: rebuild(resp),
      });
    }

    const selectedOrigin = isLoginSurface(url.pathname) ? LOGIN_ORIGIN : UI_ORIGIN;
    const uiUrl = new URL(url.toString());
    uiUrl.hostname = new URL(selectedOrigin).hostname;
    uiUrl.protocol = "https:";
    uiUrl.port = "";
    const uiReq = new Request(uiUrl.toString(), request);
    uiReq.headers.set("X-Forwarded-Host", url.hostname);
    const resp = await fetch(uiReq);
    const contentType = resp.headers.get("content-type") || "";

    if (url.pathname.endsWith("/app.js") || contentType.includes("javascript")) {
      let body = await resp.text();
      if (body.includes("https://agent.echo-op.com")) {
        body = body.split("'https://agent.echo-op.com'").join("'/agent-api'")
                   .split('"https://agent.echo-op.com"').join('"/agent-api"');
      }
      const headers = rebuild(resp);
      headers.delete("content-length");
      return new Response(body, { status: resp.status, headers });
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: rebuild(resp),
    });
  },
};
