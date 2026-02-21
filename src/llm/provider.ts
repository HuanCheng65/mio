import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

export type ProviderType = 'openai' | 'gemini';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string; // 仅 OpenAI-compatible 需要
}

export interface ModelConfig {
  providerId: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;   // 是否启用 Gemini thinking mode
  thinkingBudget?: number;    // Gemini thinking token 预算（设置后覆盖 enableThinking）
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
