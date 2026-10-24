import { Context } from "koishi";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { Config as ConfigSchema, type Config as MioConfig } from "../config";
import type { ProviderConfig, ModelConfig } from "../llm/provider";

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

type Logger = ReturnType<Context["logger"]>;

export class ConfigService {
  constructor(
    private readonly ctx: Context,
    private readonly current: MioConfig,
    private readonly logger: Logger,
  ) {}

  get(): MioConfig {
    return this.current;
  }

  async update(next: MioConfig): Promise<void> {
    let parsed: MioConfig;
    try {
      parsed = ConfigSchema(next);
    } catch (error) {
      throw new Error(`配置格式无效: ${(error as Error)?.message ?? error}`);
    }

    this.validateCrossRefs(parsed);

    this.logger.info("[config] 通过 Console 写入配置，触发插件热重载");
    this.ctx.scope.update(parsed);
  }

  async testProvider(provider: ProviderConfig): Promise<ProviderTestResult> {
    if (!provider?.apiKey) {
      return { ok: false, message: "缺少 API Key" };
    }

    const start = Date.now();
    try {
      if (provider.type === "gemini") {
        const ai = new GoogleGenAI({ apiKey: provider.apiKey });
        const pager: any = await ai.models.list();
        await pager[Symbol.asyncIterator]().next();
      } else {
        const client = new OpenAI({
          apiKey: provider.apiKey,
          baseURL: provider.baseUrl,
        });
        await client.models.list();
      }
      return { ok: true, message: "连接成功", latencyMs: Date.now() - start };
    } catch (error) {
      return { ok: false, message: (error as Error)?.message ?? String(error) };
    }
  }

  async listModels(providerId: string): Promise<string[]> {
    const provider = this.current.providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new Error(`Provider 不存在: ${providerId}`);
    }
    if (!provider.apiKey) {
      throw new Error("缺少 API Key");
    }

    if (provider.type === "gemini") {
      const ai = new GoogleGenAI({ apiKey: provider.apiKey });
      const pager: any = await ai.models.list();
      const names: string[] = [];
      for await (const model of pager) {
        const name = String(model?.name ?? "").replace(/^models\//, "");
        if (name) names.push(name);
        if (names.length >= 200) break;
      }
      return names.sort();
    }

    const client = new OpenAI({
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
    });
    const list = await client.models.list();
    return list.data.map((m) => m.id).sort();
  }

  private validateCrossRefs(cfg: MioConfig): void {
    const seen = new Set<string>();
    for (const p of cfg.providers ?? []) {
      if (!p.id) {
        throw new Error("Provider ID 不能为空");
      }
      if (seen.has(p.id)) {
        throw new Error(`Provider ID 重复: ${p.id}`);
      }
      seen.add(p.id);
    }

    const checks: Array<[string, ModelConfig | undefined]> = [
      ["models.chat", cfg.models?.chat],
    ];
    if (cfg.vision?.enabled) {
      checks.push(["models.vision", cfg.models?.vision]);
    }
    if (cfg.memory?.enabled) {
      checks.push(["memory.embedding", cfg.memory.embedding]);
      checks.push(["memory.extraction", cfg.memory.extraction]);
      checks.push(["memory.distillation", cfg.memory.distillation]);
    }
    if (cfg.search?.enabled) {
      checks.push(["search.compression", cfg.search.compression]);
    }

    for (const [path, slot] of checks) {
      if (!slot) {
        throw new Error(`${path} 未配置`);
      }
      if (!slot.providerId || !seen.has(slot.providerId)) {
        throw new Error(`${path} 引用了不存在的 provider: ${slot.providerId || "(空)"}`);
      }
      if (!slot.modelName) {
        throw new Error(`${path} 未填写模型名称`);
      }
    }
  }
}
