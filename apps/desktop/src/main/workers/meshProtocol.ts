/** Messages between MeshService (main thread) and mesh.worker, which reads pieces' shapes from TaleSpire cold. */
export type MeshWorkerRequest = {
  type: "read";
  id: number;
  installPath: string;
  cacheDir: string;
  limitBytes: number;
  uuids: string[];
};

export type MeshWorkerResponse =
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "read"; id: number; read: number; failed: number; bytes: number }
  | { type: "error"; id: number; message: string };
