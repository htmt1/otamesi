import { config } from './config.js';
export async function api(path, { body, token, method = 'GET' } = {}) {
  if (!config.apiBase) throw new Error('配布機能は準備中です。');
  const response = await fetch(config.apiBase.replace(/\/$/, '') + path, {
    method, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '通信に失敗しました。');
  return data;
}
