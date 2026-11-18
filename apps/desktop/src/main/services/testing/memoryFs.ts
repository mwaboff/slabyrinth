import type { ReadonlyFs } from "@slabyrinth/core";

/**
 * In-memory ReadonlyFs (core's discovery port) for locator tests: `files` maps paths to text,
 * `dirs` lists directories. Paths compare case-insensitively with either separator.
 */
export function memoryFs(files: Record<string, string>, dirs: string[]): ReadonlyFs {
  const norm = (p: string): string =>
    p
      .replace(/[\\/]+/g, "/")
      .replace(/\/$/, "")
      .toLowerCase();
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const dirSet = new Set(dirs.map(norm));
  // Parent folders of every file and directory exist too.
  for (const p of [...fileMap.keys(), ...dirSet]) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  return {
    stat: (p) => {
      const n = norm(p);
      const f = fileMap.get(n);
      if (f !== undefined) return Promise.resolve({ size: f.length, mtimeMs: 0, isDirectory: false });
      return Promise.resolve(dirSet.has(n) ? { size: 0, mtimeMs: 0, isDirectory: true } : null);
    },
    readFile: (p) => {
      const f = fileMap.get(norm(p));
      return f === undefined
        ? Promise.reject(new Error("ENOENT"))
        : Promise.resolve(new TextEncoder().encode(f));
    },
    readText: (p) => {
      const f = fileMap.get(norm(p));
      return f === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(f);
    },
    listDir: (p) => {
      const n = `${norm(p)}/`;
      const names = new Set<string>();
      for (const k of [...fileMap.keys(), ...dirSet])
        if (k.startsWith(n)) names.add(k.slice(n.length).split("/")[0] ?? "");
      names.delete("");
      return Promise.resolve([...names]);
    },
  };
}
