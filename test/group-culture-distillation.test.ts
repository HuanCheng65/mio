import test from "node:test";
import assert from "node:assert/strict";
import { processCulturalObservations } from "../src/memory/culture-learning";
import { ContextAssembler } from "../src/memory/context-assembler";
import {
  DistillationPipeline,
  bucketCultureEvidenceByKind,
  clusterCultureEvidenceBySimilarity,
  computeCultureEvidenceSupport,
  collectGroupCultureCandidateGroupIds,
  loadRecentCultureEvidence,
} from "../src/memory/distillation";
import { extendTables } from "../src/memory/tables";
import { CultureEvidenceRow } from "../src/memory/types";

test("extendTables registers culture evidence schema", () => {
  const extended: Array<[string, any, any?]> = [];
  const ctx = {
    model: {
      extend(name: string, schema: any, options?: any) {
        extended.push([name, schema, options]);
      },
    },
  } as any;

  extendTables(ctx);

  const cultureEvidence = extended.find(([name]) => name === "mio.culture_evidence");
  assert.ok(cultureEvidence, "expected mio.culture_evidence to be registered");

  const [, schema, options] = cultureEvidence;
  assert.deepEqual(Object.keys(schema).sort(), [
    "clusterId",
    "confidence",
    "content",
    "createdAt",
    "embedding",
    "groupId",
    "id",
    "kind",
    "lastSeenAt",
    "observedAt",
    "sourceEpisodeId",
    "sourceWindowKey",
    "status",
  ]);

  assert.deepEqual(schema.id, "unsigned");
  assert.deepEqual(schema.groupId, "string(63)");
  assert.deepEqual(schema.kind, { type: "string", initial: "group_expression" });
  assert.deepEqual(schema.embedding, { type: "json", initial: [] });
  assert.deepEqual(schema.confidence, { type: "float", initial: 0.5 });
  assert.deepEqual(schema.sourceEpisodeId, { type: "unsigned", nullable: true, initial: null });
  assert.deepEqual(schema.sourceWindowKey, { type: "string", initial: "" });
  assert.deepEqual(schema.status, { type: "string", initial: "active" });
  assert.deepEqual(schema.clusterId, { type: "string", nullable: true, initial: null });
  assert.deepEqual(schema.createdAt, "unsigned(8)");
  assert.deepEqual(options, { autoInc: true, primary: "id" });
});

test("processCulturalObservations uses passed sourceWindowKey and merges same-window evidence", async () => {
  const fixedNow = 1713528000000;
  const sourceWindowKey = "group-1:1713528000000-1713528060000:2";
  const existingEvidence = [{
    id: 7,
    groupId: "group-1",
    kind: "inside_joke",
    content: "大家刷问号",
    embedding: [0, 1],
    confidence: 0.4,
    sourceEpisodeId: null,
    sourceWindowKey,
    observedAt: fixedNow,
    lastSeenAt: fixedNow,
    status: "active",
    clusterId: null,
    createdAt: fixedNow,
  }];
  const getCalls: Array<{ table: string; query: any }> = [];
  const created: Array<{ table: string; row: any }> = [];
  const updates: Array<{ table: string; query: any; patch: any }> = [];
  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        getCalls.push({ table, query });
        if (
          table === "mio.culture_evidence" &&
          query.groupId === "group-1" &&
          query.sourceWindowKey === sourceWindowKey
        ) {
          return existingEvidence;
        }
        return [];
      },
      async create(table: string, row: any) {
        created.push({ table, row });
        return { id: created.length, ...row };
      },
      async set(table: string, query: any, patch: any) {
        updates.push({ table, query, patch });
      },
    },
  } as any;

  const embeddingService = {
    async embedBatch(texts: string[]) {
      return texts.map(text => text.includes("问号") ? [0, 1] : [1, 0]);
    },
  } as any;

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const summaries = await processCulturalObservations(
      ctx,
      "group-1",
      [{ type: "meme", content: "大家刷问号", confidence: 0.3 }],
      embeddingService,
      sourceWindowKey,
    );

    const evidenceCreates = created.filter(({ table }) => table === "mio.culture_evidence");
    const semanticCreates = created.filter(({ table }) => table === "mio.semantic");
    const evidenceUpdates = updates.filter(({ table }) => table === "mio.culture_evidence");

    assert.equal(getCalls.length, 1);
    assert.equal(getCalls[0].table, "mio.culture_evidence");
    assert.equal(getCalls[0].query.sourceWindowKey, sourceWindowKey, "expected the passed window key to drive the evidence lookup");
    assert.equal(evidenceCreates.length, 0, "expected merge path to update existing evidence rather than create a new row");
    assert.equal(evidenceUpdates.length, 1, "expected one same-window evidence merge");
    assert.equal(semanticCreates.length, 0, "expected no direct semantic writes");
    assert.equal(evidenceUpdates[0].query.id, 7);
    assert.equal(evidenceUpdates[0].patch.lastSeenAt, fixedNow);
    assert.equal(summaries.length, 1);
    assert.ok(summaries[0].includes("大家刷问号"));
  } finally {
    Date.now = originalNow;
  }
});

