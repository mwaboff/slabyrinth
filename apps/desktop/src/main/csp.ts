/**
 * Content Security Policy (architecture §6.5). CSP_PROD is the normative policy.
 * CSP_DEV additionally allows the Vite dev server (http + ws) and inline scripts, which the
 * React Fast Refresh preamble needs. Used by main (response header) and by
 * electron.vite.config.ts (meta tag in index.html), so both always agree.
 */
export const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export const CSP_DEV = CSP_PROD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
);
