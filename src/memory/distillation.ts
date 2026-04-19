import { Context } from "koishi";
import { LLMClient } from "../llm/client";
import {
  CultureEvidenceBucketMap,
  CultureEvidenceCluster,
  CultureEvidenceKind,
  CultureEvidenceRow,
  CultureEvidenceSupport,
  DistillationResult,
  MemoryConfig,
} from "./types";
import { MioEpisodicRow, MioRelationalRow, MioSemanticRow } from "./tables";
import { getPromptManager } from "./prompt-manager";
import { EmbeddingService, cosineSimilarity } from "./embedding";

const promptManager = getPromptManager();
const CULTURE_EVIDENCE_DAY_MS = 86400_000;
const CULTURE_EVIDENCE_RECENT_WINDOW_MS = 30 * CULTURE_EVIDENCE_DAY_MS;
const CULTURE_EVIDENCE_CLUSTER_SIMILARITY = 0.92;
const CULTURE_EVIDENCE_PROMOTION_MIN_WINDOWS = 2;
const CULTURE_EVIDENCE_ACTIVE_FACT_LIMIT = 15;
const CULTURE_EVIDENCE_PROMOTABLE_CLUSTER_LIMIT = 8;
const CULTURE_CANDIDATE_RECENT_WINDOW_MS = 30 * CULTURE_EVIDENCE_DAY_MS;
const GROUP_CULTURE_DEDUP_SIMILARITY = 0.9;
const GROUP_CULTURE_TEXT_DEDUP_SIMILARITY = 0.5;
const GROUP_CULTURE_RECENCY_WEIGHT = 0.2;
const CULTURE_EVIDENCE_KINDS: CultureEvidenceKind[] = [
  "group_expression",
  "reaction_pattern",
  "tool_knowledge",
  "inside_joke",
];
const GROUP_CULTURE_FACT_TYPES = new Set<MioSemanticRow["factType"]>([
  "group_expression",
  "reaction_pattern",
  "tool_knowledge",
  "inside_joke",
]);

interface GroupCultureClusterSummary {
  clusterIndex: number;
  clusterId: string;
  kind: CultureEvidenceKind;
  support: CultureEvidenceSupport;
  representative: string;
  evidenceLines: string[];
  evidence: CultureEvidenceRow[];
}

interface GroupCultureCanonicalizationPromptResult {
  promoted_facts?: Array<{
    cluster_index: number;
    fact_type?: string;
    content: string;
    confidence?: number;
  }>;
  merged_facts?: Array<{
    id: number;
    new_content: string;
    new_confidence?: number;
  }>;
  confirmed_facts?: Array<{
    id: number;
    new_confidence?: number;
  }>;
  decayed_facts?: Array<{
    id: number;
    new_confidence?: number;
  }>;
}

interface GroupCultureFactPatchState {
  merged?: Partial<MioSemanticRow>;
  confirmed?: Partial<MioSemanticRow>;
  decayed?: Partial<MioSemanticRow>;
}

// ===== Helpers =====

function formatFacts(facts: MioSemanticRow[]): string {
  if (facts.length === 0) return "（暂无）";
  return facts
    .map(
      (f) =>
        `[id=${f.id}] ${f.subject}: ${f.content} (${f.factType}, confidence=${f.confidence})`,
    )
    .join("\n");
}

function formatEpisodes(episodes: MioEpisodicRow[]): string {
  return episodes
    .map((e) => {
      const date = new Date(e.eventTime).toLocaleDateString("zh-CN");
      const participants = e.participants.join(", ");
      return `[ep=${e.id}] ${date} [参与者: ${participants}] ${e.summary}`;
    })
    .join("\n");
}

function parseJSON(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isGroupFactType(value: unknown): value is MioSemanticRow["factType"] {
  return typeof value === "string" && GROUP_CULTURE_FACT_TYPES.has(value as MioSemanticRow["factType"]);
}

function normalizeGroupFactType(
  value: unknown,
  fallback: CultureEvidenceKind,
): MioSemanticRow["factType"] {
  return isGroupFactType(value) ? value : fallback;
}

function normalizeGroupCultureContent(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?:"'`~\-/\\()[\]{}]/g, "");
}

function computeGroupCultureTextSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const makeBigrams = (text: string): string[] => {
    const grams: string[] = [];
    for (let i = 0; i < text.length - 1; i++) {
      grams.push(text.slice(i, i + 2));
    }
    return grams;
  };

  const aBigrams = makeBigrams(a);
  const bBigrams = makeBigrams(b);
  if (aBigrams.length === 0 || bBigrams.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const gram of aBigrams) {
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }

  let overlap = 0;
  for (const gram of bBigrams) {
    const count = counts.get(gram) || 0;
    if (count <= 0) continue;
    overlap++;
    counts.set(gram, count - 1);
  }

  return (2 * overlap) / (aBigrams.length + bBigrams.length);
}

function computeGroupFactPriority(fact: MioSemanticRow): number {
  const recencyDays = Math.max(0, (Date.now() - fact.lastConfirmed) / CULTURE_EVIDENCE_DAY_MS);
  return fact.confidence + (1 / (1 + recencyDays)) * GROUP_CULTURE_RECENCY_WEIGHT;
}

function areLegacyGroupFactsNearDuplicate(a: MioSemanticRow, b: MioSemanticRow): boolean {
  if (a.factType !== b.factType) return false;

  const normalizedA = normalizeGroupCultureContent(a.content);
  const normalizedB = normalizeGroupCultureContent(b.content);
  if (normalizedA === normalizedB) return true;

  const textSimilarity = computeGroupCultureTextSimilarity(normalizedA, normalizedB);
  if (a.embedding.length > 0 && a.embedding.length === b.embedding.length) {
    return (
      cosineSimilarity(a.embedding, b.embedding) >= GROUP_CULTURE_DEDUP_SIMILARITY &&
      textSimilarity >= GROUP_CULTURE_TEXT_DEDUP_SIMILARITY
    );
  }

  return textSimilarity >= GROUP_CULTURE_TEXT_DEDUP_SIMILARITY;
}