test("loadRecentCultureEvidence returns only recent active evidence", async () => {
  const fixedNow = 1713528000000;
  const recentRow: CultureEvidenceRow = {
    id: 1,
    groupId: "group-1",
    kind: "reaction_pattern",
    content: "大家会刷问号",
    embedding: [1, 0],
    confidence: 0.8,
    sourceEpisodeId: null,
    sourceWindowKey: "group-1:recent",
    observedAt: fixedNow - 60_000,
    lastSeenAt: fixedNow - 60_000,
    status: "active",
    clusterId: null,
    createdAt: fixedNow - 60_000,
  };
  const staleRow: CultureEvidenceRow = {
    ...recentRow,
    id: 2,
    sourceWindowKey: "group-1:stale",
    observedAt: fixedNow - 40 * 86400_000,
    lastSeenAt: fixedNow - 40 * 86400_000,
  };
  const ignoredRow: CultureEvidenceRow = {
    ...recentRow,
    id: 3,
    status: "ignored",
    sourceWindowKey: "group-1:ignored",
  };

  const queries: Array<{ table: string; query: any }> = [];
  const ctx = {
    database: {
      async get(table: string, query: any) {
        queries.push({ table, query });
        if (table === "mio.culture_evidence") {
          return [recentRow, staleRow, ignoredRow];
        }
        return [];
      },
    },
  } as any;

  const rows = await loadRecentCultureEvidence(ctx, "group-1", fixedNow - 7 * 86400_000);

  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, "mio.culture_evidence");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
});

test("same sourceWindowKey collapses support before scoring", () => {
  const fixedNow = 1713528000000;
  const single: CultureEvidenceRow = {
    id: 1,
    groupId: "group-1",
    kind: "reaction_pattern",
    content: "看到厉害的东西会刷？！强强！？",
    embedding: [1, 0],
    confidence: 0.7,
    sourceEpisodeId: null,
    sourceWindowKey: "group-1:window-a",
    observedAt: fixedNow - 10_000,
    lastSeenAt: fixedNow - 10_000,
    status: "active",
    clusterId: null,
    createdAt: fixedNow - 10_000,
  };
  const duplicate: CultureEvidenceRow = {
    ...single,
    id: 2,
  };

  const singleSupport = computeCultureEvidenceSupport([single], fixedNow);
  const duplicateSupport = computeCultureEvidenceSupport([single, duplicate], fixedNow);

  assert.deepEqual(duplicateSupport, singleSupport);
});

test("same-kind evidence clusters by connected support instead of centroid path", () => {
  const evidence: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-1",
      kind: "tool_knowledge",
      content: "A",
      embedding: [1, 0],
      confidence: 0.8,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w1",
      observedAt: 1713527000000,
      lastSeenAt: 1713527000000,
      status: "active",
      clusterId: null,
      createdAt: 1713527000000,
    },
    {
      id: 2,
      groupId: "group-1",
      kind: "tool_knowledge",
      content: "B",
      embedding: [0.7, 0.7],
      confidence: 0.75,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w2",
      observedAt: 1713527060000,
      lastSeenAt: 1713527060000,
      status: "active",
      clusterId: null,
      createdAt: 1713527060000,
    },
    {
      id: 3,
      groupId: "group-1",
      kind: "tool_knowledge",
      content: "C",
      embedding: [0, 1],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w3",
      observedAt: 1713527120000,
      lastSeenAt: 1713527120000,
      status: "active",
      clusterId: null,
      createdAt: 1713527120000,
    },
  ];

  const clusters = clusterCultureEvidenceBySimilarity(evidence, 0.7);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].evidence.length, 3);
  assert.equal(clusters[0].kind, "tool_knowledge");
});

test("different kinds do not cluster together", () => {
  const evidence: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "看到离谱内容大家会刷问号",
      embedding: [1, 0],
      confidence: 0.8,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w1",
      observedAt: 1713527000000,
      lastSeenAt: 1713527000000,
      status: "active",
      clusterId: null,
      createdAt: 1713527000000,
    },
    {
      id: 2,
      groupId: "group-1",
      kind: "inside_joke",
      content: "群里有个摩诃梗",
      embedding: [1, 0],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w2",
      observedAt: 1713527060000,
      lastSeenAt: 1713527060000,
      status: "active",
      clusterId: null,
      createdAt: 1713527060000,
    },
  ];

  const buckets = bucketCultureEvidenceByKind(evidence);
  const clusters = clusterCultureEvidenceBySimilarity(evidence);

  assert.equal(buckets.reaction_pattern.length, 1);
  assert.equal(buckets.inside_joke.length, 1);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((cluster) => cluster.kind).sort(), ["inside_joke", "reaction_pattern"]);
});

