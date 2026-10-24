import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageSegment, NormalizedMessage } from "../perception/types";
import type { SearchService } from "../search/router";
import type { EventStore } from "./event-store";
import type { AgentTool } from "./tools";

type Search = Pick<SearchService, "searchText" | "searchImage">;

const KINDS = ["anime", "galgame", "music", "general"] as const;

export function createSearchTool(search: Search): AgentTool {
  return {
    name: "search",
    description:
      "去查一个作品、歌、人或者梗。聊到你没听过、或者细节记不清的东西时用；你已经清楚的就不用查。" +
      "结果只有你看得到，查完不一定要说出来。一次查一个具体的东西，比一次查一大堆有用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词，尽量是作品名、歌名、人名这类具体的词" },
        kind: { type: "string", enum: [...KINDS], description: "anime 番剧，galgame 视觉小说，music 歌曲，general 其他" },
        intent: { type: "string", description: "你想从结果里知道什么，比如\"这是什么类型的作品\"\"作者是谁\"" },
      },
      required: ["query", "kind", "intent"],
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "没写要查什么";
      const kind = KINDS.find((k) => k === args.kind);
      if (!kind) return `kind 只能是 ${KINDS.join(" / ")}`;
      const summary = await search.searchText(query, kind, String(args.intent ?? "大概是什么"));
      return summary ?? `没搜到关于「${query}」的有用信息`;
    },
  };
}

export function createFindSourceTool(deps: { events: EventStore; search: Search; mediaDir: string }): AgentTool {
  return {
    name: "find_source",
    description:
      "拿群里的一张图去反查出处：画师、原作、番剧截图出自哪一集。" +
      "有人问这图是谁画的、出自哪里时用；单纯觉得好看不用查。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "图所在的消息编号，如 m12" },
        image: { type: "number", description: "这条消息里有好几张图时，查第几张，从 1 开始；只有一张可以不填" },
        intent: { type: "string", description: "你想知道什么，比如\"画师是谁\"" },
      },
      required: ["message"],
    },
    async run(args, ctx) {
      const match = /^m?(\d+)$/.exec(String(args.message ?? "").trim());
      if (!match) return `消息编号要写成 m12 这样，收到的是：${args.message}`;
      const event = await deps.events.get(ctx.groupId, Number(match[1]));
      if (!event || event.kind !== "message") return `找不到 m${match[1]} 这条消息`;

      const images = (event.body as NormalizedMessage).segments.filter((s): s is ImageSegment => s.type === "image");
      if (images.length === 0) return `m${match[1]} 里没有图`;
      const index = args.image === undefined ? 1 : Number(args.image);
      const image = images[index - 1];
      if (!image) return `m${match[1]} 只有 ${images.length} 张图`;
      if (!image.file) return "这张图当时没能保存下来，查不了";

      const buffer = await readFile(join(deps.mediaDir, image.file));
      const summary = await deps.search.searchImage(buffer, image.file, String(args.intent ?? "出处和画师"));
      return summary ?? "没查到这张图的出处";
    },
  };
}
