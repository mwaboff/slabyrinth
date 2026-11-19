import { describe, expect, it } from "vitest";
import { compareVersions, formatVersion, isNewer, parseVersion, type SemVer } from "./semver";

const v = (s: string): SemVer => {
  const p = parseVersion(s);
  if (!p) throw new Error(`not a version: ${s}`);
  return p;
};

describe("semver", () => {
  it("parses vX.Y.Z and X.Y.Z with prerelease and build metadata", () => {
    expect(parseVersion("v0.2.0")).toEqual({ major: 0, minor: 2, patch: 0, prerelease: [] });
    expect(parseVersion("1.10.3-beta.2+build.7")).toEqual({
      major: 1,
      minor: 10,
      patch: 3,
      prerelease: ["beta", "2"],
    });
    expect(formatVersion(v("v1.2.3-rc.1+sha"))).toBe("1.2.3-rc.1");
  });

  it("rejects garbage tags", () => {
    for (const bad of [
      "",
      "latest",
      "v1",
      "1.2",
      "1.2.3.4",
      "01.2.3",
      "1.2.3-",
      "1.2.3-01",
      "v1.2.3 ",
      "vv1.2.3",
      "1.2.3-beta..1",
      "1.2.3<script>",
      "9999999999.0.0",
      `1.2.3-${"a".repeat(80)}`,
    ]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it("orders versions per semver §11 (prerelease before release, numeric < alphanumeric)", () => {
    const order = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.1.0",
      "2.0.0",
      "10.0.0",
    ];
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i] as string;
      const b = order[i + 1] as string;
      expect(compareVersions(v(a), v(b)), `${a} < ${b}`).toBe(-1);
      expect(compareVersions(v(b), v(a)), `${b} > ${a}`).toBe(1);
    }
    expect(compareVersions(v("1.0.0+a"), v("1.0.0+b"))).toBe(0);
  });

  it("isNewer: newer / same / older / prerelease / garbage", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "0.2.0-beta.1")).toBe(true); // the release after my prerelease
    expect(isNewer("0.2.0-beta.1", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewer("nightly", "0.1.0")).toBe(false);
  });
});