test("invalid embedding dimensions are skipped instead of poisoning clustering", () => {
  const evidence: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "看到离谱内容大家会刷问号",
      embedding: [1, 0],
      confidence: 0.8,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w1",
      observedAt: 1713527000000,
      lastSeenAt: 1713527000000,
      status: "active",
      clusterId: null,
      createdAt: 1713527000000,
    },
    {
      id: 2,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "坏维度向量",
      embedding: [0],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w2",
      observedAt: 1713527060000,
      lastSeenAt: 1713527060000,
      status: "active",
      clusterId: null,
      createdAt: 1713527060000,
    },
    {
      id: 3,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "看到离谱内容大家会刷问号",
      embedding: [0.99, 0.01],
      confidence: 0.75,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w2",
      observedAt: 1713527120000,
      lastSeenAt: 1713527120000,
      status: "active",
      clusterId: null,
      createdAt: 1713527120000,
    },
  ];

  const clusters = clusterCultureEvidenceBySimilarity(evidence);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].evidence.length, 2);
  assert.deepEqual(clusters[0].evidence.map((row) => row.id), [1, 3]);
});

test("window clustering keeps the dominant valid embedding dimension", () => {
  const evidence: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "看到离谱内容大家会刷问号",
      embedding: [1, 0],
      confidence: 0.75,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w1",
      observedAt: 1713527000000,
      lastSeenAt: 1713527000000,
      status: "active",
      clusterId: null,
      createdAt: 1713527000000,
    },
    {
      id: 2,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "坏维度但更新时间更近",
      embedding: [0],
      confidence: 0.9,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w1",
      observedAt: 1713527060000,
      lastSeenAt: 1713527060000,
      status: "active",
      clusterId: null,
      createdAt: 1713527060000,
    },
    {
      id: 3,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "大家会刷问号",
      embedding: [0.99, 0.01],
      confidence: 0.8,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w2",
      observedAt: 1713527120000,
      lastSeenAt: 1713527120000,
      status: "active",
      clusterId: null,
      createdAt: 1713527120000,
    },
  ];

  const clusters = clusterCultureEvidenceBySimilarity(evidence);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].evidence.length, 2);
  assert.deepEqual(clusters[0].evidence.map((row) => row.id), [1, 3]);
});

test("collectGroupCultureCandidateGroupIds unions relational, episodic, semantic, and evidence sources", async () => {
  const fixedNow = 1713528000000;
  const queries: Array<{ table: string; query: any }> = [];
  const ctx = {
    database: {
      async get(table: string, query: any) {
        queries.push({ table, query });
        if (table === "mio.relational") {
          return [{ groupId: "group-rel", lastInteraction: fixedNow - 60_000 }];
        }
        if (table === "mio.episodic") {
          return [
            { groupId: "group-ep", archived: false, eventTime: fixedNow - 120_000 },
            { groupId: "group-rel", archived: false, eventTime: fixedNow - 120_000 },
          ];
        }
        if (table === "mio.semantic") {
          return [
            {
              groupId: "group-sem",
              subject: "group",
              supersededBy: null,
              lastConfirmed: fixedNow - 120_000,
            },
          ];
        }
        if (table === "mio.culture_evidence") {
          return [
            {
              groupId: "group-evidence",
              status: "active",
              observedAt: fixedNow - 120_000,
              lastSeenAt: fixedNow - 120_000,
            },
            {
              groupId: "group-sem",
              status: "active",
              observedAt: fixedNow - 120_000,
              lastSeenAt: fixedNow - 120_000,
            },
          ];
        }
        return [];
      },
    },
  } as any;

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const groupIds = await collectGroupCultureCandidateGroupIds(ctx);

    assert.equal(queries.length, 4);
    assert.deepEqual(groupIds, ["group-ep", "group-evidence", "group-rel", "group-sem"]);
  } finally {
    Date.now = originalNow;
  }
});

test("collectGroupCultureCandidateGroupIds filters out stale groups when recent evidence exists", async () => {
  const fixedNow = 1713528000000;
  const recentCutoff = fixedNow - 30 * 86400_000;
  const queries: Array<{ table: string; query: any }> = [];
  const ctx = {
    database: {
      async get(table: string, query: any) {
        queries.push({ table, query });
        if (table === "mio.relational") {
          return [
            { groupId: "group-fresh", lastInteraction: fixedNow - 60_000 },
            { groupId: "group-stale", lastInteraction: fixedNow - 60 * 86400_000 },
          ];
        }
        if (table === "mio.episodic") {
          return [
            { groupId: "group-fresh", archived: false, eventTime: fixedNow - 3_600_000 },
            { groupId: "group-stale", archived: false, eventTime: fixedNow - 60 * 86400_000 },
          ];
        }
        if (table === "mio.semantic") {
          return [
            {
              groupId: "group-fresh",
              subject: "group",
              supersededBy: null,
              lastConfirmed: fixedNow - 3_600_000,
            },
            {
              groupId: "group-stale",
              subject: "group",
              supersededBy: null,
              lastConfirmed: fixedNow - 60 * 86400_000,
            },
          ];
        }
        if (table === "mio.culture_evidence") {
          return [
            {
              groupId: "group-fresh",
              status: "active",
              observedAt: fixedNow - 3_600_000,
              lastSeenAt: fixedNow - 3_600_000,
            },
            {
              groupId: "group-stale",
              status: "active",
              observedAt: fixedNow - 60 * 86400_000,
              lastSeenAt: fixedNow - 60 * 86400_000,
            },
          ];
        }
        return [];
      },
    },
  } as any;

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const groupIds = await collectGroupCultureCandidateGroupIds(ctx);
    assert.ok(queries.length >= 4);
    assert.deepEqual(groupIds, ["group-fresh"]);
    assert.ok(recentCutoff > 0);
  } finally {
    Date.now = originalNow;
  }
});

