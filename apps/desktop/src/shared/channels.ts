/**
 * Runtime channel allowlists derived from the IPC contract (shared/ipc.ts). The preload forwards
 * ONLY these channels; main registers a Zod-validated handler for every request channel.
 * The `satisfies` checks below make the build fail if a contract channel is missing or extra.
 */
import type { IpcEvents, IpcRequests, IpcSends } from "./ipc";

type Exhaustive<K extends string, T extends readonly string[]> =
  Exclude<K, T[number]> extends never ? (Exclude<T[number], K> extends never ? T : never) : never;

const requestChannels = [
  "app:getInfo",
  "settings:get",
  "settings:update",
  "secrets:setApiKey",
  "secrets:storeWeak",
  "secrets:clearApiKey",
  "secrets:status",
  "providers:list",
  "providers:check",
  "models:list",
  "project:new",
  "project:open",
  "project:saveCopyAs",
  "project:rename",
  "project:duplicate",
  "project:trash",
  "project:revealInFolder",
  "project:close",
  "project:snapshot",
  "project:setUiState",
  "project:list",
  "project:importPlan",
  "project:exportPlan",
  "plan:applyOps",
  "plan:undo",
  "plan:redo",
  "plan:restore",
  "plan:getVersion",
  "plan:diff",
  "plan:approve",
  "plan:editText",
  "brief:update",
  "chat:send",
  "chat:estimate",
  "chat:cancel",
  "chat:retry",
  "chat:selectAlternative",
  "chat:continue",
  "chat:previewSwitch",
  "chat:setSelection",
  "chat:setEffort",
  "chat:newConversation",
  "compile:estimate",
  "compile:run",
  "compile:cancel",
  "build:setPasted",
  "build:saveChunk",
  "export:savePng",
  "export:roomKeyMarkdown",
  "clipboard:writeText",
  "dialog:pickFolder",
  "talespire:locate",
  "talespire:setPath",
  "catalog:status",
  "catalog:refresh",
  "talespire:copyAndOpen",
  "talespire:isRunning",
  "talespire:openUrl",
  "palettes:list",
  "palettes:reload",
  "palettes:openFolder",
  "palettes:resolveData",
  "shell:openExternal",
  "updates:status",
  "updates:check",
  "updates:skip",
] as const;

const eventChannels = [
  "chat:event",
  "plan:changed",
  "project:changed",
  "catalog:changed",
  "catalog:warning",
  "palettes:changed",
  "compile:progress",
  "settings:changed",
  "render:requestImage",
  "menu:command",
  "updates:available",
] as const;

const sendChannels = ["render:imageResult"] as const;

export const REQUEST_CHANNELS: Exhaustive<keyof IpcRequests, typeof requestChannels> = requestChannels;
export const EVENT_CHANNELS: Exhaustive<keyof IpcEvents, typeof eventChannels> = eventChannels;
export const SEND_CHANNELS: Exhaustive<keyof IpcSends, typeof sendChannels> = sendChannels;

export type RequestChannel = keyof IpcRequests;
export type EventChannel = keyof IpcEvents;
export type SendChannel = keyof IpcSends;
