/**
 * ClipboardService: the only place main writes the system clipboard (slabs, room key).
 * In smoke/e2e runs a memory clipboard is injected so tests never touch the user's clipboard.
 */
export interface ClipboardLike {
  writeText(text: string): void;
}

export const MAX_CLIPBOARD_CHARS = 8 * 1024 * 1024;

export class ClipboardService {
  constructor(private readonly target: ClipboardLike) {}

  writeText(text: string): void {
    if (text.length > MAX_CLIPBOARD_CHARS) throw new Error("text too large for the clipboard");
    this.target.writeText(text);
  }
}

export function memoryClipboard(): ClipboardLike & { last: string | null; writes: number } {
  const c = {
    last: null as string | null,
    writes: 0,
    writeText(text: string): void {
      c.last = text;
      c.writes += 1;
    },
  };
  return c;
}
