import { NextResponse, type NextRequest } from "next/server";

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "X-DNS-Prefetch-Control": "off",
};

const CSP_DEFAULT = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const CSP_DEV = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // dev needs eval + websocket for HMR
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
].join("; ");

export default function proxy(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  // Exact segment match — a bare startsWith("/app") would also capture
  // /apple-touch-icon.png and any future /app* sibling route.
  const isApp =
    req.nextUrl.pathname === "/app" || req.nextUrl.pathname.startsWith("/app/");
  const isProd = process.env.NODE_ENV === "production";

  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  res.headers.set("Content-Security-Policy", isProd ? CSP_DEFAULT : CSP_DEV);
  res.headers.delete("X-Powered-By");

  if (isApp && !req.cookies.get("a2a_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(
      `${req.nextUrl.pathname}${req.nextUrl.search}`,
    )}`;
    const redirect = NextResponse.redirect(url);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      redirect.headers.set(k, v);
    }
    redirect.headers.set(
      "Content-Security-Policy",
      isProd ? CSP_DEFAULT : CSP_DEV,
    );
    redirect.headers.delete("X-Powered-By");
    return redirect;
  }

  if (isApi) {
    const origin = req.headers.get("origin");
    const sameOrigin = origin === req.nextUrl.origin;
    if (origin && !sameOrigin) {
      // Cross-origin: deny unless authenticated via Bearer (agent API).
      const auth = req.headers.get("authorization") ?? "";
      if (!/^Bearer\s+a2a_/.test(auth)) {
        return new NextResponse("Forbidden", { status: 403 });
      }
      // Cross-origin + Bearer auth: the request is from a script/agent, not
      // a browser session. We never reach this line if the Bearer regex
      // above failed (returned 403). Cookies are stripped here by
      // SameSite=Lax on the way in, so reflecting Origin only helps curl /
      // SDKs and cannot enable CSRF (no credentials would attach).
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Vary", "Origin");
    }
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
