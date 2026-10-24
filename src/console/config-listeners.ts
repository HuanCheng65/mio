import { Context } from "koishi";
import { ConfigService, type ProviderTestResult } from "./config-service";
import type { Config as MioConfig } from "../config";
import type { ProviderConfig } from "../llm/provider";

declare module "@koishijs/plugin-console" {
  interface Events {
    "mio/config/get"(): Promise<MioConfig>;
    "mio/config/update"(next: MioConfig): Promise<{ ok: true }>;
    "mio/config/test-provider"(provider: ProviderConfig): Promise<ProviderTestResult>;
    "mio/config/list-models"(providerId: string): Promise<string[]>;
  }
}

export function registerConfigListeners(ctx: Context, service: ConfigService): void {
  ctx.inject(["console"], (ctx) => {
    ctx.console.addListener("mio/config/get", async () => service.get(), { authority: 4 });

    ctx.console.addListener(
      "mio/config/update",
      async (next) => {
        await service.update(next);
        return { ok: true as const };
      },
      { authority: 4 },
    );

    ctx.console.addListener(
      "mio/config/test-provider",
      (provider) => service.testProvider(provider),
      { authority: 4 },
    );

    ctx.console.addListener(
      "mio/config/list-models",
      (providerId) => service.listModels(providerId),
      { authority: 4 },
    );
  });
}