test("maintainGroupCulture uses a dedicated prompt and promotes canonical group facts", async () => {
  const fixedNow = 1713528000000;
  const evidenceRows: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "有人发离谱图大家会刷问号",
      embedding: [1, 0],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w1",
      observedAt: fixedNow - 10_000,
      lastSeenAt: fixedNow - 10_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 10_000,
    },
    {
      id: 2,
      groupId: "group-1",
      kind: "reaction_pattern",
      content: "看到夸张内容会刷？？",
      embedding: [0.98, 0.02],
      confidence: 0.65,
      sourceEpisodeId: null,
      sourceWindowKey: "group-1:w2",
      observedAt: fixedNow - 5_000,
      lastSeenAt: fixedNow - 5_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 5_000,
    },
  ];
  const existingGroupFacts = [
    {
      id: 11,
      groupId: "group-1",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里看到离谱内容会刷问号",
      embedding: [0.99, 0.01],
      confidence: 0.45,
      sourceEpisodes: [],
      firstObserved: fixedNow - 20 * 86400_000,
      lastConfirmed: fixedNow - 20 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 20 * 86400_000,
    },
    {
      id: 12,
      groupId: "group-1",
      subject: "group",
      factType: "inside_joke",
      content: "群里有个旧梗",
      embedding: [0, 1],
      confidence: 0.3,
      sourceEpisodes: [],
      firstObserved: fixedNow - 60 * 86400_000,
      lastConfirmed: fixedNow - 60 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 60 * 86400_000,
    },
  ];
  const calls: Array<{ role: string; content: string }> = [];
  const created: Array<{ table: string; row: any }> = [];
  const updates: Array<{ table: string; query: any; patch: any }> = [];
  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        if (table === "mio.culture_evidence" && query.groupId === "group-1") {
          return evidenceRows;
        }
        if (table === "mio.semantic" && query.groupId === "group-1" && query.subject === "group") {
          return existingGroupFacts;
        }
        return [];
      },
      async create(table: string, row: any) {
        created.push({ table, row });
        return { id: created.length + 100, ...row };
      },
      async set(table: string, query: any, patch: any) {
        updates.push({ table, query, patch });
      },
    },
  } as any;
  const llm = {
    async chat(messages: Array<{ role: string; content: string }>, _modelConfig: any, options: any) {
      calls.push({ role: messages[0].role, content: messages[0].content });
      return {
        content: JSON.stringify({
          promoted_facts: [
            {
              cluster_index: 0,
              fact_type: "reaction_pattern",
              content: "群里看到离谱内容会刷问号",
              confidence: 0.78,
            },
          ],
          merged_facts: [],
          confirmed_facts: [{ id: 11, new_confidence: 0.6 }],
          decayed_facts: [{ id: 12, new_confidence: 0.2 }],
        }),
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      };
    },
  } as any;
  const embeddingService = {
    async embed(text: string) {
      if (text.includes("问号")) return [1, 0];
      return [0, 1];
    },
    async embedBatch(texts: string[]) {
      return texts.map((text) => (text.includes("问号") ? [1, 0] : [0, 1]));
    },
  } as any;
  const pipeline = new DistillationPipeline(ctx, llm, {
    enabled: true,
    embedding: {} as any,
    extraction: {} as any,
    distillation: {} as any,
    distillationHour: 3,
    flushIntervalMs: 300000,
    maxPendingWrites: 20,
    activePoolLimit: 200,
  }, embeddingService);

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await pipeline.maintainGroupCulture("group-1");
  } finally {
    Date.now = originalNow;
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].content, /群文化簇归纳/);
  assert.doesNotMatch(calls[0].content, /最近一周的记忆片段/);
  assert.equal(created.length, 0);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map(({ query }) => query.id).sort(), [11, 12]);
  assert.equal(updates.find(({ query }) => query.id === 11)?.patch.confidence, 0.78);
  assert.equal(updates.find(({ query }) => query.id === 11)?.patch.lastConfirmed, fixedNow);
  assert.equal(updates.find(({ query }) => query.id === 12)?.patch.confidence, 0.2);
});

