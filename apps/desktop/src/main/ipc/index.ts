/** IPC: Zod schemas (schemas.ts), router with sender check and Result<T> (router.ts), handlers (handlers.ts). */
export { createHandlers, type HandlerServices } from "./handlers";
export { createDispatcher, makeSenderCheck, mapError, registerIpc, type Handlers } from "./router";
export { requestSchemas, sendSchemas } from "./schemas";
