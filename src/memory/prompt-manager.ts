import { readFileSync } from 'fs'
import { resolve } from 'path'
import YAML from 'yaml'

/**
 * Prompt 模板管理器（单例）
 * 从 data/prompts.yaml 加载所有 prompt 模板
 */
class PromptManager {
  private static instance: PromptManager | null = null
  private templates: Record<string, string> = {}
  private promptPath: string

  private constructor(dataDir: string = resolve(__dirname, '../../data')) {
    this.promptPath = resolve(dataDir, 'prompts.yaml')
    this.load()
  }

  /**
   * 获取单例实例
   */
  static getInstance(dataDir?: string): PromptManager {
    if (!PromptManager.instance) {
      PromptManager.instance = new PromptManager(dataDir)
    }
    return PromptManager.instance
  }

  /**
   * 加载或重载 prompt 模板
   */
  load(): void {
    try {
      const content = readFileSync(this.promptPath, 'utf-8')
      this.templates = YAML.parse(content)
      console.log(`[PromptManager] 已加载 ${Object.keys(this.templates).length} 个 prompt 模板`)
    } catch (err) {
      throw new Error(`Failed to load prompts.yaml: ${err}`)
    }
  }

  /**
   * 重载 prompt 模板（用于热更新）
   */
  reload(): void {
    console.log('[PromptManager] 重新加载 prompt 模板...')
    this.load()
  }

  /**
   * 获取 prompt 模板并填充变量
   */
  get(key: string, vars?: Record<string, string>): string {
    const template = this.templates[key]
    if (!template) {
      throw new Error(`Prompt template not found: ${key}`)
    }

    if (!vars) return template

    let result = template
    for (const [k, v] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
    }
    return result
  }

  /**
   * 获取原始模板（不填充变量）
   */
  getRaw(key: string): string {
    const template = this.templates[key]
    if (!template) {
      throw new Error(`Prompt template not found: ${key}`)
    }
    return template
  }
}

// 导出单例获取函数
export function getPromptManager(): PromptManager {
  return PromptManager.getInstance()
}

// 导出重载函数
export function reloadPrompts(): void {
  PromptManager.getInstance().reload()
}