test("maintainGroupCulture ignores malformed canonicalization items and whitelists fact types", async () => {
  const fixedNow = 1713528000000;
  const evidenceRows: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-2",
      kind: "reaction_pattern",
      content: "有人发离谱图大家会刷问号",
      embedding: [1, 0],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-2:w1",
      observedAt: fixedNow - 10_000,
      lastSeenAt: fixedNow - 10_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 10_000,
    },
    {
      id: 2,
      groupId: "group-2",
      kind: "reaction_pattern",
      content: "看到夸张内容会刷？？",
      embedding: [0.98, 0.02],
      confidence: 0.65,
      sourceEpisodeId: null,
      sourceWindowKey: "group-2:w2",
      observedAt: fixedNow - 5_000,
      lastSeenAt: fixedNow - 5_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 5_000,
    },
  ];
  const created: Array<{ table: string; row: any }> = [];
  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        if (table === "mio.culture_evidence" && query.groupId === "group-2") {
          return evidenceRows;
        }
        if (table === "mio.semantic" && query.groupId === "group-2" && query.subject === "group") {
          return [];
        }
        return [];
      },
      async create(table: string, row: any) {
        created.push({ table, row });
        return { id: 101, ...row };
      },
      async set() {},
    },
  } as any;
  const llm = {
    async chat() {
      return {
        content: JSON.stringify({
          promoted_facts: [
            {
              cluster_index: 0,
              fact_type: "not_a_real_fact_type",
              content: "群里看到离谱内容会刷问号",
              confidence: 0.78,
            },
            {
              cluster_index: "bad",
              fact_type: "reaction_pattern",
              content: { text: "坏字段" },
              confidence: 0.4,
            },
          ],
          merged_facts: [{ id: "oops", new_content: null }],
          confirmed_facts: [{ id: 1, new_confidence: 0.6 }],
          decayed_facts: [{ id: null, new_confidence: 0.2 }],
        }),
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      };
    },
  } as any;
  const embeddingService = {
    async embed(text: string) {
      return text.includes("问号") ? [1, 0] : [0, 1];
    },
    async embedBatch(texts: string[]) {
      return texts.map((text) => (text.includes("问号") ? [1, 0] : [0, 1]));
    },
  } as any;
  const pipeline = new DistillationPipeline(ctx, llm, {
    enabled: true,
    embedding: {} as any,
    extraction: {} as any,
    distillation: {} as any,
    distillationHour: 3,
    flushIntervalMs: 300000,
    maxPendingWrites: 20,
    activePoolLimit: 200,
  }, embeddingService);

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await pipeline.maintainGroupCulture("group-2");
  } finally {
    Date.now = originalNow;
  }

  assert.equal(created.length, 1);
  assert.equal(created[0].row.factType, "reaction_pattern");
  assert.equal(created[0].row.content, "群里看到离谱内容会刷问号");
});

test("maintainGroupCulture resolves same-id conflicts deterministically", async () => {
  const fixedNow = 1713528000000;
  const evidenceRows: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-3",
      kind: "reaction_pattern",
      content: "有人发离谱图大家会刷问号",
      embedding: [1, 0],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-3:w1",
      observedAt: fixedNow - 10_000,
      lastSeenAt: fixedNow - 10_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 10_000,
    },
    {
      id: 2,
      groupId: "group-3",
      kind: "reaction_pattern",
      content: "看到夸张内容会刷？？",
      embedding: [0.98, 0.02],
      confidence: 0.65,
      sourceEpisodeId: null,
      sourceWindowKey: "group-3:w2",
      observedAt: fixedNow - 5_000,
      lastSeenAt: fixedNow - 5_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 5_000,
    },
  ];
  const existingFacts = [
    {
      id: 11,
      groupId: "group-3",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里看到离谱内容会刷问号",
      embedding: [0.99, 0.01],
      confidence: 0.45,
      sourceEpisodes: [],
      firstObserved: fixedNow - 20 * 86400_000,
      lastConfirmed: fixedNow - 20 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 20 * 86400_000,
    },
  ];
  const updates: Array<{ table: string; query: any; patch: any }> = [];
  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        if (table === "mio.culture_evidence" && query.groupId === "group-3") {
          return evidenceRows;
        }
        if (table === "mio.semantic" && query.groupId === "group-3" && query.subject === "group") {
          return existingFacts;
        }
        return [];
      },
      async create() {
        throw new Error("expected merge path, not create");
      },
      async set(table: string, query: any, patch: any) {
        updates.push({ table, query, patch });
      },
    },
  } as any;
  const llm = {
    async chat() {
      return {
        content: JSON.stringify({
          promoted_facts: [],
          merged_facts: [
            { id: 11, new_content: "群里会刷问号", new_confidence: 0.8 },
          ],
          confirmed_facts: [{ id: 11, new_confidence: 0.6 }],
          decayed_facts: [{ id: 11, new_confidence: 0.1 }],
        }),
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      };
    },
  } as any;
  const embeddingService = {
    async embed(text: string) {
      return text.includes("问号") ? [1, 0] : [0, 1];
    },
    async embedBatch(texts: string[]) {
      return texts.map((text) => (text.includes("问号") ? [1, 0] : [0, 1]));
    },
  } as any;
  const pipeline = new DistillationPipeline(ctx, llm, {
    enabled: true,
    embedding: {} as any,
    extraction: {} as any,
    distillation: {} as any,
    distillationHour: 3,
    flushIntervalMs: 300000,
    maxPendingWrites: 20,
    activePoolLimit: 200,
  }, embeddingService);

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await pipeline.maintainGroupCulture("group-3");
  } finally {
    Date.now = originalNow;
  }

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].query, { id: 11 });
  assert.equal(updates[0].patch.content, "群里会刷问号");
  assert.equal(updates[0].patch.confidence, 0.8);
  assert.equal(updates[0].patch.lastConfirmed, fixedNow);
});

