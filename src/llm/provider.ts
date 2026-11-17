import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

export type ProviderType = 'openai' | 'gemini' | 'anthropic';

export type OpenAIDialect = 'openai' | 'deepseek' | 'qwen' | 'openrouter' | 'siliconflow' | 'custom';

export type ReasoningMode = 'auto' | 'off' | 'effort' | 'budget';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

export interface ReasoningConfig {
  mode?: ReasoningMode;
  effort?: ReasoningEffort;
  budgetTokens?: number;
}

export type ImageTransportKind = 'inline' | 'deepseek-files';

/** agent 怎么把图交给模型（见 agent/image-transport.ts） */
export interface ProviderImageConfig {
  transport?: ImageTransportKind;
  /** 发送前缩到的总像素量，填供应商服务端自己的缩放目标 */
  maxPixels?: number;
  /** 仅 inline：一段 log 的图片最多占多少请求体（MiB），超过就睡前整理 */
  inlineBudgetMiB?: number;
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
  images?: ProviderImageConfig;              // type=openai / anthropic，agent 发图方式
  proxyUrl?: string;                         // 仅 type=anthropic，经 HTTP 代理访问（服务器直连会被按地区拒绝）
}

export interface ModelConfig {
  providerId: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;               // 规范化推理控制，由 LLMClient 按 (type, dialect) 翻译
  extraBody?: Record<string, any>;           // 仅本次请求合入的请求体字段
}

/**
 * Anthropic 客户端；配了 proxyUrl 就经代理访问。代理用 undici 自己的 fetch 配它自己的 ProxyAgent：
 * Node 内置 fetch 捆绑的 undici 版本不同，混用 dispatcher 不可靠。
 */
export function createAnthropicClient(config: ProviderConfig): Anthropic {
  if (!config.proxyUrl) return new Anthropic({ apiKey: config.apiKey });
  return new Anthropic({
    apiKey: config.apiKey,
    fetch: undiciFetch as unknown as typeof fetch,
    fetchOptions: { dispatcher: new ProxyAgent(config.proxyUrl) } as unknown as ClientOptions['fetchOptions'],
  });
}

export class ProviderManager {
  private openaiProviders: Map<string, OpenAI> = new Map();
  private geminiProviders: Map<string, GoogleGenAI> = new Map();
  private anthropicProviders: Map<string, Anthropic> = new Map();
  private configs: Map<string, ProviderConfig> = new Map();

  constructor(providerConfigs: ProviderConfig[]) {
    for (const config of providerConfigs) {
      this.addProvider(config);
    }
  }

  addProvider(config: ProviderConfig): void {
    if (config.proxyUrl && config.type !== 'anthropic') {
      throw new Error(`供应商 ${config.id}: proxyUrl 目前只支持 anthropic 类型`);
    }
    this.configs.set(config.id, config);

    if (config.type === 'gemini') {
      this.geminiProviders.set(
        config.id,
        new GoogleGenAI({ apiKey: config.apiKey })
      );
    } else if (config.type === 'anthropic') {
      // 原生 Anthropic Messages API（目前只有 agent 用）
      this.anthropicProviders.set(config.id, createAnthropicClient(config));
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

  getAnthropicProvider(providerId: string): Anthropic | undefined {
    return this.anthropicProviders.get(providerId);
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
