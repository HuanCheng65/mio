export interface PersonaListItem {
  id?: string;
  name: string;
  isDefault: boolean;
  boundGroupCount: number;
  updatedAt: number;
}

export interface PersonaRowSummary {
  badges: string[];
  meta: string;
}

export interface PersonaCacheStats {
  total: number;
  byPersona: Record<string, number>;
}

export function buildDeletePersonaWarning(name: string, groupIds: string[]) {
  if (groupIds.length === 0) {
    return `删除 ${name} 后，不会影响任何群绑定。`;
  }

  return `删除 ${name} 后，${groupIds.length} 个群会恢复到默认人设。`;
}

export function summarizePersonaRow(persona: PersonaListItem, now = Date.now()): PersonaRowSummary {
  const badges = persona.isDefault ? ["默认"] : [];
  const metaParts = [`${persona.boundGroupCount} 个群`, formatRelativeTime(persona.updatedAt, now)];

  return {
    badges,
    meta: metaParts.join(" · "),
  };
}

export function buildCacheSummary(stats: PersonaCacheStats | null | undefined) {
  if (!stats) {
    return "加载中";
  }

  const personaCount = Object.keys(stats.byPersona ?? {}).length;
  return `${stats.total} 条缓存 · ${personaCount} 个人设`;
}

export function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatRelativeTime(timestamp: number, now: number) {
  const diffMs = Math.max(0, now - timestamp);
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) {
    return "刚刚";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} 天前`;
}
