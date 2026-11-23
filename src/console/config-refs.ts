/**
 * koishi.yml 里可以写 `${{ env.X }}`，loader 解析后才交给插件，所以面板拿到和提交回来的都是解析后的值。
 * 保存时 loader 会把提交的值原样写回 koishi.yml，引用就被换成了明文。
 * 这里按「面板没改的字段写回原来的引用」把引用还原回去；改过的字段写新值。
 */

const REF = /\$\{\{.+?\}\}/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

export interface ChangedRef {
  path: string;
  ref: string;
}

/**
 * @param raw      koishi.yml 里这一段的原始内容（可能含引用）
 * @param resolved 同一段解析后的值，也就是面板打开时看到的值
 * @param next     面板提交的新值（loader 即将写回 koishi.yml 的内容）
 * @param changed  被改掉的引用会记在这里，调用方据此提醒「这个字段现在是明文了」
 */
export function restoreRefs(raw: unknown, resolved: unknown, next: unknown, changed: ChangedRef[] = [], path = ""): unknown {
  if (typeof raw === "string" && REF.test(raw)) {
    if (deepEqual(resolved, next)) return raw;
    changed.push({ path: path || "/", ref: raw });
    return next;
  }

  if (Array.isArray(raw) && Array.isArray(resolved) && Array.isArray(next)) {
    // 供应商这类带 id 的列表在面板里会增删、重排，按 id 对位；其余按下标
    const idOf = (item: unknown) => (isPlainObject(item) && typeof item.id === "string" ? item.id : undefined);
    const byId = raw.length === resolved.length && resolved.every((item) => idOf(item) !== undefined);
    return next.map((item, i) => {
      const j = byId ? resolved.findIndex((old) => idOf(old) === idOf(item)) : i;
      if (j < 0 || j >= raw.length) return item;
      return restoreRefs(raw[j], resolved[j], item, changed, `${path}/${i}`);
    });
  }

  if (isPlainObject(raw) && isPlainObject(resolved) && isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      out[key] = key in raw ? restoreRefs(raw[key], resolved[key], value, changed, `${path}/${key}`) : value;
    }
    return out;
  }

  return next;
}
