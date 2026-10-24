import type { ToolCall } from "./log-store";

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolContext {
  groupId: string;
  /** 影子模式：对外工具只记录、不真正发送 */
  shadow: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 返回给模型看的结果文本。被护栏拦下这类预期情况应在结果里说明，而不是抛异常。 */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[], private onError: (call: ToolCall, error: unknown) => void) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`duplicate agent tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /**
   * API 要求每个 tool_call 都有对应的结果，否则下一次请求会被拒绝。
   * 所以这里是唯一一处把失败转成结果文本的地方；真正的异常同时交给 onError 大声报告。
   */
  async call(call: ToolCall, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(call.function.name);
    if (!tool) return `没有叫 ${call.function.name} 的工具。可用的有：${[...this.tools.keys()].join("、")}`;

    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `参数不是合法的 JSON：${call.function.arguments}`;
    }

    try {
      return await tool.run(args, ctx);
    } catch (error) {
      this.onError(call, error);
      return `${tool.name} 出错了，这次没有完成。`;
    }
  }
}
