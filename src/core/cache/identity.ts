export async function sha256(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const fields = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map(key => [key, fields[key]]));
  });
}

export async function cacheKey(version: string, value: unknown): Promise<string> {
  return `${version}:${await sha256(stableJson(value))}`;
}
