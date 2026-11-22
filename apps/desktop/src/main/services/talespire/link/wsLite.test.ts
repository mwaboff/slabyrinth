import { describe, expect, it } from "vitest";
import { OPCODE, acceptKey, closeFrame, encodeFrame, readFrame } from "./wsLite";

const MASK = Buffer.from([1, 2, 3, 4]);

describe("wsLite frames", () => {
  it("answers the handshake as RFC 6455's example does", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("reads masked client frames of every length form, and waits for the rest of a frame", () => {
    for (const n of [5, 300, 70_000]) {
      const f = encodeFrame(OPCODE.text, "y".repeat(n), MASK);
      expect(readFrame(f.subarray(0, f.length - 1), 1 << 20)).toBeNull();
      const r = readFrame(Buffer.concat([f, Buffer.from([0x81])]), 1 << 20);
      if (r?.kind !== "frame") throw new Error("no frame");
      expect(r).toMatchObject({ fin: true, opcode: OPCODE.text, masked: true, length: f.length });
      expect(r.payload.toString("utf8")).toBe("y".repeat(n));
    }
  });

  it("refuses a frame over the limit from its header alone", () => {
    const head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(2 ** 40), 2);
    expect(readFrame(head, 1024)).toEqual({ kind: "tooBig" });
    expect(readFrame(encodeFrame(OPCODE.text, "x".repeat(2000), MASK), 1024)).toEqual({ kind: "tooBig" });
  });

  it("writes unmasked server frames and close frames with a code", () => {
    const r = readFrame(encodeFrame(OPCODE.text, "hi"), 100);
    expect(r).toMatchObject({ kind: "frame", masked: false });
    expect(closeFrame(4001)).toEqual(Buffer.from([0x88, 2, 0x0f, 0xa1]));
  });
});
