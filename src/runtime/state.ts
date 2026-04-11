import { RuntimeState } from "./types";

export function createRuntimeState(): RuntimeState {
  return {
    hourlyReplies: new Map<string, number>(),
    botMutedGroups: new Map<string, boolean>(),
    pendingImageTasks: new Map(),
    activeRequests: new Map(),
    lastRespondedAt: new Map<string, number>(),
    extractionLocks: new Map<string, boolean>(),
  };
}
