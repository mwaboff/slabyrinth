/**
 * GitHub Release notes from CHANGELOG.md (docs/releasing.md). Used by .github/workflows/release.yml:
 *
 *   node apps/desktop/scripts/release-notes.ts v0.1.0 CHANGELOG.md release-notes.md >> "$GITHUB_OUTPUT"
 *
 * Writes the body of the "## [0.1.0] - …" section to the output file and prints `found=true`, or prints
 * `found=false` (the workflow then falls back to GitHub's generated notes). No dependencies: Node runs this
 * file directly (type stripping), so the release job needs no npm install.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The text of the CHANGELOG section for `version` ("v0.1.0" or "0.1.0"), or null when missing or empty. */
export function changelogSection(changelog: string, version: string): string | null {
  const v = version.replace(/^v/, "").trim();
  if (v === "") return null;
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+\\[?v?${esc}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\[[^\]]+\]:\s+\S+/.test(line)) continue; // link reference definitions at the end of the file
    out.push(line);
  }
  const text = out.join("\n").trim();
  return text === "" ? null : `${text}\n`;
}

function main(argv: string[]): void {
  const [tag, changelogFile, outFile] = argv;
  if (tag === undefined || changelogFile === undefined || outFile === undefined) {
    process.stderr.write("usage: release-notes.ts <tag> <CHANGELOG.md> <out.md>\n");
    process.exit(2);
  }
  let section: string | null = null;
  try {
    section = changelogSection(readFileSync(changelogFile, "utf8"), tag);
  } catch (err) {
    process.stderr.write(`could not read ${changelogFile}: ${String(err)}\n`);
  }
  if (section === null) {
    process.stderr.write(`no CHANGELOG section for ${tag}; using generated notes\n`);
    process.stdout.write("found=false\n");
    return;
  }
  writeFileSync(outFile, section);
  process.stdout.write("found=true\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
