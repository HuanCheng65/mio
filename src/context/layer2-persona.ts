/**
 * Layer 2: 人设定义 (Persona)
 *
 * 用「自我认知」的口吻书写，而不是「角色说明书」的口吻
 */

import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * 加载人设文件
 */
export function loadPersona(personaFile: string): string {
  try {
    const personaPath = resolve(__dirname, "../../data/persona", personaFile);
    const content = readFileSync(personaPath, "utf-8");
    return content;
  } catch (error) {
    const personaPath = resolve(__dirname, "../../data/persona", personaFile);
    throw new Error(`Failed to load persona file: ${personaFile} at ${personaPath}. Error: ${error}`);
  }
}

/**
 * 获取 Persona 层内容
 */
export function getPersonaLayer(personaFile: string): string {
  return loadPersona(personaFile);
}
