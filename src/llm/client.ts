import OpenAI from "openai";
import { ProviderManager, ModelConfig } from "./provider";
import { GenerateContentConfig } from "@google/genai";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | any[]; // 支持多模态内容
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal; // 支持取消请求
  responseFormat?: "text" | "json_object"; // JSON mode 支持
}

export class LLMClient {
  private providerManager: ProviderManager;

  constructor(providerManager: ProviderManager) {
    this.providerManager = providerManager;
  }

  async chat(
    messages: ChatMessage[],
    modelConfig: ModelConfig,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const providerConfig = this.providerManager.getProviderConfig(
      modelConfig.providerId,
    );
    if (!providerConfig) {
      throw new Error(`Provider not found: ${modelConfig.providerId}`);
    }

    const temperature = options?.temperature ?? modelConfig.temperature ?? 0.9;
    const maxTokens = options?.maxTokens ?? modelConfig.maxTokens ?? 150;
    const signal = options?.signal;
    const responseFormat = options?.responseFormat ?? "text";

    if (providerConfig.type === "gemini") {
      return this.chatGemini(
        messages,
        modelConfig,
        temperature,
        maxTokens,
        signal,
        responseFormat,
      );
    } else {
      return this.chatOpenAI(
        messages,
        modelConfig,
        temperature,
        maxTokens,
        signal,
        responseFormat,
      );
    }
  }

  private async chatOpenAI(
    messages: ChatMessage[],
    modelConfig: ModelConfig,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
    responseFormat: "text" | "json_object" = "text",
  ): Promise<LLMResponse> {
    const provider = this.providerManager.getOpenAIProvider(
      modelConfig.providerId,
    );
    if (!provider) {
      throw new Error(`OpenAI provider not found: ${modelConfig.providerId}`);
    }

    // 转换消息格式以支持多模态
    const formattedMessages = messages.map((msg) => {
      // 如果 content 是字符串且看起来像 JSON 数组，尝试解析
      if (typeof msg.content === "string" && msg.content.startsWith("[")) {
        try {
          const parsed = JSON.parse(msg.content);
          if (Array.isArray(parsed)) {
            return { role: msg.role, content: parsed };
          }
        } catch {
          // 解析失败，保持原样
        }
      }
      return { role: msg.role, content: msg.content };
    });

    const requestParams: any = {
      model: modelConfig.modelName,
      messages: formattedMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature,
      max_tokens: maxTokens,
    };

    // 添加 JSON mode 支持
    if (responseFormat === "json_object") {
      requestParams.response_format = { type: "json_object" };
    }

    const response = await provider.chat.completions.create(
      requestParams,
      signal ? { signal } : undefined,
    );

    return {
      content: response.choices[0].message.content || "",
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
      },
    };
  }

  private async chatGemini(
    messages: ChatMessage[],
    modelConfig: ModelConfig,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
    responseFormat: "text" | "json_object" = "text",
  ): Promise<LLMResponse> {
    const provider = this.providerManager.getGeminiProvider(
      modelConfig.providerId,
    );
    if (!provider) {
      throw new Error(`Gemini provider not found: ${modelConfig.providerId}`);
    }

    // 转换消息格式为 Gemini 格式
    const geminiContents = this.convertToGeminiFormat(messages);

    // 构建配置
    const config: GenerateContentConfig = {
      temperature,
      maxOutputTokens: maxTokens,
    };

    // 根据配置决定 thinking 预算
    if (modelConfig.thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget: modelConfig.thinkingBudget };
    } else if (modelConfig.enableThinking === false) {
      config.thinkingConfig = { thinkingBudget: 0 };
    }

    // 添加 JSON mode 支持（Gemini 使用 responseMimeType）
    if (responseFormat === "json_object") {
      config.responseMimeType = "application/json";
    }

    // 添加 AbortSignal 支持
    if (signal) {
      config.abortSignal = signal;
    }

    const response = await provider.models.generateContent({
      model: modelConfig.modelName,
      contents: geminiContents,
      config,
    });

    // 尝试从 candidates 中获取完整文本
    let fullText = "";
    let finishReason = "";

    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];
      finishReason = candidate.finishReason || "";

      if (candidate.content?.parts) {
        fullText = candidate.content.parts
          .map((part: any) => part.text || "")
          .join("");
      }
    }

    // 如果从 candidates 提取失败，尝试 response.text
    if (!fullText) {
      fullText = response.text || "";
    }

    // 如果因为 token 限制被截断，发出警告
    if (finishReason === "MAX_TOKENS") {
      console.warn(`[Gemini] 响应因达到 maxTokens (${maxTokens}) 被截断`);
    }

    return {
      content: fullText,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  private convertToGeminiFormat(messages: ChatMessage[]): any[] {
    const contents: any[] = [];

    for (const msg of messages) {
      // Gemini 使用 'user' 和 'model' 角色
      const role =
        msg.role === "assistant"
          ? "model"
          : msg.role === "system"
            ? "user"
            : msg.role;

      // 处理多模态内容
      if (typeof msg.content === "string") {
        // 检查是否是 JSON 格式的多模态内容
        if (msg.content.startsWith("[")) {
          try {
            const parsed = JSON.parse(msg.content);
            if (Array.isArray(parsed)) {
              // 转换为 Gemini 格式
              const parts = parsed.map((item: any) => {
                if (item.type === "text") {
                  return { text: item.text };
                } else if (item.type === "image_url") {
                  // Gemini 需要 base64 或 URL
                  const imageUrl = item.image_url?.url || item.image_url;
                  if (imageUrl.startsWith("data:")) {
                    // Base64 格式
                    const [mimeType, base64Data] = imageUrl.split(",");
                    const mime =
                      mimeType.match(/data:([^;]+)/)?.[1] || "image/png";
                    return {
                      inlineData: {
                        mimeType: mime,
                        data: base64Data,
                      },
                    };
                  } else {
                    // URL 格式 - Gemini 需要先下载转 base64
                    // 这里简化处理，直接传 URL（某些 Gemini 版本支持）
                    return {
                      fileData: {
                        fileUri: imageUrl,
                      },
                    };
                  }
                }
                return item;
              });
              contents.push({ role, parts });
              continue;
            }
          } catch {
            // 解析失败，当作普通文本
          }
        }

        // 普通文本消息
        contents.push({
          role,
          parts: [{ text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        // 已经是数组格式
        const parts = msg.content.map((item: any) => {
          if (item.type === "text") {
            return { text: item.text };
          } else if (item.type === "image_url") {
            const imageUrl = item.image_url?.url || item.image_url;
            if (imageUrl.startsWith("data:")) {
              const [mimeType, base64Data] = imageUrl.split(",");
              const mime = mimeType.match(/data:([^;]+)/)?.[1] || "image/png";
              return {
                inlineData: {
                  mimeType: mime,
                  data: base64Data,
                },
              };
            } else {
              return {
                fileData: {
                  fileUri: imageUrl,
                },
              };
            }
          }
          return item;
        });
        contents.push({ role, parts });
      }
    }

    return contents;
  }
}