test("maintainGroupCulture suppresses legacy duplicate canonical group facts", async () => {
  const fixedNow = 1713528000000;
  const updates: Array<{ table: string; query: any; patch: any }> = [];
  const existingFacts = [
    {
      id: 21,
      groupId: "group-legacy",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里看到离谱内容会刷问号",
      embedding: [1, 0],
      confidence: 0.78,
      sourceEpisodes: [],
      firstObserved: fixedNow - 30 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 30 * 86400_000,
    },
    {
      id: 22,
      groupId: "group-legacy",
      subject: "group",
      factType: "reaction_pattern",
      content: "大家看到离谱东西会刷问号",
      embedding: [0.99, 0.01],
      confidence: 0.55,
      sourceEpisodes: [],
      firstObserved: fixedNow - 60 * 86400_000,
      lastConfirmed: fixedNow - 20 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 60 * 86400_000,
    },
    {
      id: 23,
      groupId: "group-legacy",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里有人发逆天发言会刷草",
      embedding: [0.4, 0.6],
      confidence: 0.6,
      sourceEpisodes: [],
      firstObserved: fixedNow - 20 * 86400_000,
      lastConfirmed: fixedNow - 2 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 20 * 86400_000,
    },
  ];
  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        if (table === "mio.culture_evidence" && query.groupId === "group-legacy") {
          return [];
        }
        if (table === "mio.semantic" && query.groupId === "group-legacy" && query.subject === "group") {
          return existingFacts;
        }
        return [];
      },
      async create() {
        throw new Error("expected legacy cleanup, not create");
      },
      async set(table: string, query: any, patch: any) {
        updates.push({ table, query, patch });
      },
    },
  } as any;
  const llm = {
    async chat() {
      return {
        content: JSON.stringify({
          promoted_facts: [],
          merged_facts: [],
          confirmed_facts: [],
          decayed_facts: [],
        }),
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      };
    },
  } as any;
  const pipeline = new DistillationPipeline(ctx, llm, {
    enabled: true,
    embedding: {} as any,
    extraction: {} as any,
    distillation: {} as any,
    distillationHour: 3,
    flushIntervalMs: 300000,
    maxPendingWrites: 20,
    activePoolLimit: 200,
  });

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await pipeline.maintainGroupCulture("group-legacy");
  } finally {
    Date.now = originalNow;
  }

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].query, { id: 22 });
  assert.equal(updates[0].patch.supersededBy, 21);
});

