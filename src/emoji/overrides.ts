import type { QQEmoji } from "@wittf/koishi-plugin-adapter-onebot";

/**
 * 本地补充的 QQ 表情映射。
 * 规则：
 * - id 必须是 OneBot set_msg_emoji_like 可用的 emoji_id
 * - name 不带前导 '/'
 */
export const EMOJI_OVERRIDES: QQEmoji[] = [
  {
    id: "10068",
    name: "问号",
    QSid: "10068",
    QDes: "/问号",
  },
  {
    id: "424",
    name: "续标识",
    QSid: "424",
    QDes: "/续标识",
  },
  {
    id: "387",
    name: "太好笑",
    QSid: "387",
    QDes: "/太好笑",
  },
];
