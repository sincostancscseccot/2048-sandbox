export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.some(key => !/^[\x20-\x7e]+$/.test(key))) throw new Error('摘要字段名必须为 ASCII');
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('摘要数据包含非 JSON 值或非安全整数');
}

export async function hashJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return hashBytes(bytes);
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function timestamp(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
export function newId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
