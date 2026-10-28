export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('服务没有返回可读取的结果，请检查执行服务是否已启动。'); }
  if (!response.ok) {
    const result = value as { detail?: string | {msg?: string}[]; message?: string };
    throw new Error(typeof result.detail === 'string' ? result.detail : Array.isArray(result.detail) ? result.detail.map(item => item.msg).join('；') : result.message || `请求未完成（${response.status}）`);
  }
  return value as T;
}
export function unwrap<T>(value: unknown, key: string): T { return ((value as Record<string, unknown>)?.[key] ?? value) as T; }
export function externalUrl(value?: string): string | undefined {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) ? url.href : undefined; } catch { return undefined; }
}
