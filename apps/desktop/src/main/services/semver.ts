/**
 * Minimal semantic-version parsing and ordering (semver 2.0.0 §11) for the update check. A tag is accepted as
 * "vX.Y.Z" or "X.Y.Z" with an optional "-prerelease" and "+build"; anything else is not a version.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers ([] for a release). */
  prerelease: string[];
}

const NUM = "(0|[1-9]\\d{0,8})";
const IDENT = "[0-9A-Za-z-]+";
const PATTERN = new RegExp(
  `^v?${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`,
);

export function parseVersion(raw: string): SemVer | null {
  if (raw.length > 64) return null;
  const m = PATTERN.exec(raw);
  if (!m) return null;
  const prerelease = m[4] === undefined ? [] : m[4].split(".");
  // Numeric prerelease identifiers must not have leading zeros (semver §9).
  if (prerelease.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

function compareIdent(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1; // numeric identifiers have lower precedence than alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1, 0 or 1. Build metadata is ignored; a prerelease sorts before its release. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIdent(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

/** True when `candidate` is a valid version strictly newer than `current` (an invalid current counts as 0.0.0). */
export function isNewer(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  if (!c) return false;
  const cur = parseVersion(current) ?? { major: 0, minor: 0, patch: 0, prerelease: [] };
  return compareVersions(c, cur) > 0;
}

export function formatVersion(v: SemVer): string {
  const core = `${String(v.major)}.${String(v.minor)}.${String(v.patch)}`;
  return v.prerelease.length > 0 ? `${core}-${v.prerelease.join(".")}` : core;
}
