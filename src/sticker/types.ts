// VLM response shape for the combined image analysis prompt
export interface VLMImageAnalysis {
  description: string
  sticker: boolean
  sticker_collect?: boolean
  sticker_vibe?: string    // space-separated: "无语 无奈 累了"
  sticker_style?: string   // space-separated: "猫猫 简洁"
  sticker_scene?: string   // ≤15 chars: "对方说了离谱的话时"
}
