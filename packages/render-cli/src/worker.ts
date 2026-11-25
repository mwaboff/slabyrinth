/** A render thread of `--jobs` (batch.ts): wires `runWorker` to the thread's parent. */
import { parentPort, workerData } from "node:worker_threads";
import type { WorkerData, WorkerMessage } from "./batch";
import { runWorker } from "./workerMain";

void runWorker(workerData as WorkerData, (m: WorkerMessage) => parentPort?.postMessage(m));
