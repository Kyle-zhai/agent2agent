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
  const isProd = process.env.NODE_ENV === "production";

  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  res.headers.set("Content-Security-Policy", isProd ? CSP_DEFAULT : CSP_DEV);
  res.headers.delete("X-Powered-By");

  if (isApi) {
    const origin = req.headers.get("origin");
    const sameOrigin = origin === req.nextUrl.origin;
    if (origin && !sameOrigin) {
      // Cross-origin: deny unless authenticated via Bearer (agent API).
      const auth = req.headers.get("authorization") ?? "";
      if (!/^Bearer\s+a2a_/.test(auth)) {
        return new NextResponse("Forbidden", { status: 403 });
      }
      // Allow tools/curl with Bearer; never reflect Origin for cookie-bearing requests.
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Vary", "Origin");
    }
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
