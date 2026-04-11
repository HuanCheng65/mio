export const ALLOWED_REACT_EMOJI_NAMES = [
  "赞",
  "爱心",
  "太好笑",
  "可怜",
  "捂脸",
  "心碎",
  "流泪",
  "惊讶",
  "拜谢",
  "冷漠",
  "汪汪",
  "菜汪",
  "问号",
  "辣眼睛",
  "变形",
  "我酸了",
  "暗中观察",
  "舔屏",
  "糗大了",
] as const;

export const ALLOWED_REACT_EMOJI_TEXT = ALLOWED_REACT_EMOJI_NAMES.join("、");
