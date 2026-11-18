/**
 * Standard RFC 4648 base64 (alphabet `+/`, `=` padding, single line). Core has no DOM or Node
 * types, so neither `btoa`/`atob` nor `Buffer` is available here.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      ALPHABET.charAt((v >> 18) & 63) +
      ALPHABET.charAt((v >> 12) & 63) +
      ALPHABET.charAt((v >> 6) & 63) +
      ALPHABET.charAt(v & 63);
  }
  const rest = n - i;
  if (rest === 1) {
    const v = (bytes[i] ?? 0) << 16;
    out += ALPHABET.charAt((v >> 18) & 63) + ALPHABET.charAt((v >> 12) & 63) + "==";
  } else if (rest === 2) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      ALPHABET.charAt((v >> 18) & 63) +
      ALPHABET.charAt((v >> 12) & 63) +
      ALPHABET.charAt((v >> 6) & 63) +
      "=";
  }
  return out;
}

/**
 * Decodes standard base64. ASCII whitespace is ignored (like `atob`); padding is optional.
 * Throws on characters outside the standard alphabet (URL-safe `-_` is rejected, as the game's `atob` would).
 */
export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[\t\n\f\r ]+/g, "");
  let end = clean.length;
  while (end > 0 && clean.charCodeAt(end - 1) === 61 /* = */) end--;
  if (clean.length - end > 2) throw new Error("base64: too much padding");
  if (end % 4 === 1) throw new Error("base64: invalid length");
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? (LOOKUP[c] ?? -1) : -1;
    if (v < 0) throw new Error(`base64: invalid character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}
