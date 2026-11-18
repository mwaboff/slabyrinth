/**
 * shell:openExternal allowlist (architecture §6.5): https only, to a few known hosts, never with
 * credentials or a non-default port. GitHub is limited to this project's repository.
 */
export const REPO_PATH = "/mwaboff/slabyrinth";

const HOSTS = new Set([
  "console.anthropic.com",
  "docs.claude.com",
  "platform.claude.com",
  "talespire.com",
  "www.talespire.com",
]);

export function isAllowedExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  if (HOSTS.has(host)) return true;
  if (host === "github.com") {
    const p = u.pathname.toLowerCase();
    return p === REPO_PATH || p.startsWith(`${REPO_PATH}/`);
  }
  return false;
}