function formatCultureEvidenceSummary(row: CultureEvidenceRow): string {
  const date = new Date(getCultureActivityAt(row)).toLocaleDateString("zh-CN");
  return `${date} ${row.content} (confidence=${row.confidence.toFixed(2)})`;
}

function formatGroupCultureClusters(clusters: GroupCultureClusterSummary[]): string {
  if (clusters.length === 0) {
    return "（暂无可归纳的群文化簇）";
  }

  return clusters
    .map((cluster) => {
      const evidence = cluster.evidenceLines.map((line) => `  - ${line}`).join("\n");
      return [
        `[cluster=${cluster.clusterIndex} kind=${cluster.kind} score=${cluster.support.score.toFixed(2)} windows=${cluster.support.distinctWindows} count=${cluster.support.count}]`,
        `代表：${cluster.representative}`,
        evidence,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function isActiveSemanticFact(fact: MioSemanticRow): boolean {
  return fact.supersededBy === null || fact.supersededBy === undefined;
}

function getCultureActivityAt(row: Pick<CultureEvidenceRow, "observedAt" | "lastSeenAt">): number {
  return Math.max(row.observedAt, row.lastSeenAt);
}

function getCultureDayKey(timestamp: number): number {
  return Math.floor(timestamp / CULTURE_EVIDENCE_DAY_MS);
}

function getEmbeddingDimension(embedding: number[]): number | null {
  return embedding.length > 0 ? embedding.length : null;
}

function averageEmbedding(vectors: number[][], dimension: number): number[] {
  if (vectors.length === 0) return [];
  const sums = new Array(dimension).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimension; i++) {
      sums[i] += vector[i];
    }
  }

  return sums.map((value) => value / vectors.length);
}

function inferSupportNow(rows: CultureEvidenceRow[]): number {
  if (rows.length === 0) return Date.now();
  return rows.reduce((latest, row) => Math.max(latest, getCultureActivityAt(row)), 0);
}

function sortCultureClusters(clusters: CultureEvidenceCluster[]): CultureEvidenceCluster[] {
  return clusters.sort((a, b) => {
    const aAt = a.evidence.length > 0 ? getCultureActivityAt(a.evidence[0]) : 0;
    const bAt = b.evidence.length > 0 ? getCultureActivityAt(b.evidence[0]) : 0;
    if (aAt !== bAt) return aAt - bAt;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    const aId = a.evidence.length > 0 ? a.evidence[0].id : 0;
    const bId = b.evidence.length > 0 ? b.evidence[0].id : 0;
    return aId - bId;
  });
}

interface CultureEvidenceWindowAggregate {
  sourceWindowKey: string;
  rows: CultureEvidenceRow[];
  representative: CultureEvidenceRow;
}

function selectWindowRepresentative(rows: CultureEvidenceRow[]): CultureEvidenceRow {
  return [...rows].sort((a, b) => {
    const aAt = getCultureActivityAt(a);
    const bAt = getCultureActivityAt(b);
    if (aAt !== bAt) return bAt - aAt;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.id - b.id;
  })[0];
}

function groupCultureEvidenceByWindow(
  rows: CultureEvidenceRow[],
): CultureEvidenceWindowAggregate[] {
  const windows = new Map<string, CultureEvidenceRow[]>();
  for (const row of rows) {
    const key = row.sourceWindowKey || `row:${row.id}`;
    const bucket = windows.get(key);
    if (bucket) {
      bucket.push(row);
      continue;
    }
    windows.set(key, [row]);
  }

  return [...windows.entries()]
    .map(([sourceWindowKey, windowRows]) => ({
      sourceWindowKey,
      rows: windowRows,
      representative: selectWindowRepresentative(windowRows),
    }))
    .sort((a, b) => {
      const aAt = getCultureActivityAt(a.representative);
      const bAt = getCultureActivityAt(b.representative);
      if (aAt !== bAt) return aAt - bAt;
      if (a.sourceWindowKey !== b.sourceWindowKey) {
        return a.sourceWindowKey.localeCompare(b.sourceWindowKey);
      }
      return a.representative.id - b.representative.id;
    });
}

function filterValidCultureEvidenceWindows(
  windows: CultureEvidenceWindowAggregate[],
): CultureEvidenceWindowAggregate[] {
  const valid: CultureEvidenceWindowAggregate[] = [];

  for (const window of windows) {
    const orderedRows = [...window.rows].sort((a, b) => {
      const aAt = getCultureActivityAt(a);
      const bAt = getCultureActivityAt(b);
      if (aAt !== bAt) return bAt - aAt;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.id - b.id;
    });

    const dimensionCounts = new Map<number, number>();
    for (const row of orderedRows) {
      const dimension = getEmbeddingDimension(row.embedding);
      if (dimension === null) continue;
      dimensionCounts.set(dimension, (dimensionCounts.get(dimension) || 0) + 1);
    }

    if (dimensionCounts.size === 0) continue;

    let dimension: number | null = null;
    let maxCount = -1;
    for (const row of orderedRows) {
      const candidate = getEmbeddingDimension(row.embedding);
      if (candidate === null) continue;
      const count = dimensionCounts.get(candidate) || 0;
      if (count > maxCount || (count === maxCount && (dimension === null || candidate > dimension))) {
        dimension = candidate;
        maxCount = count;
      }
    }

    if (dimension === null) continue;

    const validRows = window.rows.filter((row) => row.embedding.length === dimension);
    if (validRows.length === 0) continue;

    valid.push({
      sourceWindowKey: window.sourceWindowKey,
      rows: validRows,
      representative: selectWindowRepresentative(validRows),
    });
  }

  return valid;
}

function buildCultureEvidenceAdjacency(
  windows: CultureEvidenceWindowAggregate[],
  similarityThreshold: number,
): number[][] {
  const adjacency = windows.map(() => new Array(windows.length).fill(0));

  for (let i = 0; i < windows.length; i++) {
    adjacency[i][i] = 1;
    for (let j = i + 1; j < windows.length; j++) {
      const similarity = cosineSimilarity(
        windows[i].representative.embedding,
        windows[j].representative.embedding,
      );
      if (similarity >= similarityThreshold) {
        adjacency[i][j] = 1;
        adjacency[j][i] = 1;
      }
    }
  }

  return adjacency;
}

function collectConnectedComponents(adjacency: number[][]): number[][] {
  const visited = new Array(adjacency.length).fill(false);
  const components: number[][] = [];

  for (let i = 0; i < adjacency.length; i++) {
    if (visited[i]) continue;

    const component: number[] = [];
    const stack = [i];
    visited[i] = true;

    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);

      for (let next = 0; next < adjacency[current].length; next++) {
        if (adjacency[current][next] !== 1 || visited[next]) continue;
        visited[next] = true;
        stack.push(next);
      }
    }

    component.sort((a, b) => a - b);
    components.push(component);
  }

  return components.sort((a, b) => a[0] - b[0]);
}

