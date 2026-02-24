import type { SearchResult } from '../types';

import { Blob } from 'node:buffer';

const CONFIG = {
    UPLOAD_URL: 'https://yandex.com/images/search',
    SEARCH_URL: 'https://yandex.com/images/search',
    // 模拟上传时的参数
    UPLOAD_PARAMS: {
        rpt: 'imageview',
        format: 'json',
        request: JSON.stringify({ "blocks": [{ "block": "b-page_type_search-by-image__link" }] })
    },
    // 模拟获取数据的参数
    RESULT_PARAMS: (cbirId: string) => ({
        cbir_id: cbirId,
        rpt: 'imageview',
        format: 'json',
        // 关键：请求核心数据块
        request: JSON.stringify({
            "blocks": [{ "block": "content_type_search-by-image", "params": {}, "version": 2 }]
        })
    })
};

// 核心解析函数：从 HTML 属性中提取 JSON
function parseYandexData(jsonResponse: any): any {
    try {
        // 1. 获取包含 data-state 的 HTML 字符串
        const htmlBlock = jsonResponse.blocks?.find((b: any) => b.html && b.html.includes('data-state'));
        if (!htmlBlock) return null;

        // 2. 正则提取 data-state="..." 的内容
        const match = htmlBlock.html.match(/data-state="([^"]+)"/);
        if (!match || !match[1]) return null;

        // 3. 解码 HTML 实体 (&quot; -> ") 并解析 JSON
        const rawState = match[1].replace(/&quot;/g, '"');
        const state = JSON.parse(rawState);

        return state;
    } catch (e: any) {
        console.error('[Yandex] 解析内部数据失败:', e.message);
        return null;
    }
}

/**
 * Yandex 以图搜图（直接请求接口版，原 Puppeteer版已废弃）。
 */
export class YandexImageSearch {
    /**
     * 空的方法，保持与原接口兼容
     */
    async close(): Promise<void> {
        // 不需要浏览器
    }

    /**
     * 以图搜图。接受图片 Buffer，通过直接请求上传到 Yandex 并解析 JSON 结果。
     */
    async search(imageBuffer: Buffer, filename: string = 'image.jpg'): Promise<SearchResult[]> {
        console.log(`🚀 [Yandex] 开始执行 Yandex 以图搜图...`);

        try {
            // --- Step 1: 上传图片 ---
            const formData = new FormData();
            formData.append('upfile', new Blob([imageBuffer], { type: 'image/jpeg' }) as any, filename);

            const { gotScraping } = await (new Function("return import('got-scraping')")());

            console.log(`[Yandex] 正在上传图片...`);
            const uploadResponse = await gotScraping.post(CONFIG.UPLOAD_URL, {
                searchParams: CONFIG.UPLOAD_PARAMS,
                body: formData as any,
                headers: { 'Origin': 'https://yandex.com', 'Referer': 'https://yandex.com/images/' },
                responseType: 'json',
                retry: { limit: 0 }
            });

            const uploadBody = uploadResponse.body as any;

            // 检查验证码
            if (typeof uploadBody === 'string' && uploadBody.includes('smart-captcha')) {
                console.error(`⚠️  [Yandex] 触发了验证码。`);
                return [];
            }

            // 获取 CBIR ID
            let cbirId;
            if (uploadBody.blocks) {
                const linkBlock = uploadBody.blocks.find((b: any) => b.params && b.params.cbirId);
                if (linkBlock) cbirId = linkBlock.params.cbirId;
            }

            if (!cbirId) {
                console.error('❌ [Yandex] 上传成功但未获取到 cbirId，响应结构可能有变。');
                return [];
            }
            console.log(`✅ [Yandex] 获取 ID 成功: ${cbirId}`);

            // --- Step 2: 获取并解析数据 ---
            console.log(`🔍 [Yandex] 抓取详细数据...`);

            const { gotScraping: gotScrapingForSearch } = await (new Function("return import('got-scraping')")());

            const resultResponse = await gotScrapingForSearch.get(CONFIG.SEARCH_URL, {
                searchParams: CONFIG.RESULT_PARAMS(cbirId),
                headers: { 'Referer': `https://yandex.com/images/search?cbir_id=${cbirId}&rpt=imageview` },
                responseType: 'json'
            });

            const rawData = resultResponse.body as any;
            const parsedState = parseYandexData(rawData);

            if (!parsedState) {
                console.error('❌ [Yandex] 数据提取失败，未能从 HTML 中解构出 data-state。');
                return [];
            }

            console.log(`🎉 [Yandex] 数据解析完成！`);

            const results: SearchResult[] = [];
            const seenUrls = new Set<string>();

            // 提取来源网站 (sites)
            const sites = parsedState.initialState?.cbirSites?.sites || [];
            console.log(`[Yandex] 找到 ${sites.length} 个来源网站`);

            for (const site of sites) {
                if (results.length >= 5) break;
                if (!site.url || seenUrls.has(site.url)) continue;
                seenUrls.add(site.url);

                results.push({
                    title: `Yandex: ${site.title || site.domain || '来源'}`,
                    description: `Domain: ${site.domain || ''}\n${site.description || ''}`.trim(),
                    url: site.url,
                    source: 'yandex'
                });
            }

            // 提取相似图片补充
            if (results.length < 5) {
                const similar = parsedState.initialState?.cbirSimilar?.thumbs || [];
                console.log(`[Yandex] 找到 ${similar.length} 张相似图片`);
                for (const item of similar) {
                    if (results.length >= 5) break;
                    const itemUrl = item.url ? item.url : `https://yandex.com${item.linkUrl}`;
                    if (!itemUrl || seenUrls.has(itemUrl)) continue;
                    seenUrls.add(itemUrl);

                    results.push({
                        title: `Yandex: ${item.title || '相似图片'}`,
                        description: '相似图片搜索结果',
                        url: itemUrl,
                        source: 'yandex'
                    });
                }
            }

            console.log(`[Yandex] 最终提取到 ${results.length} 条结果`);
            return results;

        } catch (error: any) {
            console.error(`❌ [Yandex] 搜索出错:`, error.message);
            return [];
        }
    }
}
