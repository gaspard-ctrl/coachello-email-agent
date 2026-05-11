// Mini-wrapper pour les appels API. Prefixe automatique `/api`, JSON par défaut,
// throw une Error avec le message du serveur en cas d'erreur HTTP.

const BASE = '/api'

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data as T
}

export async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data as T
}