export async function loadRecentCultureEvidence(
  ctx: Context,
  groupId: string,
  since = Date.now() - CULTURE_EVIDENCE_RECENT_WINDOW_MS,
): Promise<CultureEvidenceRow[]> {
  const evidence = (await ctx.database.get("mio.culture_evidence", {
    groupId,
  })) as CultureEvidenceRow[];

  return evidence
    .filter(
      (row) =>
        row.groupId === groupId &&
        row.status === "active" &&
        getCultureActivityAt(row) >= since,
    )
    .sort((a, b) => {
      const aAt = getCultureActivityAt(a);
      const bAt = getCultureActivityAt(b);
      if (aAt !== bAt) return aAt - bAt;
      return a.id - b.id;
    });
}

export async function collectGroupCultureCandidateGroupIds(
  ctx: Context,
): Promise<string[]> {
  const [relational, episodic, semantic, cultureEvidence] = await Promise.all([
    ctx.database.get("mio.relational", {}),
    ctx.database.get("mio.episodic", {}),
    ctx.database.get("mio.semantic", { subject: "group" }),
    ctx.database.get("mio.culture_evidence", {}),
  ]);

  const groupIds = new Set<string>();
  const recentCutoff = Date.now() - CULTURE_CANDIDATE_RECENT_WINDOW_MS;

  for (const row of relational as MioRelationalRow[]) {
    if (row.groupId && row.lastInteraction >= recentCutoff) groupIds.add(row.groupId);
  }
  for (const row of episodic as MioEpisodicRow[]) {
    if (row.groupId && !row.archived && row.eventTime >= recentCutoff) groupIds.add(row.groupId);
  }
  for (const row of semantic as MioSemanticRow[]) {
    if (
      row.groupId &&
      row.subject === "group" &&
      isActiveSemanticFact(row) &&
      row.lastConfirmed >= recentCutoff
    ) {
      groupIds.add(row.groupId);
    }
  }
  for (const row of cultureEvidence as CultureEvidenceRow[]) {
    if (
      row.groupId &&
      row.status === "active" &&
      getCultureActivityAt(row) >= recentCutoff
    ) {
      groupIds.add(row.groupId);
    }
  }

  return [...groupIds].sort((a, b) => a.localeCompare(b));
}

export function bucketCultureEvidenceByKind(
  rows: CultureEvidenceRow[],
): CultureEvidenceBucketMap {
  return rows.reduce<CultureEvidenceBucketMap>(
    (buckets, row) => {
      buckets[row.kind].push(row);
      return buckets;
    },
    {
      group_expression: [],
      reaction_pattern: [],
      tool_knowledge: [],
      inside_joke: [],
    },
  );
}

export function computeCultureEvidenceSupport(
  rows: CultureEvidenceRow[],
  now = inferSupportNow(rows),
): CultureEvidenceSupport {
  if (rows.length === 0) {
    return {
      count: 0,
      distinctDays: 0,
      distinctWindows: 0,
      averageConfidence: 0,
      recencyDays: 0,
      effectiveCount: 0,
      score: 0,
    };
  }

  const windowGroups = groupCultureEvidenceByWindow(rows);
  const windowRepresentatives = windowGroups.map((window) => window.representative);
  const count = windowGroups.length;
  const distinctWindows = windowGroups.length;
  const distinctDays = new Set(
    windowRepresentatives.map((row) => getCultureDayKey(getCultureActivityAt(row))),
  ).size;
  const averageConfidence =
    windowRepresentatives.reduce((sum, row) => sum + row.confidence, 0) /
    windowRepresentatives.length;
  const latestActivity = windowRepresentatives.reduce(
    (latest, row) => Math.max(latest, getCultureActivityAt(row)),
    0,
  );
  const recencyDays = Math.max(0, (now - latestActivity) / CULTURE_EVIDENCE_DAY_MS);
  const effectiveCount = count;
  const recencyScore = 1 / (1 + recencyDays);
  const score =
    effectiveCount +
    distinctDays * 0.5 +
    distinctWindows * 0.25 +
    averageConfidence +
    recencyScore;

  return {
    count,
    distinctDays,
    distinctWindows,
    averageConfidence,
    recencyDays,
    effectiveCount,
    score,
  };
}

