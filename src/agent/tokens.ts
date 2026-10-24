/** DeepSeek 视觉文档：每张图缩放后最多 1024 token */
export const IMAGE_TOKENS = 1024;

/**
 * 粗略估算 token 数，只用于压缩阈值之类的预算判断；真实用量以 API 返回的 usage 为准。
 * 中日韩字符大约一字一 token，其余字符大约四个一 token。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