test("buildGroupCulture injects canonical facts only with dedup and per-kind caps", async () => {
  const fixedNow = 1713528000000;
  const groupFacts = [
    {
      id: 1,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里看到离谱内容会刷问号",
      embedding: [1, 0],
      confidence: 0.72,
      sourceEpisodes: [],
      firstObserved: fixedNow - 7 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 7 * 86400_000,
    },
    {
      id: 2,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "大家看到离谱东西会刷问号",
      embedding: [0.99, 0.01],
      confidence: 0.72,
      sourceEpisodes: [],
      firstObserved: fixedNow - 60 * 86400_000,
      lastConfirmed: fixedNow - 50 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 60 * 86400_000,
    },
    {
      id: 3,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里看到厉害东西会刷强强！？",
      embedding: [0.95, 0.05],
      confidence: 0.68,
      sourceEpisodes: [],
      firstObserved: fixedNow - 5 * 86400_000,
      lastConfirmed: fixedNow - 2 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 5 * 86400_000,
    },
    {
      id: 4,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里有人接无关的话会刷谁问你了",
      embedding: [0.7, 0.3],
      confidence: 0.65,
      sourceEpisodes: [],
      firstObserved: fixedNow - 4 * 86400_000,
      lastConfirmed: fixedNow - 2 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 4 * 86400_000,
    },
    {
      id: 5,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里有人发逆天发言会刷草",
      embedding: [0.5, 0.5],
      confidence: 0.64,
      sourceEpisodes: [],
      firstObserved: fixedNow - 3 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 3 * 86400_000,
    },
    {
      id: 6,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "群里看到截图会刷卧槽",
      embedding: [0.2, 0.8],
      confidence: 0.63,
      sourceEpisodes: [],
      firstObserved: fixedNow - 2 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 2 * 86400_000,
    },
    {
      id: 7,
      groupId: "group-ctx",
      subject: "group",
      factType: "tool_knowledge",
      content: "群里有个 37 bot，/选 可以帮忙做选择",
      embedding: [0, 1],
      confidence: 0.74,
      sourceEpisodes: [],
      firstObserved: fixedNow - 10 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 10 * 86400_000,
    },
    {
      id: 8,
      groupId: "group-ctx",
      subject: "group",
      factType: "tool_knowledge",
      content: "群里有个保存语录的 bot，发 /上传 加人名就能截图保存",
      embedding: [0.05, 0.95],
      confidence: 0.71,
      sourceEpisodes: [],
      firstObserved: fixedNow - 12 * 86400_000,
      lastConfirmed: fixedNow - 2 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 12 * 86400_000,
    },
    {
      id: 9,
      groupId: "group-ctx",
      subject: "group",
      factType: "tool_knowledge",
      content: "37 bot 还有 /群友列表 可以看语录数量",
      embedding: [0.1, 0.9],
      confidence: 0.69,
      sourceEpisodes: [],
      firstObserved: fixedNow - 8 * 86400_000,
      lastConfirmed: fixedNow - 3 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 8 * 86400_000,
    },
    {
      id: 10,
      groupId: "group-ctx",
      subject: "group",
      factType: "tool_knowledge",
      content: "群里还有个冷门 bot 指令",
      embedding: [0.2, 0.9],
      confidence: 0.68,
      sourceEpisodes: [],
      firstObserved: fixedNow - 30 * 86400_000,
      lastConfirmed: fixedNow - 25 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 30 * 86400_000,
    },
    {
      id: 11,
      groupId: "group-ctx",
      subject: "group",
      factType: "inside_joke",
      content: "群里有个摩诃相关的老梗，经常被拿出来玩",
      embedding: [0.6, 0.4],
      confidence: 0.7,
      sourceEpisodes: [],
      firstObserved: fixedNow - 20 * 86400_000,
      lastConfirmed: fixedNow - 4 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 20 * 86400_000,
    },
    {
      id: 12,
      groupId: "group-ctx",
      subject: "group",
      factType: "inside_joke",
      content: "群里会玩喜欢我接龙",
      embedding: [0.55, 0.45],
      confidence: 0.67,
      sourceEpisodes: [],
      firstObserved: fixedNow - 18 * 86400_000,
      lastConfirmed: fixedNow - 3 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 18 * 86400_000,
    },
    {
      id: 13,
      groupId: "group-ctx",
      subject: "group",
      factType: "inside_joke",
      content: "群里有个吃比的梗",
      embedding: [0.52, 0.48],
      confidence: 0.66,
      sourceEpisodes: [],
      firstObserved: fixedNow - 25 * 86400_000,
      lastConfirmed: fixedNow - 5 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 25 * 86400_000,
    },
    {
      id: 14,
      groupId: "group-ctx",
      subject: "group",
      factType: "group_expression",
      content: "群里会用草或者我草表示惊讶或者觉得好笑",
      embedding: [0.4, 0.6],
      confidence: 0.73,
      sourceEpisodes: [],
      firstObserved: fixedNow - 6 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 6 * 86400_000,
    },
    {
      id: 15,
      groupId: "group-ctx",
      subject: "group",
      factType: "group_expression",
      content: "群里会刷强强！？这种说法",
      embedding: [0.35, 0.65],
      confidence: 0.7,
      sourceEpisodes: [],
      firstObserved: fixedNow - 9 * 86400_000,
      lastConfirmed: fixedNow - 2 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 9 * 86400_000,
    },
    {
      id: 16,
      groupId: "group-ctx",
      subject: "group",
      factType: "opinion",
      content: "这其实不是群文化 canonical fact",
      embedding: [0.8, 0.2],
      confidence: 0.95,
      sourceEpisodes: [],
      firstObserved: fixedNow - 1 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: null,
      createdAt: fixedNow - 1 * 86400_000,
    },
    {
      id: 17,
      groupId: "group-ctx",
      subject: "group",
      factType: "reaction_pattern",
      content: "这条已经被 supersede，不该再显示",
      embedding: [0.3, 0.7],
      confidence: 0.99,
      sourceEpisodes: [],
      firstObserved: fixedNow - 1 * 86400_000,
      lastConfirmed: fixedNow - 1 * 86400_000,
      supersededBy: 999,
      createdAt: fixedNow - 1 * 86400_000,
    },
  ];

  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        if (table === "mio.semantic" && query.groupId === "group-ctx" && query.subject === "group") {
          return groupFacts;
        }
        return [];
      },
    },
  } as any;

  const assembler = new ContextAssembler(ctx, {
    getSessionVibe() {
      return null;
    },
  } as any);

  const text = await (assembler as any).buildGroupCulture("group-ctx");
  const lines = text.split("\n").filter(Boolean);

  assert.ok(lines.length <= 15);
  assert.ok(lines.length >= 8);
  assert.equal(lines.filter((line) => line.includes("刷问号")).length, 1);
  assert.ok(lines.some((line) => line.includes("/选 可以帮忙做选择")));
  assert.ok(lines.some((line) => line.includes("喜欢我接龙")));
  assert.ok(lines.some((line) => line.includes("草或者我草")));
  assert.ok(!lines.some((line) => line.includes("这其实不是群文化 canonical fact")));
  assert.ok(!lines.some((line) => line.includes("这条已经被 supersede")));
  assert.equal(lines.filter((line) => line.includes("- ")).length, lines.length);
});

