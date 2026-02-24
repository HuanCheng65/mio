import { h, Session } from "koishi";
import { Jimp } from "jimp";
import { LLMClient, ChatMessage } from "../llm/client";
import { ModelConfig } from "../llm/provider";
import { getPromptManager } from "../memory/prompt-manager";
import { VLMImageAnalysis } from "../sticker/types";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const promptManager = getPromptManager();

export interface ImageElement {
  url: string;
  type: "image";
}

export class ImageProcessor {
  private llm: LLMClient;
  private modelConfig: ModelConfig;
  private cacheDir: string;
  private cache: Map<string, string> = new Map(); // 内容哈希 -> 描述
  private urlToHash: Map<string, string> = new Map(); // URL -> 内容哈希（内存缓存，避免重复下载）

  constructor(
    llm: LLMClient,
    modelConfig: ModelConfig,
    cacheDir: string = "./data/image-cache",
  ) {
    this.llm = llm;
    this.modelConfig = modelConfig;
    this.cacheDir = cacheDir;

    // 确保缓存目录存在
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    // 加载缓存
    this.loadCache();
  }

  /**
   * 下载图片并计算内容哈希
   */
  private async downloadAndHash(url: string): Promise<string | null> {
    try {
      const buffer = await this.downloadImage(url);
      return crypto.createHash("sha256").update(buffer).digest("hex");
    } catch (error) {
      console.error(`[ImageProcessor] 下载图片失败: ${url}`, error);
      return null;
    }
  }

