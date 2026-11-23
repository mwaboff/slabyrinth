/**
 * Research: tests whether a part's 16-byte content id (binary index, part element +44) is a plain hash of its
 * bundle and asset names. Usage: guessContentId <32-hex id> <bundleId> <assetName>. (On the ship side piece: no.)
 */
import { createHash } from "node:crypto";

const [target, bundle, asset] = process.argv.slice(2);
if (!target || !bundle || !asset) throw new Error("usage: guessContentId <hex> <bundleId> <assetName>");
const texts = [
  asset,
  `${bundle}/${asset}`,
  `${bundle}:${asset}`,
  `${bundle}${asset}`,
  asset.toLowerCase(),
  `${bundle}.${asset}`,
];
for (const t of texts)
  for (const enc of ["utf8", "utf16le"] as const)
    for (const alg of ["md5", "sha1", "sha256"]) {
      const h = createHash(alg).update(Buffer.from(t, enc)).digest("hex");
      if (h.slice(0, 32) === target) console.log("MATCH", alg, enc, t);
    }
console.log("done");
