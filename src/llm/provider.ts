import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

export type ProviderType = 'openai' | 'gemini';

export type OpenAIDialect = 'openai' | 'deepseek' | 'qwen' | 'openrouter' | 'siliconflow' | 'custom';

export type ReasoningMode = 'auto' | 'off' | 'effort' | 'budget';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

export interface ReasoningConfig {
  mode?: ReasoningMode;
  effort?: ReasoningEffort;
  budgetTokens?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;                          // 仅 OpenAI-compatible 需要
  dialect?: OpenAIDialect;                   // 仅 type=openai 时生效，控制 reasoning/extra 字段翻译
  extraHeaders?: Record<string, string>;     // 仅 type=openai，附加请求头
  extraBody?: Record<string, any>;           // 仅 type=openai，每次请求合入的请求体字段
}

export interface ModelConfig {
  providerId: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;               // 规范化推理控制，由 LLMClient 按 (type, dialect) 翻译
  extraBody?: Record<string, any>;           // 仅本次请求合入的请求体字段
}

export class ProviderManager {
  private openaiProviders: Map<string, OpenAI> = new Map();
  private geminiProviders: Map<string, GoogleGenAI> = new Map();
  private configs: Map<string, ProviderConfig> = new Map();

  constructor(providerConfigs: ProviderConfig[]) {
    for (const config of providerConfigs) {
      this.addProvider(config);
    }
  }

  addProvider(config: ProviderConfig): void {
    this.configs.set(config.id, config);

    if (config.type === 'gemini') {
      this.geminiProviders.set(
        config.id,
        new GoogleGenAI({ apiKey: config.apiKey })
      );
    } else {
      // OpenAI-compatible
      this.openaiProviders.set(
        config.id,
        new OpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          defaultHeaders: config.extraHeaders,
        })
      );
    }
  }

  getOpenAIProvider(providerId: string): OpenAI | undefined {
    return this.openaiProviders.get(providerId);
  }

  getGeminiProvider(providerId: string): GoogleGenAI | undefined {
    return this.geminiProviders.get(providerId);
  }

  getProviderConfig(providerId: string): ProviderConfig | undefined {
    return this.configs.get(providerId);
  }

  hasProvider(providerId: string): boolean {
    return this.configs.has(providerId);
  }

  listProviders(): ProviderConfig[] {
    return Array.from(this.configs.values());
  }
}
