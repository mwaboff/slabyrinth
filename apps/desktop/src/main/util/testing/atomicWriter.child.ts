/**
 * Child process for the kill -9 crash test (atomicWrite.test.ts). Writes self-checking JSON
 * documents to the target in a tight loop until killed. Usage: node --import tsx <this> <file>
 */
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../atomicWrite";

const file = process.argv[2];
if (file === undefined) process.exit(2);

export function makeDoc(n: number): string {
  // ~300 KB so that writes take long enough to be interrupted mid-way.
  const body = {
    n,
    filler: "x".repeat(300_000 + (n % 7) * 1000),
    items: Array.from({ length: 200 }, (_, i) => ({ i, n })),
  };
  const json = JSON.stringify(body);
  return JSON.stringify({ sha: createHash("sha256").update(json).digest("hex"), body: json });
}

async function main(target: string): Promise<void> {
  process.stdout.write("READY\n");
  for (let n = 1; ; n++) {
    await writeFileAtomic(target, makeDoc(n), { backup: true });
  }
}

void main(file);