export function clusterCultureEvidenceBySimilarity(
  rows: CultureEvidenceRow[],
  similarityThreshold = CULTURE_EVIDENCE_CLUSTER_SIMILARITY,
  now = inferSupportNow(rows),
): CultureEvidenceCluster[] {
  const clusters: CultureEvidenceCluster[] = [];

  for (const kind of CULTURE_EVIDENCE_KINDS) {
    const kindRows = rows.filter((row) => row.kind === kind);
    if (kindRows.length === 0) continue;

    const windowGroups = filterValidCultureEvidenceWindows(groupCultureEvidenceByWindow(kindRows));
    if (windowGroups.length === 0) continue;

    const adjacency = buildCultureEvidenceAdjacency(windowGroups, similarityThreshold);
    const components = collectConnectedComponents(adjacency);

    for (const component of components) {
      const componentWindows = component.map((index) => windowGroups[index]);
      const evidence = componentWindows
        .flatMap((window) => window.rows)
        .sort((a, b) => {
          const aAt = getCultureActivityAt(a);
          const bAt = getCultureActivityAt(b);
          if (aAt !== bAt) return aAt - bAt;
          if (a.sourceWindowKey !== b.sourceWindowKey) {
            return a.sourceWindowKey.localeCompare(b.sourceWindowKey);
          }
          return a.id - b.id;
        });

      const representativeEmbeddings = componentWindows.map((window) => window.representative.embedding);
      const centroidDimension = getEmbeddingDimension(representativeEmbeddings[0]) ?? 0;
      const centroid = centroidDimension > 0
        ? averageEmbedding(representativeEmbeddings, centroidDimension)
        : [];

      clusters.push({
        kind,
        evidence,
        centroid,
        support: computeCultureEvidenceSupport(evidence, now),
      });
    }
  }

  return sortCultureClusters(clusters);
}

function buildGroupCultureClusterSummaries(
  clusters: CultureEvidenceCluster[],
  limit = CULTURE_EVIDENCE_PROMOTABLE_CLUSTER_LIMIT,
): GroupCultureClusterSummary[] {
  return clusters
    .filter(
      (cluster) =>
        cluster.support.distinctWindows >= CULTURE_EVIDENCE_PROMOTION_MIN_WINDOWS,
    )
    .sort((a, b) => {
      if (b.support.score !== a.support.score) return b.support.score - a.support.score;
      if (b.support.distinctWindows !== a.support.distinctWindows) {
        return b.support.distinctWindows - a.support.distinctWindows;
      }
      return b.support.count - a.support.count;
    })
    .slice(0, limit)
    .map((cluster, index) => ({
      clusterIndex: index,
      clusterId: `${cluster.kind}:${index}`,
      kind: cluster.kind,
      support: cluster.support,
      representative: cluster.evidence.length > 0 ? cluster.evidence[0].content : "",
      evidenceLines: cluster.evidence
        .slice(0, 6)
        .map((row) => formatCultureEvidenceSummary(row)),
      evidence: cluster.evidence,
    }));
}

function parseGroupCultureCanonicalizationResult(
  content: string,
): GroupCultureCanonicalizationPromptResult | null {
  const raw = parseJSON(content);
  if (!isPlainObject(raw)) return null;

  const promotedFacts: GroupCultureCanonicalizationPromptResult["promoted_facts"] = [];
  for (const item of Array.isArray(raw.promoted_facts) ? raw.promoted_facts : []) {
    if (!isPlainObject(item)) continue;
    const clusterIndex = readFiniteNumber(item.cluster_index);
    const contentText = readString(item.content);
    if (clusterIndex === null || contentText === null) continue;

    const trimmed = contentText.trim();
    if (!trimmed) continue;

    const confidence = readFiniteNumber(item.confidence);
    promotedFacts.push({
      cluster_index: clusterIndex,
      fact_type: readString(item.fact_type),
      content: trimmed,
      confidence: confidence === null ? undefined : clampConfidence(confidence),
    });
  }

  const mergedFacts: GroupCultureCanonicalizationPromptResult["merged_facts"] = [];
  for (const item of Array.isArray(raw.merged_facts) ? raw.merged_facts : []) {
    if (!isPlainObject(item)) continue;
    const id = readFiniteNumber(item.id);
    const contentText = readString(item.new_content);
    if (id === null || contentText === null) continue;

    const trimmed = contentText.trim();
    if (!trimmed) continue;

    const confidence = readFiniteNumber(item.new_confidence);
    mergedFacts.push({
      id,
      new_content: trimmed,
      new_confidence: confidence === null ? undefined : clampConfidence(confidence),
    });
  }

  const confirmedFacts: GroupCultureCanonicalizationPromptResult["confirmed_facts"] = [];
  for (const item of Array.isArray(raw.confirmed_facts) ? raw.confirmed_facts : []) {
    if (!isPlainObject(item)) continue;
    const id = readFiniteNumber(item.id);
    if (id === null) continue;
    const confidence = readFiniteNumber(item.new_confidence);
    confirmedFacts.push({
      id,
      new_confidence: confidence === null ? undefined : clampConfidence(confidence),
    });
  }

  const decayedFacts: GroupCultureCanonicalizationPromptResult["decayed_facts"] = [];
  for (const item of Array.isArray(raw.decayed_facts) ? raw.decayed_facts : []) {
    if (!isPlainObject(item)) continue;
    const id = readFiniteNumber(item.id);
    if (id === null) continue;
    const confidence = readFiniteNumber(item.new_confidence);
    decayedFacts.push({
      id,
      new_confidence: confidence === null ? undefined : clampConfidence(confidence),
    });
  }

  return {
    promoted_facts: promotedFacts,
    merged_facts: mergedFacts,
    confirmed_facts: confirmedFacts,
    decayed_facts: decayedFacts,
  };
}

// ===== Main Pipeline =====

export class DistillationPipeline {
  constructor(
    private ctx: Context,
    private llm: LLMClient,
    private config: MemoryConfig,
    private embeddingService?: EmbeddingService,
  ) {}

  /**
   * 执行完整蒸馏流程（每日一次）
   */
  async run(): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    logger.info("开始每日蒸馏...");

