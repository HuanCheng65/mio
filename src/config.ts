import { Schema } from "koishi";
import { ProviderConfig, ModelConfig } from "./llm/provider";

export interface Config {
  botName: string;
  botAliases: string[];
  personaFile: string;
  enableGroups: string[];
  shadowGroups: string[];
  providers: ProviderConfig[];
  models: {
    chat: ModelConfig;
    vision: ModelConfig;
  };
  bufferSize: number;
  debounce: {
    idleMs: number;
    minWaitMs: number;
    maxWaitMs: number;
  };
  vision: {
    enabled: boolean;
  };
  safety: {
    maxReplyPerHour: number;
    minCooldownMs: number;
    maxConsecutiveReplies: number;
  };
  memory: {
    enabled: boolean;
    embedding: ModelConfig;
    extraction: ModelConfig;
    distillation: ModelConfig;
    distillationHour: number;
    flushIntervalMs: number;
    maxPendingWrites: number;
    activePoolLimit: number;
  };
  search: {
    enabled: boolean;
    searxngBaseUrl: string;
    bangumiUserAgent: string;
    saucenaoApiKey: string;
    searchTimeoutMs: number;
    compression: ModelConfig;
  };
  sticker: {
    enabled: boolean;
    imageDir: string;
    poolSize: number;
  };
}

export const Config: Schema<Config> = Schema.object({
  botName: Schema.string().default("澪").description("Bot 名称"),
  botAliases: Schema.array(Schema.string())
    .default(["みお", "小澪"])
    .description("Bot 别名"),
  personaFile: Schema.string().default("mio.md").description("人设文件名"),
  enableGroups: Schema.array(Schema.string().pattern(/^\d+$/))
    .default([])
    .description("启用的群号"),
  shadowGroups: Schema.array(Schema.string().pattern(/^\d+$/))
    .default([])
    .description("影子模式群号（正常推理但不发送消息，记录到日志）"),
  bufferSize: Schema.number().default(50).description("消息缓冲区大小"),

  providers: Schema.array(
    Schema.object({
      id: Schema.string().required().description("供应商 ID（自定义，如 deepseek-main）"),
      name: Schema.string().required().description("供应商名称（显示用）"),
      type: Schema.union(["openai", "gemini"] as const)
        .default("openai")
        .description("供应商类型（openai: OpenAI-compatible API, gemini: Google Gemini API）"),
      apiKey: Schema.string().required().description("API Key"),
      baseUrl: Schema.string().description("API Base URL（仅 OpenAI-compatible 需要）"),
    }),
  )
    .default([
      {
        id: "deepseek",
        name: "DeepSeek",
        type: "openai",
        apiKey: "",
        baseUrl: "https://api.deepseek.com",
      },
    ])
    .description("LLM 供应商配置"),

  models: Schema.object({
    chat: Schema.object({
      providerId: Schema.string().default("deepseek").description("使用的供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("模型名称"),
      temperature: Schema.number().default(0.9).description("温度参数"),
      maxTokens: Schema.number().default(200).description("最大 Token 数"),
      thinkingBudget: Schema.number().description("Gemini thinking 预算 token 数（0=禁用，不填=模型默认）"),
    }).description("对话生成模型"),
    vision: Schema.object({
      providerId: Schema.string().default("deepseek").description("使用的供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("多模态模型名称（如 gpt-4o-mini）"),
      temperature: Schema.number().default(0.5).description("温度参数"),
      maxTokens: Schema.number().default(500).description("最大 Token 数（Gemini thinking 模型需要更大值）"),
      thinkingBudget: Schema.number().description("Gemini thinking 预算 token 数（0=禁用，不填=模型默认）"),
    }).description("图片理解模型"),
  }).description("模型配置"),

  debounce: Schema.object({
    idleMs: Schema.number().default(5000).description("消息间隔窗口期（毫秒）"),
    minWaitMs: Schema.number().default(8000).description("基准最短等待时间（毫秒）"),
    maxWaitMs: Schema.number().default(45000).description("基准最长等待时间（毫秒）"),
  }).description("Debounce 配置"),

  vision: Schema.object({
    enabled: Schema.boolean().default(true).description("启用图片理解功能"),
  }).description("多模态配置"),

  safety: Schema.object({
    maxReplyPerHour: Schema.number().default(25).description("每小时最多回复次数"),
    minCooldownMs: Schema.number().default(15000).description("最小回复冷却时间（毫秒）"),
    maxConsecutiveReplies: Schema.number().default(4).description("最多连续回复次数（之后静默）"),
  }).description("安全兜底配置"),

  memory: Schema.object({
    enabled: Schema.boolean().default(false).description("启用记忆系统"),
    embedding: Schema.object({
      providerId: Schema.string().default("openai").description("Embedding 供应商 ID"),
      modelName: Schema.string().default("text-embedding-3-small").description("Embedding 模型名称"),
    }).description("Embedding 模型配置"),
    extraction: Schema.object({
      providerId: Schema.string().default("deepseek").description("记忆提取供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("记忆提取模型名称"),
      temperature: Schema.number().default(0.3).description("温度参数"),
      maxTokens: Schema.number().default(800).description("最大 Token 数"),
    }).description("记忆提取模型配置（建议用便宜模型）"),
    distillation: Schema.object({
      providerId: Schema.string().default("deepseek").description("蒸馏供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("蒸馏模型名称"),
      temperature: Schema.number().default(0.3).description("温度参数"),
      maxTokens: Schema.number().default(1000).description("最大 Token 数"),
    }).description("蒸馏模型配置（可复用提取模型）"),
    distillationHour: Schema.number().default(3).description("每日蒸馏时间（0-23，默认凌晨 3 点）"),
    flushIntervalMs: Schema.number().default(300000).description("Working Memory flush 间隔（毫秒）"),
    maxPendingWrites: Schema.number().default(20).description("最大缓冲写入数"),
    activePoolLimit: Schema.number().default(200).description("活跃记忆池上限"),
  }).description("记忆系统配置"),

  search: Schema.object({
    enabled: Schema.boolean().default(true).description("启用搜索增强功能"),
    searxngBaseUrl: Schema.string().default("http://localhost:18080").description("SearXNG 实例地址"),
    bangumiUserAgent: Schema.string().default("starrydream/mio-bot/1.0").description("Bangumi API User-Agent"),
    saucenaoApiKey: Schema.string().default("").description("SauceNAO API Key (以图搜图，留空不启用)"),
    searchTimeoutMs: Schema.number().default(5000).description("搜索超时时间（毫秒）"),
    compression: Schema.object({
      providerId: Schema.string().default("deepseek").description("搜索结果压缩供应商 ID"),
      modelName: Schema.string().default("deepseek-chat").description("搜索结果压缩模型名称"),
      temperature: Schema.number().default(0).description("温度参数（压缩任务建议 0）"),
      maxTokens: Schema.number().default(150).description("最大 Token 数"),
    }).description("搜索结果压缩模型配置（建议用便宜快速的模型）"),
  }).description("搜索增强配置"),

  sticker: Schema.object({
    enabled: Schema.boolean().default(true).description("启用表情包收集功能"),
    imageDir: Schema.string().default("./data/stickers").description("表情包存储目录"),
    poolSize: Schema.number().default(80).description("活跃池软上限"),
  }).description("表情包系统配置"),
});