test("group culture distillation promotes canonical facts without surfacing example-specific evidence", async () => {
  const fixedNow = 1713528000000;
  const cultureEvidence: CultureEvidenceRow[] = [
    {
      id: 1,
      groupId: "group-e2e",
      kind: "tool_knowledge",
      content: "群里有人会发 /选 苹果还是香蕉 让 37 帮忙选",
      embedding: [1, 0],
      confidence: 0.76,
      sourceEpisodeId: null,
      sourceWindowKey: "group-e2e:w1",
      observedAt: fixedNow - 20_000,
      lastSeenAt: fixedNow - 20_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 20_000,
    },
    {
      id: 2,
      groupId: "group-e2e",
      kind: "tool_knowledge",
      content: "群里有人会发 /选 劳拉西泮还是盐酸氟西汀 让 37 给建议",
      embedding: [0.99, 0.01],
      confidence: 0.72,
      sourceEpisodeId: null,
      sourceWindowKey: "group-e2e:w2",
      observedAt: fixedNow - 10_000,
      lastSeenAt: fixedNow - 10_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 10_000,
    },
    {
      id: 3,
      groupId: "group-e2e",
      kind: "reaction_pattern",
      content: "有人发雀魂离谱和牌截图，大家会刷问号",
      embedding: [0, 1],
      confidence: 0.74,
      sourceEpisodeId: null,
      sourceWindowKey: "group-e2e:w3",
      observedAt: fixedNow - 18_000,
      lastSeenAt: fixedNow - 18_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 18_000,
    },
    {
      id: 4,
      groupId: "group-e2e",
      kind: "reaction_pattern",
      content: "群里看到离谱截图或者很强的东西会刷草和问号",
      embedding: [0.01, 0.99],
      confidence: 0.7,
      sourceEpisodeId: null,
      sourceWindowKey: "group-e2e:w4",
      observedAt: fixedNow - 9_000,
      lastSeenAt: fixedNow - 9_000,
      status: "active",
      clusterId: null,
      createdAt: fixedNow - 9_000,
    },
  ];
  const semanticRows: any[] = [];
  const created: Array<{ table: string; row: any }> = [];
  const ctx = {
    logger() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
      };
    },
    database: {
      async get(table: string, query: any) {
        if (table === "mio.culture_evidence" && query.groupId === "group-e2e") {
          return cultureEvidence;
        }
        if (table === "mio.semantic" && query.groupId === "group-e2e" && query.subject === "group") {
          return semanticRows;
        }
        return [];
      },
      async create(table: string, row: any) {
        const createdRow = { id: semanticRows.length + 100, ...row };
        created.push({ table, row: createdRow });
        if (table === "mio.semantic") {
          semanticRows.push(createdRow);
        }
        return createdRow;
      },
      async set(_table: string, query: any, patch: any) {
        const row = semanticRows.find((item) => item.id === query.id);
        if (row) Object.assign(row, patch);
      },
    },
  } as any;
  const llm = {
    async chat() {
      return {
        content: JSON.stringify({
          promoted_facts: [
            {
              cluster_index: 0,
              fact_type: "tool_knowledge",
              content: "群里有个 37 bot，/选 可以帮忙做选择",
              confidence: 0.8,
            },
            {
              cluster_index: 1,
              fact_type: "reaction_pattern",
              content: "群里看到离谱内容时常会刷问号、草之类的反应",
              confidence: 0.76,
            },
          ],
          merged_facts: [],
          confirmed_facts: [],
          decayed_facts: [],
        }),
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      };
    },
  } as any;
  const embeddingService = {
    async embed(text: string) {
      if (text.includes("/选")) return [1, 0];
      if (text.includes("问号") || text.includes("草")) return [0, 1];
      return [0.5, 0.5];
    },
    async embedBatch(texts: string[]) {
      return texts.map((text) => {
        if (text.includes("/选")) return [1, 0];
        if (text.includes("问号") || text.includes("草")) return [0, 1];
        return [0.5, 0.5];
      });
    },
  } as any;
  const pipeline = new DistillationPipeline(ctx, llm, {
    enabled: true,
    embedding: {} as any,
    extraction: {} as any,
    distillation: {} as any,
    distillationHour: 3,
    flushIntervalMs: 300000,
    maxPendingWrites: 20,
    activePoolLimit: 200,
  }, embeddingService);
  const assembler = new ContextAssembler(ctx, {
    getSessionVibe() {
      return null;
    },
  } as any);

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await pipeline.maintainGroupCulture("group-e2e");
    const text = await (assembler as any).buildGroupCulture("group-e2e");
    const lines = text.split("\n").filter(Boolean);

    assert.equal(created.filter(({ table }) => table === "mio.semantic").length, 2);
    assert.ok(lines.some((line) => line.includes("/选 可以帮忙做选择")));
    assert.ok(lines.some((line) => line.includes("问号、草之类的反应")));
    assert.ok(!lines.some((line) => line.includes("劳拉西泮还是盐酸氟西汀")));
  } finally {
    Date.now = originalNow;
  }
});