    try {
      // 获取所有活跃群（有 relational 记录的群）
      const allRel = await this.ctx.database.get("mio.relational", {});
      const groupIds = [...new Set(allRel.map((r) => r.groupId))];

      for (const groupId of groupIds) {
        await this.runForGroup(groupId);
      }

      const cultureGroupIds = await collectGroupCultureCandidateGroupIds(this.ctx);
      for (const groupId of cultureGroupIds) {
        await this.maintainGroupCulture(groupId);
      }

      // 全局清理
      await this.cleanup();

      logger.info("每日蒸馏完成");
    } catch (err) {
      logger.error("蒸馏失败:", err);
    }
  }

  private async runForGroup(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    logger.info(`[${groupId}] 开始蒸馏...`);

    // Step 0: 补充缺失的 embeddings（历史数据修复）
    await this.backfillEmbeddings(groupId);

    // Step 1: Semantic Facts 维护
    await this.maintainSemanticFacts(groupId);

    // Step 2 & 3: Impression 更新
    const relations = await this.ctx.database.get("mio.relational", {
      groupId,
    });
    const sevenDaysAgo = Date.now() - 7 * 86400_000;

    for (const rel of relations) {
      // 只处理近 7 天有互动的用户
      if (rel.lastInteraction < sevenDaysAgo) continue;

      await this.updateRecentImpression(groupId, rel);
      await this.updateCoreImpression(groupId, rel);
    }

    logger.info(`[${groupId}] 蒸馏完成`);
  }

  async maintainGroupCulture(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const [recentEvidence, existingFactsRaw] = await Promise.all([
      loadRecentCultureEvidence(this.ctx, groupId),
      this.ctx.database.get("mio.semantic", {
        groupId,
        subject: "group",
      }),
    ]);

    const existingFacts = (existingFactsRaw as MioSemanticRow[]).filter(isActiveSemanticFact);
    if (recentEvidence.length === 0 && existingFacts.length === 0) {
      logger.debug(`[${groupId}] 无群文化证据，跳过`);
      return;
    }

    const clusters = clusterCultureEvidenceBySimilarity(recentEvidence);
    const clusterSummaries = buildGroupCultureClusterSummaries(clusters);
    const prompt = promptManager.get("group_culture_canonicalize", {
      existingFacts: formatFacts(existingFacts.slice().sort((a, b) => b.confidence - a.confidence).slice(0, CULTURE_EVIDENCE_ACTIVE_FACT_LIMIT)),
      clusters: formatGroupCultureClusters(clusterSummaries),
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请归纳群文化并更新群文化事实。" },
      ],
      this.config.distillation,
      {
        temperature: 0.25,
        maxTokens: 2048,
        responseFormat: "json_object",
        purpose: "memory-distillation-group-culture",
      },
    );

    const result = parseGroupCultureCanonicalizationResult(response.content);
    if (!result) {
      logger.warn(`[${groupId}] 群文化 canonicalization LLM 输出解析失败`);
      logger.debug(response.content);
      return;
    }

    const now = Date.now();
    const activeFacts = [...existingFacts];
    const activeFactsById = new Map<number, MioSemanticRow>();
    for (const fact of activeFacts) {
      activeFactsById.set(fact.id, fact);
    }

    let promoted = 0;
    let merged = 0;
    let confirmed = 0;
    let decayed = 0;
    let suppressed = 0;
    const pendingPatches = new Map<number, GroupCultureFactPatchState>();

    const findSimilarFact = (factType: MioSemanticRow["factType"], embedding: number[]) => {
      if (!this.embeddingService || embedding.length === 0) return null;
      return activeFacts.find(
        (fact) =>
          fact.subject === "group" &&
          fact.factType === factType &&
          fact.embedding &&
          fact.embedding.length === embedding.length &&
          cosineSimilarity(embedding, fact.embedding) >= 0.9,
      ) || null;
    };

    const embedContent = async (content: string): Promise<number[]> => {
      if (!this.embeddingService || !content.trim()) return [];
      try {
        return await this.embeddingService.embed(content);
      } catch (err) {
        logger.warn(`[${groupId}] 群文化 embedding 失败:`, err);
        return [];
      }
    };

    const queuePatch = (
      factId: number,
      kind: "merged" | "confirmed" | "decayed",
      patch: Partial<MioSemanticRow>,
    ): void => {
      const state = pendingPatches.get(factId) || {};
      state[kind] = { ...state[kind], ...patch };
      pendingPatches.set(factId, state);

      const existing = activeFactsById.get(factId);
      if (existing) {
        Object.assign(existing, patch);
      }
    };

    const resolvePatch = (state: GroupCultureFactPatchState): Partial<MioSemanticRow> | null => {
      if (state.merged) return { ...state.merged };
      if (state.confirmed) return { ...state.confirmed };
      if (state.decayed) return { ...state.decayed };
      return null;
    };

    for (const item of result.promoted_facts || []) {
      const cluster = clusterSummaries[item.cluster_index];
      if (!cluster) continue;

      const factType = normalizeGroupFactType(item.fact_type, cluster.kind);
      const content = item.content.slice(0, 80);
      if (!content) continue;

      const embedding = await embedContent(content);
      const similar = findSimilarFact(factType, embedding);
      const confidence = clampConfidence(item.confidence ?? cluster.support.averageConfidence);

      if (similar) {
        const patch: Partial<MioSemanticRow> = {
          confidence: Math.max(similar.confidence, confidence),
          lastConfirmed: now,
        };
        if (similar.content !== content) {
          patch.content = content;
        }
        if (embedding.length > 0) {
          patch.embedding = embedding;
        }
        queuePatch(similar.id, "merged", patch);
        merged++;
        continue;
      }

      const sourceEpisodes = Array.from(
        new Set(
          cluster.evidence
            .map((row) => row.sourceEpisodeId)
            .filter((value): value is number => typeof value === "number"),
        ),
      );

      const created = await this.ctx.database.create("mio.semantic", {
        groupId,
        subject: "group",
        factType,
        content,
        embedding,
        confidence,
        sourceEpisodes,
        firstObserved: now,
        lastConfirmed: now,
        supersededBy: null,
        createdAt: now,
      });

      activeFacts.push(created);
      activeFactsById.set(created.id, created);
      promoted++;
    }

    for (const item of result.merged_facts || []) {
      const existing = activeFactsById.get(item.id);
      if (!existing) continue;

      const newContent = item.new_content.slice(0, 80);
      const embedding = await embedContent(newContent);
      const patch: Partial<MioSemanticRow> = {
        content: newContent || existing.content,
        confidence: clampConfidence(item.new_confidence ?? existing.confidence),
        lastConfirmed: now,
      };
      if (embedding.length > 0) {
        patch.embedding = embedding;
      }
      queuePatch(existing.id, "merged", patch);
      merged++;
    }

    for (const item of result.confirmed_facts || []) {
      const existing = activeFactsById.get(item.id);
      if (!existing) continue;

      queuePatch(existing.id, "confirmed", {
        confidence: clampConfidence(item.new_confidence ?? existing.confidence),
        lastConfirmed: now,
      });
      confirmed++;
    }

    for (const item of result.decayed_facts || []) {
      const existing = activeFactsById.get(item.id);
      if (!existing) continue;

      queuePatch(existing.id, "decayed", {
        confidence: clampConfidence(item.new_confidence ?? existing.confidence),
      });
      decayed++;
    }

    const cleanupCandidates = [...activeFacts]
      .filter(
        (fact) =>
          fact.subject === "group" &&
          isGroupFactType(fact.factType) &&
          isActiveSemanticFact(fact),
      )
      .sort((a, b) => {
        const priorityDelta = computeGroupFactPriority(b) - computeGroupFactPriority(a);
        if (priorityDelta !== 0) return priorityDelta;
        if (b.lastConfirmed !== a.lastConfirmed) return b.lastConfirmed - a.lastConfirmed;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return a.id - b.id;
      });

    for (let i = 0; i < cleanupCandidates.length; i++) {
      const winner = cleanupCandidates[i];
      if (!isActiveSemanticFact(winner)) continue;

      for (let j = i + 1; j < cleanupCandidates.length; j++) {
        const candidate = cleanupCandidates[j];
        if (!isActiveSemanticFact(candidate)) continue;
        if (!areLegacyGroupFactsNearDuplicate(winner, candidate)) continue;

        queuePatch(candidate.id, "merged", {
          supersededBy: winner.id,
        });
        suppressed++;
      }
    }

    for (const [factId, state] of pendingPatches) {
      const patch = resolvePatch(state);
      if (!patch) continue;
      const conflictKinds = [
        state.merged ? "merged" : null,
        state.confirmed ? "confirmed" : null,
        state.decayed ? "decayed" : null,
      ].filter((value): value is string => value !== null);
      if (conflictKinds.length > 1) {
        logger.debug(
          `[${groupId}] 群文化 fact#${factId} 冲突指令: ${conflictKinds.join(" > ")}（按 merged > confirmed > decayed 解析）`,
        );
      }
      await this.ctx.database.set("mio.semantic", { id: factId }, patch);
    }

    logger.info(
      `[${groupId}] 群文化维护: +${promoted} 晋升, ${merged} 合并, ${confirmed} 确认, ${decayed} 衰减, ${suppressed} 清理`,
    );
  }

  /**
   * Step 0: 批量补充缺失的 embeddings（历史数据修复）
   */
  private async backfillEmbeddings(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");

    if (!this.embeddingService) {
      logger.debug(`[${groupId}] 无 embedding service，跳过补充`);
      return;
    }

    const BATCH_SIZE = 100; // 每批处理 100 条

    // 1. 补充 Episodic Memory 的 embeddings
    const episodicWithoutEmbedding = await this.ctx.database.get(
      "mio.episodic",
      { groupId, archived: false },
    );
    const episodicToFix = episodicWithoutEmbedding.filter(
      (e) => !e.embedding || e.embedding.length === 0,
    );

    if (episodicToFix.length > 0) {
      logger.info(
        `[${groupId}] 补充 ${episodicToFix.length} 条 episodic embeddings...`,
      );

      // 分批处理
      for (let i = 0; i < episodicToFix.length; i += BATCH_SIZE) {
        const batch = episodicToFix.slice(i, i + BATCH_SIZE);
        try {
          const texts = batch.map((e) => e.summary);
          const embeddings = await this.embeddingService.embedBatch(texts);

          // 批量更新
          for (let j = 0; j < batch.length; j++) {
            await this.ctx.database.set(
              "mio.episodic",
              { id: batch[j].id },
              { embedding: embeddings[j] },
            );
          }
        } catch (err) {
          logger.warn(
            `补充 episodic batch ${i}-${i + batch.length} 失败:`,
            err,
          );
        }
      }
      logger.info(`[${groupId}] Episodic embeddings 补充完成`);
    }

    // 2. 补充 Semantic Facts 的 embeddings
    const semanticWithoutEmbedding = await this.ctx.database.get(
      "mio.semantic",
      { groupId },
    );
    const semanticToFix = semanticWithoutEmbedding.filter(
      (f) =>
        (!f.embedding || f.embedding.length === 0) &&
        (f.supersededBy === null || f.supersededBy === undefined),
    );

    if (semanticToFix.length > 0) {
      logger.info(
        `[${groupId}] 补充 ${semanticToFix.length} 条 semantic embeddings...`,
      );

      for (let i = 0; i < semanticToFix.length; i += BATCH_SIZE) {
        const batch = semanticToFix.slice(i, i + BATCH_SIZE);
        try {
          const texts = batch.map((f) => f.content);
          const embeddings = await this.embeddingService.embedBatch(texts);

          for (let j = 0; j < batch.length; j++) {
            await this.ctx.database.set(
              "mio.semantic",
              { id: batch[j].id },
              { embedding: embeddings[j] },
            );
          }
        } catch (err) {
          logger.warn(
            `补充 semantic batch ${i}-${i + batch.length} 失败:`,
            err,
          );
        }
      }
      logger.info(`[${groupId}] Semantic embeddings 补充完成`);
    }
  }

  /**
   * Step 1: Semantic Facts 维护（原 distillSemanticFacts）
   * 纯时间窗口，不再用 distilled 过滤
   */
  private async maintainSemanticFacts(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const sevenDaysAgo = Date.now() - 7 * 86400_000;

    // 加载近 7 天的 episodic memories（纯时间窗口）
    const recentEpisodes = (
      await this.ctx.database.get("mio.episodic", {
        groupId,
        archived: false,
      })
    ).filter((e) => e.eventTime >= sevenDaysAgo);

    if (recentEpisodes.length === 0) {
      logger.debug(`[${groupId}] 无近期记忆，跳过语义维护`);
      return;
    }

    // 加载现有 active semantic facts
    const existingFacts = (
      await this.ctx.database.get("mio.semantic", {
        groupId,
      })
    ).filter((f) => f.supersededBy === null || f.supersededBy === undefined);

    // LLM 调用
    const prompt = promptManager.get("semantic_distill", {
      existingFacts: formatFacts(existingFacts),
      recentEpisodes: formatEpisodes(recentEpisodes),
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请分析以上记忆并更新认知。" },
      ],
      this.config.distillation,
      { temperature: 0.5, maxTokens: 8192, responseFormat: "json_object", purpose: "memory-distillation-semantic" },
    );

    const raw = parseJSON(response.content);
    if (!raw) {
      logger.warn(`[${groupId}] 语义维护 LLM 输出解析失败`);
      logger.debug(response.content);
      return;
    }

    // LLM 输出 snake_case，映射到 camelCase
    const result: DistillationResult = {
      newFacts: (raw.new_facts || []).map((f: any) => ({
        subject: f.subject,
        factType: f.fact_type || "trait",
        content: f.content,
        confidence: f.confidence ?? 0.5,
      })),
      confirmedFacts: (raw.confirmed_facts || []).map((f: any) => ({
        id: f.id,
        newConfidence: f.new_confidence ?? 0.5,
      })),
      evolvedFacts: (raw.evolved_facts || []).map((f: any) => ({
        oldFactId: f.old_fact_id,
        newContent: f.new_content,
        newConfidence: f.new_confidence ?? 0.5,
      })),
      decayedFacts: (raw.decayed_facts || []).map((f: any) => ({
        id: f.id,
        newConfidence: f.new_confidence ?? 0.2,
      })),
    };

    const now = Date.now();
    const episodeIds = recentEpisodes.map((e) => e.id);

    // 处理 new_facts（添加 embedding 去重）
    for (const fact of result.newFacts || []) {
      // 生成 embedding
      let embedding: number[] = [];
      if (this.embeddingService) {
        try {
          embedding = await this.embeddingService.embed(fact.content);
        } catch (err) {
          logger.warn("生成 fact embedding 失败:", err);
        }
      }

      // 检查是否与现有 facts 相似（阈值 0.9）
      if (embedding.length > 0) {
        const similar = existingFacts.find(
          (f) =>
            f.subject === fact.subject &&
            f.factType === fact.factType &&
            f.embedding &&
            f.embedding.length > 0 &&
            cosineSimilarity(embedding, f.embedding) >= 0.9,
        );

        if (similar) {
          // 相似 fact 已存在，提升 confidence 而不是创建新条目
          const newConfidence = Math.min(1.0, similar.confidence + 0.1);
          await this.ctx.database.set(
            "mio.semantic",
            { id: similar.id },
            {
              confidence: newConfidence,
              lastConfirmed: now,
            },
          );
          logger.debug(
            `合并相似 fact [${similar.id}]: ${fact.content.slice(0, 30)}...`,
          );
          continue;
        }
      }

      // 创建新 fact
      await this.ctx.database.create("mio.semantic", {
        groupId,
        subject: fact.subject,
        factType: fact.factType || "trait",
        content: fact.content,
        embedding,
        confidence: Math.max(0, Math.min(1, fact.confidence)),
        sourceEpisodes: episodeIds,
        firstObserved: now,
        lastConfirmed: now,
        supersededBy: null,
        createdAt: now,
      });
    }

    // 处理 confirmed_facts
    for (const cf of result.confirmedFacts || []) {
      const existing = existingFacts.find((f) => f.id === cf.id);
      if (existing) {
        await this.ctx.database.set(
          "mio.semantic",
          { id: cf.id },
          {
            confidence: Math.max(0, Math.min(1, cf.newConfidence)),
            lastConfirmed: now,
          },
        );
      }
    }

    // 处理 evolved_facts（时间线叙事）
    for (const ef of result.evolvedFacts || []) {
      const oldFact = existingFacts.find((f) => f.id === ef.oldFactId);
      if (!oldFact) continue;

      // 生成新 fact 的 embedding
      let embedding: number[] = [];
      if (this.embeddingService) {
        try {
          embedding = await this.embeddingService.embed(ef.newContent);
        } catch (err) {
          logger.warn("生成 evolved fact embedding 失败:", err);
        }
      }

      // 创建新 fact
      const newFact = await this.ctx.database.create("mio.semantic", {
        groupId,
        subject: oldFact.subject,
        factType: oldFact.factType,
        content: ef.newContent,
        embedding,
        confidence: Math.max(0, Math.min(1, ef.newConfidence)),
        sourceEpisodes: [...oldFact.sourceEpisodes, ...episodeIds],
        firstObserved: oldFact.firstObserved,
        lastConfirmed: now,
        supersededBy: null,
        createdAt: now,
      });

      // 旧 fact 标记为被取代
      await this.ctx.database.set(
        "mio.semantic",
        { id: ef.oldFactId },
        {
          supersededBy: newFact.id,
        },
      );
    }

    // 处理 decayed_facts
    for (const df of result.decayedFacts || []) {
      const existing = existingFacts.find((f) => f.id === df.id);
      if (existing) {
        await this.ctx.database.set(
          "mio.semantic",
          { id: df.id },
          {
            confidence: Math.max(0, Math.min(1, df.newConfidence)),
          },
        );
      }
    }

    const counts = {
      new: result.newFacts?.length || 0,
      confirmed: result.confirmedFacts?.length || 0,
      evolved: result.evolvedFacts?.length || 0,
      decayed: result.decayedFacts?.length || 0,
    };
    logger.info(
      `[${groupId}] 语义维护: +${counts.new} 新, ${counts.confirmed} 确认, ${counts.evolved} 演进, ${counts.decayed} 衰减`,
    );
  }

  /**
   * Step 2: Recent Impression 重写
   * 输入源：该用户近 7 天的 active semantic facts
   */
  private async updateRecentImpression(groupId: string, rel: MioRelationalRow): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const sevenDaysAgo = Date.now() - 7 * 86400_000;

    // 加载该用户近 7 天的 active semantic facts
    const allFacts = await this.ctx.database.get("mio.semantic", {
      groupId,
      subject: rel.userId,
    });
    const recentFacts = allFacts.filter(
      (f) =>
        (f.supersededBy === null || f.supersededBy === undefined) &&
        f.lastConfirmed >= sevenDaysAgo,
    );

    if (recentFacts.length === 0) return;

    const prompt = promptManager.get("recent_impression", {
      displayName: rel.displayName,
      recentFacts: formatFacts(recentFacts),
      coreImpression: rel.coreImpression || "（暂无）",
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请生成近期印象补充。" },
      ],
      this.config.distillation,
      { temperature: 0.3, maxTokens: 200, responseFormat: "json_object", purpose: "memory-distillation-recent-impression" },
    );

    const result = parseJSON(response.content);
    if (!result) {
      logger.warn(`[${rel.groupId}] ${rel.displayName} 近期印象 LLM 解析失败`);
      return;
    }

    const recentImpression = (result.recent_impression || "").slice(0, 60);

    await this.ctx.database.set(
      "mio.relational",
      { id: rel.id },
      {
        recentImpression,
        recentImpressionUpdatedAt: Date.now(),
      },
    );

    if (recentImpression) {
      logger.debug(
        `[${rel.groupId}] ${rel.displayName} 近期印象: ${recentImpression}`,
      );
    }
  }

  /**
   * Step 3: Core Impression 条件更新
   * 输入源：该用户全部 active semantic facts（top 15 by confidence）
   * 触发条件：activeFacts >= 3 && (isNewUser || coreImpressionAge > 30 天)
   */
  private async updateCoreImpression(groupId: string, rel: MioRelationalRow): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");

    // 加载该用户全部 active semantic facts
    const allFacts = await this.ctx.database.get("mio.semantic", {
      groupId,
      subject: rel.userId,
    });
    const activeFacts = allFacts
      .filter((f) => f.supersededBy === null || f.supersededBy === undefined)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 15);

    // 触发条件
    const isNewUser = !rel.coreImpression;
    const coreImpressionAge = (Date.now() - rel.coreImpressionUpdatedAt) / 86400_000;

    if (activeFacts.length < 3) return;
    if (!isNewUser && coreImpressionAge <= 30) return;

    const prompt = promptManager.get("core_impression", {
      displayName: rel.displayName,
      coreImpression: rel.coreImpression || "（暂无，这是新认识的人）",
      facts: formatFacts(activeFacts),
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请判断是否需要更新核心印象。" },
      ],
      this.config.distillation,
      { temperature: 0.3, maxTokens: 200, responseFormat: "json_object", purpose: "memory-distillation-core-impression" },
    );

    const result = parseJSON(response.content);
    if (!result) {
      logger.warn(`[${rel.groupId}] ${rel.displayName} 核心印象 LLM 解析失败`);
      return;
    }

    if (result.unchanged) return;

    const newImpression = (result.new_impression || "").slice(0, 80);
    if (!newImpression) return;

    await this.ctx.database.set(
      "mio.relational",
      { id: rel.id },
      {
        coreImpression: newImpression,
        coreImpressionUpdatedAt: Date.now(),
      },
    );

    logger.info(
      `[${rel.groupId}] ${rel.displayName} 核心印象更新: ${newImpression}`,
    );
  }

  /**
   * 清理：简单时间过期 + 容量驱逐
   */
  private async cleanup(): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const now = Date.now();
    const twentyOneDaysAgo = now - 21 * 86400_000;

    // 1. 简单时间过期：eventTime < 21 天前 → archived
    const activeEpisodic = await this.ctx.database.get("mio.episodic", {
      archived: false,
    });

    let archivedCount = 0;
    for (const ep of activeEpisodic) {
      if (ep.eventTime < twentyOneDaysAgo) {
        await this.ctx.database.set(
          "mio.episodic",
          { id: ep.id },
          { archived: true },
        );
        archivedCount++;
      }
    }

    // 2. 容量驱逐：超过 activePoolLimit 时按时间排序淘汰最早的
    const remaining = activeEpisodic.length - archivedCount;
    if (remaining > this.config.activePoolLimit) {
      const toEvict = remaining - this.config.activePoolLimit;
      // 按 eventTime 排序，淘汰最早的
      const sorted = activeEpisodic
        .filter((ep) => ep.eventTime >= twentyOneDaysAgo) // 只看还没被 archived 的
        .sort((a, b) => a.eventTime - b.eventTime);

      for (let i = 0; i < Math.min(toEvict, sorted.length); i++) {
        await this.ctx.database.set(
          "mio.episodic",
          { id: sorted[i].id },
          { archived: true },
        );
        archivedCount++;
      }
    }

    if (archivedCount > 0) {
      logger.info(`清理: archived ${archivedCount} 条 episodic 记忆`);
    }
  }
}
