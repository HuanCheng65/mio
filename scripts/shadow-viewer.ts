import * as blessed from "blessed";
import * as fs from "fs";
import * as path from "path";

// --- Types ---
interface ShadowEntry {
  timestamp: string;
  groupId: string;
  phase: "main" | "search";
  newMessages: { sender: string; content: string }[];
  thought: string;
  urge: number;
  silent: boolean;
  actions: { type: string; content?: string; text?: string; target_msg_id?: string; emoji_name?: string; intent?: string }[] | null;
  search: { query?: string; hint: string; intent: string } | null;
}

type FilterMode = "all" | "speak" | "silent";

// --- Data loading ---
function resolveDataDir(): string {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  return path.resolve(__dirname, "..", "data", "shadow");
}

function loadGroups(dataDir: string): { id: string; path: string; count: number }[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fp = path.join(dataDir, f);
      const lines = fs.readFileSync(fp, "utf-8").trim().split("\n").filter(Boolean);
      return { id: f.replace(".jsonl", ""), path: fp, count: lines.length };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function loadEntries(filePath: string): ShadowEntry[] {
  const entries: ShadowEntry[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

function filterEntries(entries: ShadowEntry[], mode: FilterMode): ShadowEntry[] {
  if (mode === "speak") return entries.filter((e) => !e.silent);
  if (mode === "silent") return entries.filter((e) => e.silent);
  return entries;
}

// --- Formatting ---
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch { return iso; }
}

function urgeBar(urge: number): string {
  const n = Math.max(0, Math.min(10, urge));
  const filled = "+".repeat(n);
  const empty = " ".repeat(10 - n);
  const color = n >= 7 ? "{green-fg}" : n >= 4 ? "{yellow-fg}" : "{gray-fg}";
  const tag = n >= 7 ? "{green-fg}SPEAK{/}" : "{gray-fg}silent{/}";
  return `  urge: ${color}[${filled}${empty}] ${urge}/10{/} ${tag}`;
}

function renderEntry(e: ShadowEntry, idx: number): string {
  const lines: string[] = [];
  const phase = e.phase === "search" ? " {blue-fg}[search]{/}" : "";
  lines.push(`{bold}{cyan-fg}--- #${idx}  ${fmtTime(e.timestamp)}${phase} ---{/}`);

  if (e.newMessages?.length) {
    for (const m of e.newMessages) {
      lines.push(`  {white-fg}${m.sender}: ${m.content}{/}`);
    }
  } else {
    lines.push("  {gray-fg}(no new messages){/}");
  }

  lines.push(`  {yellow-fg}think: ${e.thought}{/}`);
  lines.push(urgeBar(e.urge));

  if (!e.silent && e.actions?.length) {
    for (const a of e.actions) {
      switch (a.type) {
        case "message": lines.push(`    {cyan-fg}[msg]{/} ${a.content}`); break;
        case "reply":   lines.push(`    {cyan-fg}[reply -> ${a.target_msg_id}]{/} ${a.text}`); break;
        case "react":   lines.push(`    {magenta-fg}[react -> ${a.target_msg_id}]{/} ${a.emoji_name}`); break;
        case "sticker": lines.push(`    {magenta-fg}[sticker]{/} ${a.intent}`); break;
        case "recall":  lines.push(`    {yellow-fg}[recall -> ${a.target_msg_id}]{/}`); break;
      }
    }
  }

  if (e.search) {
    const q = e.search.query || "(image)";
    lines.push(`    {blue-fg}[search -> ${e.search.hint}]{/} ${q}`);
  }

  lines.push("");
  return lines.join("\n");
}

function renderStats(entries: ShadowEntry[]): string {
  if (!entries.length) return "No entries.";
  const total = entries.length;
  const speaking = entries.filter((e) => !e.silent).length;
  const silent = total - speaking;
  const searches = entries.filter((e) => e.phase === "search").length;
  const pct = ((speaking / total) * 100).toFixed(1);

  const lines: string[] = [];
  lines.push("{bold}{cyan-fg}=== Stats ==={/}");
  lines.push(`  Period:    ${fmtTime(entries[0].timestamp)}  ~  ${fmtTime(entries[entries.length - 1].timestamp)}`);
  lines.push(`  Total:     ${total} entries (${searches} after search)`);
  lines.push(`  Speaking:  {green-fg}${speaking}{/}  Silent: {gray-fg}${silent}{/}  (${pct}% would speak)`);
  lines.push("");
  lines.push("{bold}{cyan-fg}  Urge distribution:{/}");

  const buckets = new Array(11).fill(0);
  for (const e of entries) buckets[Math.max(0, Math.min(10, Math.round(e.urge)))]++;
  const maxCount = Math.max(1, ...buckets);

  for (let u = 0; u <= 10; u++) {
    const barLen = Math.round((buckets[u] / maxCount) * 30);
    const bar = "\u2588".repeat(barLen).padEnd(30);
    const color = u >= 7 ? "green" : u >= 4 ? "yellow" : "gray";
    lines.push(`    {${color}-fg}${String(u).padStart(2)}: ${bar} ${buckets[u]}{/}`);
  }

  const actionCounts: Record<string, number> = {};
  for (const e of entries) {
    if (e.actions) for (const a of e.actions) actionCounts[a.type] = (actionCounts[a.type] || 0) + 1;
  }
  if (Object.keys(actionCounts).length) {
    lines.push("");
    lines.push("{bold}{cyan-fg}  Action breakdown:{/}");
    for (const [type, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${type.padEnd(12)} ${count}`);
    }
  }

  return lines.join("\n");
}

// --- TUI ---
const dataDir = resolveDataDir();
const groups = loadGroups(dataDir);

if (!groups.length) {
  console.error(`No shadow logs in ${dataDir}`);
  process.exit(1);
}

const screen = blessed.screen({
  smartCSR: true,
  title: "Mio Shadow Viewer",
  fullUnicode: true,
});

// -- Left: group list --
const groupList = blessed.list({
  parent: screen,
  label: " Groups ",
  top: 0,
  left: 0,
  width: 22,
  height: "100%-3",
  border: { type: "line" },
  style: {
    border: { fg: "gray" },
    selected: { bg: "blue", fg: "white", bold: true },
    item: { fg: "white" },
    focus: { border: { fg: "cyan" } },
  },
  keys: true,
  vi: true,
  mouse: true,
  items: groups.map((g) => ` ${g.id} (${g.count})`),
  scrollbar: { ch: " ", style: { bg: "gray" } },
});

// -- Right: entry view --
const entryBox = blessed.box({
  parent: screen,
  label: " Log (All) ",
  top: 0,
  left: 22,
  width: "100%-22",
  height: "100%-3",
  border: { type: "line" },
  style: {
    border: { fg: "gray" },
    focus: { border: { fg: "cyan" } },
  },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: " ", style: { bg: "gray" } },
});

// -- Bottom: help bar --
const helpBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  border: { type: "line" },
  style: { border: { fg: "gray" }, fg: "white" },
  tags: true,
  content: " {cyan-fg}Tab{/}:panel  {cyan-fg}1{/}:All {cyan-fg}2{/}:Speak {cyan-fg}3{/}:Silent  {cyan-fg}s{/}:Stats  {cyan-fg}r{/}:Refresh  {cyan-fg}q{/}:Quit",
});

// -- State --
let currentGroupIdx = 0;
let currentFilter: FilterMode = "all";
let allEntries: ShadowEntry[] = [];
let showingStats = false;

function refreshEntries() {
  const group = groups[currentGroupIdx];
  if (!group) return;
  allEntries = loadEntries(group.path);
  renderView();
}

function renderView() {
  const group = groups[currentGroupIdx];
  if (!group) return;

  if (showingStats) {
    entryBox.setLabel(` Stats: ${group.id} `);
    entryBox.setContent(renderStats(allEntries));
    entryBox.setScrollPerc(0);
    screen.render();
    return;
  }

  const filtered = filterEntries(allEntries, currentFilter);
  const filterLabel = currentFilter === "all" ? "All" : currentFilter === "speak" ? "Speaking" : "Silent";
  entryBox.setLabel(` ${group.id} - ${filterLabel} (${filtered.length}/${allEntries.length}) `);
  entryBox.setContent(filtered.map((e, i) => renderEntry(e, i + 1)).join("\n"));
  entryBox.setScrollPerc(100); // start at bottom (latest)
  screen.render();
}

// -- Events --
groupList.on("select item", (_item: any, index: number) => {
  currentGroupIdx = index;
  showingStats = false;
  refreshEntries();
});

function setFilter(mode: FilterMode) {
  currentFilter = mode;
  showingStats = false;
  renderView();
}

screen.key(["1"], () => setFilter("all"));
screen.key(["2"], () => setFilter("speak"));
screen.key(["3"], () => setFilter("silent"));
screen.key(["s"], () => { showingStats = !showingStats; renderView(); });
screen.key(["r"], () => {
  const newGroups = loadGroups(dataDir);
  groups.length = 0;
  groups.push(...newGroups);
  groupList.setItems(groups.map((g) => ` ${g.id} (${g.count})`));
  groupList.select(Math.min(currentGroupIdx, groups.length - 1));
  refreshEntries();
});
screen.key(["q", "C-c"], () => process.exit(0));
screen.key(["tab"], () => {
  if ((screen as any).focused === groupList) {
    entryBox.focus();
  } else {
    groupList.focus();
  }
  screen.render();
});

// -- Init --
groupList.select(0);
groupList.focus();
refreshEntries();
screen.render();
