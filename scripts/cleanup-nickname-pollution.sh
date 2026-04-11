#!/usr/bin/env bash
# 清理因群昵称伪装（"澪"的父亲。）导致的数据库污染
# 目标用户: userId=1121863830, 真实称呼: kim
#
# 用法: bash scripts/cleanup-nickname-pollution.sh [--dry-run]

set -euo pipefail
cd "$(dirname "$0")/../../.."

DB="data/koishi.db"
BACKUP="data/koishi.db.bak.$(date +%Y%m%d_%H%M%S)"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE ==="
  echo ""
fi

if [[ ! -f "$DB" ]]; then
  echo "ERROR: Database not found at $DB"
  exit 1
fi

# ── 1. 备份 ──────────────────────────────────────────────

if [[ "$DRY_RUN" == false ]]; then
  cp "$DB" "$BACKUP"
  echo "Backup created: $BACKUP"
  echo ""
fi

# ── 2. 展示当前污染状态 ──────────────────────────────────

echo "=== 污染状态 ==="
echo ""

echo "--- mio.relational (row 7, userId=1121863830) ---"
sqlite3 "$DB" "SELECT 'displayName: ' || displayName FROM 'mio.relational' WHERE userId='1121863830';"
sqlite3 "$DB" "SELECT 'coreImpression: ' || coreImpression FROM 'mio.relational' WHERE userId='1121863830';"
echo ""

echo "--- mio.semantic (inside_joke #75) ---"
sqlite3 "$DB" "SELECT 'id=' || id || ' | ' || content FROM 'mio.semantic' WHERE id=75;"
echo ""

echo "--- mio.episodic (含'父亲'的条目) ---"
sqlite3 "$DB" "SELECT 'id=' || id || ' | ' || substr(summary, 1, 80) FROM 'mio.episodic' WHERE summary LIKE '%父亲%' OR summary LIKE '%我爸%';"
echo ""

echo "--- mio.episodic (含'父女'的条目) ---"
sqlite3 "$DB" "SELECT 'id=' || id || ' | ' || substr(summary, 1, 80) FROM 'mio.episodic' WHERE summary LIKE '%父女%' OR (summary LIKE '%我女儿%' AND summary LIKE '%幻城%');"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "=== DRY RUN: 以下是将要执行的操作 ==="
  echo ""
fi

# ── 3. 清理 mio.relational ──────────────────────────────

echo "[FIX] mio.relational: displayName '\"澪\"的父亲。' → 'kim'"
echo "[FIX] mio.relational: 清理 coreImpression 中的角色扮演污染"

if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.relational'
    SET displayName = 'kim',
        coreImpression = REPLACE(coreImpression, '，似乎喜欢通过角色扮演来互动', '')
    WHERE userId = '1121863830';
  "
fi

# ── 4. 删除 mio.semantic 污染条目 ────────────────────────

echo "[DEL] mio.semantic #75: '澪的父亲'改名梗 inside_joke"

if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "DELETE FROM 'mio.semantic' WHERE id = 75;"
fi

# ── 5. 删除纯粹关于改名事件的 episodic 记忆 ─────────────
# 这些条目没有其他有价值的内容，纯粹是改名闹剧的记录

DELETE_IDS=(285 328 329 400 401)

for id in "${DELETE_IDS[@]}"; do
  summary=$(sqlite3 "$DB" "SELECT substr(summary, 1, 60) FROM 'mio.episodic' WHERE id = $id;" 2>/dev/null || echo "(not found)")
  echo "[DEL] mio.episodic #$id: $summary..."
  if [[ "$DRY_RUN" == false ]]; then
    sqlite3 "$DB" "DELETE FROM 'mio.episodic' WHERE id = $id;"
  fi
done

# ── 6. 修复含有价值内容但引用了污染昵称的 episodic 记忆 ──
# 把 "澪"的父亲。/ "澪"的父亲 / 父亲（作为称呼）替换为 kim

# 逐条处理，因为每条的替换模式略有不同

echo "[FIX] mio.episodic #354: 替换昵称引用"
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.episodic' SET summary = 'kim又问我樱桃喵那张图在干嘛，我有点无语地回他\"不就是在被欺负\"。'
    WHERE id = 354;
  "
fi

echo "[FIX] mio.episodic #364: 替换昵称引用"
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.episodic' SET summary = 'kim发了牢A和斩杀线的同人图合集 孔乙己说吓哭了 上次看到这么猎奇的还是在ch圈 我说了句ch圈确实是懂的都懂'
    WHERE id = 364;
  "
fi

echo "[FIX] mio.episodic #370: 替换昵称引用"
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.episodic' SET summary = REPLACE(summary, '''父亲''', 'kim')
    WHERE id = 370;
  "
fi

echo "[FIX] mio.episodic #380: 替换昵称引用"
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.episodic' SET summary = 'kim说今天bot这么温柔'
    WHERE id = 380;
  "
fi

echo "[FIX] mio.episodic #396: 替换昵称引用"
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.episodic' SET summary = 'kim说下次偷偷投喂 我答应了'
    WHERE id = 396;
  "
fi

echo "[FIX] mio.episodic #397: 替换昵称引用"
if [[ "$DRY_RUN" == false ]]; then
  sqlite3 "$DB" "
    UPDATE 'mio.episodic' SET summary = REPLACE(summary, '父亲', 'kim')
    WHERE id = 397;
  "
fi

# ── 7. 验证 ──────────────────────────────────────────────

echo ""
echo "=== 清理后验证 ==="

if [[ "$DRY_RUN" == false ]]; then
  echo ""
  echo "--- mio.relational (userId=1121863830) ---"
  sqlite3 "$DB" "SELECT 'displayName: ' || displayName FROM 'mio.relational' WHERE userId='1121863830';"
  sqlite3 "$DB" "SELECT 'coreImpression: ' || coreImpression FROM 'mio.relational' WHERE userId='1121863830';"

  echo ""
  echo "--- mio.semantic: 残留'父亲'引用 ---"
  remaining=$(sqlite3 "$DB" "SELECT COUNT(*) FROM 'mio.semantic' WHERE content LIKE '%父亲%';" 2>/dev/null)
  echo "Count: $remaining"

  echo ""
  echo "--- mio.episodic: 残留'父亲'引用 ---"
  remaining=$(sqlite3 "$DB" "SELECT COUNT(*) FROM 'mio.episodic' WHERE summary LIKE '%父亲%';" 2>/dev/null)
  echo "Count: $remaining"
  if [[ "$remaining" -gt 0 ]]; then
    sqlite3 "$DB" "SELECT 'id=' || id || ' | ' || substr(summary, 1, 80) FROM 'mio.episodic' WHERE summary LIKE '%父亲%';"
  fi

  echo ""
  echo "Done. Backup at: $BACKUP"
else
  echo ""
  echo "DRY RUN 完成，未修改数据库。去掉 --dry-run 参数执行实际清理。"
fi
