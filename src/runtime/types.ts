import { Context } from "koishi";
import { Config } from "../config";
import { PromptBuilder } from "../context/prompt-builder";
import { Debouncer } from "../pipeline/debouncer";
import { MessageBuffer } from "../pipeline/message-buffer";
import { ImageProcessor } from "../pipeline/image-processor";
import { MessageNormalizer } from "../perception/normalizer";
import { ContextRenderer } from "../perception/renderer";
import { LLMClient } from "../llm/client";
import { MemoryService } from "../memory";
import { MemoryExtractionScheduler } from "../memory/extraction-scheduler";
import { SearchService } from "../search/router";
import { StickerService } from "../sticker";
import { ShadowLogger } from "../shadow-logger";
import { PersonaService } from "../persona/service";
import { GeminiCacheManager } from "../llm/gemini-cache";

export interface ImageTask {
  messageId: string;
  promise: Promise<string | null>;
  startTime: number;
}

export interface RuntimeState {
  hourlyReplies: Map<string, number>;
  botMutedGroups: Map<string, boolean>;
  pendingImageTasks: Map<string, ImageTask[]>;
  activeRequests: Map<string, AbortController>;
  lastRespondedAt: Map<string, number>;
  extractionLocks: Map<string, boolean>;
}

export interface RuntimeDeps {
  ctx: Context;
  config: Config;
  logger: any;
  buffer: MessageBuffer;
  debouncer: Debouncer;
  llm: LLMClient;
  promptBuilder: PromptBuilder;
  imageProcessor: ImageProcessor | null;
  normalizer: MessageNormalizer;
  renderer: ContextRenderer;
  memory: MemoryService | null;
  extractionScheduler: MemoryExtractionScheduler | null;
  searchService: SearchService | null;
  stickerService: StickerService | null;
  shadowLogger: ShadowLogger | null;
  personaService: PersonaService;
  geminiCacheManager: GeminiCacheManager | null;
}
