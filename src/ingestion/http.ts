export class IngestionError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message)
  }
}

const UA = 'WiseCV/0.1 (+https://github.com/joeolaoye/wisecvbot) job-matching agent'

export async function fetchJson<T>(url: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  let lastError: Error = new IngestionError('unreachable')

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 404) {
        throw new IngestionError(`404 not found: ${url}`, 404)
      }
      if (res.status >= 500 || res.status === 429) {
        lastError = new IngestionError(`upstream ${res.status}: ${url}`, res.status)
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      if (!res.ok) {
        throw new IngestionError(`upstream ${res.status}: ${url}`, res.status)
      }
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof IngestionError && err.status === 404) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastError
}