  /**
   * 下载图片内容
   */
  private downloadImage(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const chunks: Buffer[] = [];

      client
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        })
        .on("error", reject);
    });
  }

  async downloadBuffer(url: string): Promise<Buffer | null> {
    try {
      return await this.downloadImage(url)
    } catch (error) {
      console.error(`[ImageProcessor] 下载图片失败: ${url}`, error)
      return null
    }
  }

  /**
   * 从磁盘加载缓存
   */
  private loadCache(): void {
    try {
      // 加载内容哈希缓存
      const hashCacheFile = path.join(this.cacheDir, "hash-cache.json");
      if (fs.existsSync(hashCacheFile)) {
        const data = fs.readFileSync(hashCacheFile, "utf-8");
        const cacheData = JSON.parse(data);
        this.cache = new Map(Object.entries(cacheData));
      }

      // 加载 URL 映射缓存
      const urlCacheFile = path.join(this.cacheDir, "url-cache.json");
      if (fs.existsSync(urlCacheFile)) {
        const data = fs.readFileSync(urlCacheFile, "utf-8");
        const urlData = JSON.parse(data);
        this.urlToHash = new Map(Object.entries(urlData));
      }

      console.log(`[ImageProcessor] 加载了 ${this.cache.size} 条内容缓存，${this.urlToHash.size} 条 URL 映射`);
    } catch (error) {
      console.error("[ImageProcessor] 加载缓存失败:", error);
    }
  }

  /**
   * 保存缓存到磁盘
   */
  private saveCache(): void {
    try {
      // 保存内容哈希缓存
      const hashCacheFile = path.join(this.cacheDir, "hash-cache.json");
      const hashData = Object.fromEntries(this.cache);
      fs.writeFileSync(hashCacheFile, JSON.stringify(hashData, null, 2), "utf-8");

      // 保存 URL 映射缓存
      const urlCacheFile = path.join(this.cacheDir, "url-cache.json");
      const urlData = Object.fromEntries(this.urlToHash);
      fs.writeFileSync(urlCacheFile, JSON.stringify(urlData, null, 2), "utf-8");
    } catch (error) {
      console.error("[ImageProcessor] 保存缓存失败:", error);
    }
  }

  /**
   * 从缓存获取图片描述（异步，需要下载图片计算哈希）
   */
  private async getCached(url: string): Promise<string | null> {
    // 先查内存缓存
    const cachedHash = this.urlToHash.get(url);
    if (cachedHash) {
      return this.cache.get(cachedHash) || null;
    }

    // 下载并计算哈希
    const hash = await this.downloadAndHash(url);
    if (!hash) return null;

    // 记录 URL -> 哈希映射
    this.urlToHash.set(url, hash);

    return this.cache.get(hash) || null;
  }

  /**
   * 快速检查缓存（同步，仅查内存，不下载）
   */
  getCachedSync(url: string): string | null {
    const cachedHash = this.urlToHash.get(url);
    return cachedHash ? this.cache.get(cachedHash) || null : null;
  }

  /**
   * 将图片描述存入缓存
   */
  private async setCached(url: string, description: string): Promise<void> {
    const hash = await this.downloadAndHash(url);
    if (!hash) return;

    // 更新两个缓存
    this.cache.set(hash, description);
    this.urlToHash.set(url, hash);
    this.saveCache();
  }

  /**
   * 压缩图片用于 VLM 分析，降低 token 消耗
   * 按总像素数限制缩放，保证长图/宽图短边不会被压得太小
   */
  private async compressImage(
    buffer: Buffer,
    maxPixels: number = 768 * 768,
  ): Promise<string> {
    const image = await Jimp.read(buffer);
    const { width, height } = image;

    const currentPixels = width * height;
    if (currentPixels > maxPixels) {
      const scale = Math.sqrt(maxPixels / currentPixels);
      image.resize({
        w: Math.round(width * scale),
        h: Math.round(height * scale),
      });
    }

    const jpegBuffer = await image.getBuffer("image/jpeg", { quality: 80 });
    const base64 = jpegBuffer.toString("base64");
    return `data:image/jpeg;base64,${base64}`;
  }

  /**
   * 从 session 中提取所有图片元素
   */
  extractImages(session: Session): ImageElement[] {
    const images: ImageElement[] = [];
    const seenUrls = new Set<string>();

    if (!session.elements) return images;

    for (const element of session.elements) {
      if (element.type === "img" || element.type === "image") {
        const url = element.attrs?.src || element.attrs?.url;
        if (url && !seenUrls.has(url)) {
          images.push({ url, type: "image" });
          seenUrls.add(url);
        }
      }
    }

    return images;
  }

  /**
   * 调用多模态模型理解图片内容
   * @param imageUrl 图片 URL
   */
  async understandImage(imageUrl: string): Promise<string> {
    const analysis = await this.analyzeImage(imageUrl)
    return analysis.description
  }

  async analyzeImage(imageUrl: string): Promise<VLMImageAnalysis> {
    // Cache check — cache may hold old plain-text or new JSON
    const cached = await this.getCached(imageUrl)
    if (cached) {
      try {
        const parsed = JSON.parse(cached)
        if (parsed && typeof parsed.description === 'string') {
          // Migrate old { sticker: bool, sticker_collect: bool } → new { type, collect }
          if ('sticker' in parsed && !('type' in parsed)) {
            parsed.type = parsed.sticker ? 'sticker' : 'other'
            if (parsed.sticker_collect !== undefined) {
              parsed.collect = parsed.sticker_collect
            }
            delete parsed.sticker
            delete parsed.sticker_collect
          }
          return parsed as VLMImageAnalysis
        }
      } catch {
        // Old plain-text cache entry — treat as other
        return { description: cached, type: 'other' }
      }
    }

    console.log(`[ImageProcessor] 调用 LLM 分析图片: ${imageUrl.substring(0, 50)}...`)

    const prompt = promptManager.getRaw('image_understanding')

    try {
      // 下载图片，GIF 保留原始格式（VLM 原生支持动图），其他格式压缩
      const buffer = await this.downloadImage(imageUrl)
      const isGif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 // "GIF" magic bytes
      const resolvedUrl = isGif ? imageUrl : await this.compressImage(buffer)

      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: JSON.stringify([
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: resolvedUrl } },
          ]),
        },
      ]

      const response = await this.llm.chat(messages, this.modelConfig, {
        maxTokens: this.modelConfig.maxTokens || 500,
        responseFormat: 'json_object',
      })

      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('VLM response contains no JSON')

      const analysis: VLMImageAnalysis = JSON.parse(jsonMatch[0])

      // Store JSON string in cache (reusing existing cache infrastructure)
      await this.setCached(imageUrl, JSON.stringify(analysis))

      return analysis
    } catch (error) {
      console.error('[ImageProcessor] 图片分析失败:', error)
      return { description: '一张图片', type: 'other' }
    }
  }

  /**
   * 处理消息中的所有图片，返回替换后的文本内容
   */
  async processMessage(
    session: Session,
    originalContent: string,
  ): Promise<string> {
    const images = this.extractImages(session);

    if (images.length === 0) {
      return originalContent;
    }

    // 并行处理所有图片
    const descriptions = await Promise.all(
      images.map((img) => this.understandImage(img.url)),
    );

    // 构建替换后的内容
    let processedContent = originalContent;

    // 移除原始的图片标签（CQ 码或 HTML 标签）
    processedContent = processedContent
      .replace(/\[CQ:image,[^\]]+\]/g, "")
      .replace(/<img[^>]*>/g, "")
      .replace(/<image[^>]*>/g, "")
      .trim();

    // 添加图片描述
    const imageDescriptions = descriptions
      .map((desc, idx) => `[图片${images.length > 1 ? idx + 1 : ""}：${desc}]`)
      .join(" ");

    // 如果原内容为空（只有图片），直接返回图片描述
    if (!processedContent) {
      return imageDescriptions;
    }

    // 否则将图片描述附加到文本后面
    return `${processedContent} ${imageDescriptions}`;
  }
}
