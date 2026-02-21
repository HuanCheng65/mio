# koishi-plugin-mio

不是聊天机器人，是群友。

澪（みお）是一个 Koishi 插件，用大语言模型驱动一个拟人化的 QQ 群成员。她不会有求必应，不会每条消息都回复，大部分时候只是安静地看着聊天记录。碰到感兴趣的话题才搭两句，觉得没什么好说的就沉默——就像群里那个在线但不怎么说话的人。

## 她会什么

**看懂对话，选择性参与**

澪读所有消息，但大多数时候选择沉默。她有一套触发机制：等对话出现停顿再回话（而不是抢着说），被 @ 或被叫名字会立刻响应。连续回了几条之后会自己停下来。这些不是规则，是她「正常群友」行为的一部分。

**记住你说过的事**

三层记忆系统：

- **情景记忆** — 发生过什么事。群里吵过的架、聊过的番、深夜的胡说八道，都会被概括成一段段记忆，按重要程度保留。
- **关系记忆** — 对每个人的印象。谁经常聊天、谁跟她频率对得上、谁叫什么名字，都会慢慢积累。熟了之后说话方式会变。
- **语义记忆** — 提取出的事实。「某某喜欢 KEY 社」「某某不吃香菜」这类碎片知识，带置信度，会随新信息更新。

每天凌晨跑一次记忆蒸馏，把短期记忆整理成长期印象。

**搜东西**

聊天聊到不确定的事情，她可以自己决定去查一下。根据话题自动选搜索源：

- 番剧/动画 → Bangumi
- Galgame → Bangumi + VNDB
- 其他 → SearXNG

搜回来的结果会被压缩成自然语言，融进她的回复里。不是「搜索结果如下」，是「我记得这个好像是……」的感觉。

**看图**

群里发的图她能看懂（需要配视觉模型）。不只是描述图片内容，还会判断这是不是表情包、适合什么情绪、什么场景用。

**收藏和发表情包**

看到喜欢的表情包会自动收藏。用感知哈希去重，用 embedding 建立语义索引。回复的时候如果觉得适合发表情包，会从收藏里按情绪和场景匹配一张发出来。收藏池有数量限制，质量低的、用不到的会逐渐淘汰。

## 架构

```
src/
├── llm/          # LLM 调用层（OpenAI 兼容 + Gemini）
├── perception/   # 消息标准化 & 渲染
├── pipeline/     # 消息缓冲、防抖、图片处理
├── context/      # 分层 prompt 构建
├── delivery/     # 消息发送、@解析、拟人化延迟
├── memory/       # 情景 / 关系 / 语义记忆 + 蒸馏
├── search/       # 多源搜索 + 结果压缩
├── sticker/      # 表情包收集 / 检索 / 维护
└── types/        # 响应结构定义
```

Prompt 系统分四层设计，从不变的认知框架到动态的聊天记录，方便 LLM 做前缀缓存。LLM 的输出是结构化 JSON（思考、是否沉默、搜索请求、动作列表），不是裸文本。

## 配置

```yaml
botName: 澪
botAliases: [みお, 小澪]
personaFile: mio.md          # 人设文件，定义她是谁
enableGroups: ['123456']     # 启用的群号

providers:                    # 支持多个 LLM 提供商
  - name: deepseek
    baseUrl: https://api.deepseek.com/v1
    apiKey: sk-...
    provider: openai

models:
  chat: { providerName: deepseek, model: deepseek-chat }
  vision: { providerName: gemini, model: gemini-2.0-flash }

memory:
  enabled: true
  distillationHour: 3        # 凌晨 3 点蒸馏

search:
  enabled: true
  searxngBaseUrl: http://localhost:8080

sticker:
  enabled: true
  imageDir: ./data/stickers
```

具体的配置项和默认值见 `src/index.tsx` 里的 `Config` 接口和 `Schema` 定义。

## 依赖

- [Koishi](https://koishi.chat) v4
- [OneBot 适配器](https://github.com/ArilyChan/koishi-plugin-adapter-onebot)（QQ 接入）
- OpenAI SDK / Google GenAI SDK（LLM 调用）
- jimp（图片处理）

## 开始使用

```bash
# 安装依赖
yarn

# 编译
yarn build
```

作为 Koishi 插件加载即可。需要先配好至少一个 LLM 提供商和 OneBot 适配器。

## 关于人设

`data/persona/mio.md` 定义了澪这个人。不是提示词模板，更像是一份关于她的备忘录——她的日常、性格、跟人的距离感、脑子里装的东西。插件在构建 prompt 时会把这份文件注入系统消息。

你可以改这个文件来创造完全不同的角色，但整个系统的行为逻辑（沉默优先、慢热、选择性参与）是围绕「正常群友」这个前提设计的。如果你想做一个有求必应的助手，这个插件可能不太适合。

## License

MIT
