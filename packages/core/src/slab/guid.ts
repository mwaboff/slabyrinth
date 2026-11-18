/**
 * GUID ⇄ bytes in .NET `Guid.ToByteArray()` order (slab layouts and the binary asset index both use it):
 * the first group is 4 bytes little-endian, the next two groups 2 bytes little-endian, the last 8 bytes as written.
 * `e62c6746-cecf-46bf-8b20-f81738f1d220` → `46 67 2C E6 CF CE BF 46 8B 20 F8 17 38 F1 D2 20`.
 */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isGuid(s: string): boolean {
  return GUID_RE.test(s.toLowerCase());
}

/** Lower-case canonical form; throws on anything that is not a 36-character GUID. */
export function normalizeGuid(s: string): string {
  const l = s.trim().toLowerCase();
  if (!GUID_RE.test(l)) throw new Error(`not a GUID: "${s}"`);
  return l;
}

/** Order of hex byte pairs (from the canonical string without dashes) as written by Guid.ToByteArray(). */
const BYTE_ORDER = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15] as const;

export function guidToBytes(guid: string, out: Uint8Array = new Uint8Array(16), offset = 0): Uint8Array {
  const hex = normalizeGuid(guid).replace(/-/g, "");
  for (let i = 0; i < 16; i++) {
    const src = BYTE_ORDER[i] ?? 0;
    out[offset + i] = parseInt(hex.slice(src * 2, src * 2 + 2), 16);
  }
  return out;
}

export function bytesToGuid(bytes: Uint8Array, offset = 0): string {
  if (offset < 0 || offset + 16 > bytes.length) throw new RangeError("GUID read out of bounds");
  const hexBytes = new Array<string>(16);
  for (let i = 0; i < 16; i++) {
    const b = bytes[offset + i] ?? 0;
    hexBytes[BYTE_ORDER[i] ?? 0] = (b < 16 ? "0" : "") + b.toString(16);
  }
  const h = hexBytes.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
