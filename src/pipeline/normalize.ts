import type { RoleFamily, Seniority } from '../domain/job.js'

export interface ParsedSalary {
  min: number
  max: number
  currency: string
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  us$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP',
}

/**
 * Parse a salary string like "$150k – $175k", "€60,000-€80,000 per annum".
 * Returns null when the text looks hourly/unclear — a null salary is always
 * safer than a wrong one.
 */
export function parseSalary(text: string | null | undefined): ParsedSalary | null {
  if (!text) return null
  const t = text.toLowerCase()
  if (/per hour|\/hr\b|\/hour\b|hourly/.test(t)) return null

  const curMatch = t.match(/us\$|\$|€|£|usd|eur|gbp/)
  const currency = curMatch ? (CURRENCY_SYMBOLS[curMatch[0]] ?? 'USD') : 'USD'

  // normalize numbers: expand "150k" → 150000, strip thousands separators
  const normalized = t
    .replace(/(\d{1,3}(?:[.,]\d+)?)\s*k(?=[^\w]|$)/g, (_m, n: string) =>
      String(Math.round(parseFloat(n.replace(',', '.')) * 1000)),
    )
    .replace(/(\d),(?=\d{3}\b)/g, '$1')

  // plausible annual figures only: 4–6 digits, 10k–1M (filters out years like "2024")
  const nums = [...normalized.matchAll(/\b(\d{4,6})(?:\.\d+)?\b/g)]
    .map((m) => parseInt(m[1] ?? '0', 10))
    .filter((n) => n >= 10_000 && n <= 1_000_000)

  if (nums.length === 0) return null
  const first = nums.slice(0, 2)
  const min = Math.min(...first)
  const max = first.length > 1 ? Math.max(...first) : min
  return { min, max, currency }
}

export function detectRemote(location: string | null | undefined, title: string): boolean {
  const haystack = `${location ?? ''} ${title}`.toLowerCase()
  return /remote|anywhere|distributed|worldwide|work from home/.test(haystack)
}

// Ordered — first match wins. 'other' is the fallback.
const ROLE_RULES: ReadonlyArray<readonly [RoleFamily, RegExp]> = [
  ['management', /\b(engineering manager|em\b|manager|director|head of|\bvp\b|vice president|chief|president)\b/i],
  ['ml', /\b(machine learning|\bml\b|ai engineer|deep learning|\bllm\b|nlp|research engineer|data scientist|applied scientist)\b/i],
  ['data', /\b(data engineer|analytics engineer|\bbi\b|business intelligence|\betl\b|\bdbt\b|data platform|data warehouse|data infrastructure)\b/i],
  ['devops', /\b(devops|sre\b|site reliability|platform engineer|infrastructure engineer|kubernetes|cloud engineer|systems engineer|production engineer)\b/i],
  ['security', /\b(security|appsec|devsecops|penetration|red team|blue team|threat)\b/i],
  ['mobile', /\b(ios|android|mobile|react native|flutter)\b/i],
  ['fullstack', /\b(full[- ]?stack)\b/i],
  ['frontend', /\b(frontend|front-end|front end|\breact\b|\bvue\b|\bangular\b|next\.?js|ui engineer|web engineer)\b/i],
  ['backend', /\b(backend|back-end|back end|\bapi\b|golang|\bgo\b|python|\bjava\b|ruby|\bphp\b|\.net|node|rust|scala|elixir|software engineer|software developer|\bdeveloper\b|\bengineer\b)\b/i],
  ['qa', /\b(qa|quality assurance|test engineer|sdet|automation engineer)\b/i],
]

export function classifyRoleFamily(title: string): RoleFamily {
  for (const [family, re] of ROLE_RULES) {
    if (re.test(title)) return family
  }
  return 'other'
}

export function classifySeniority(title: string): Seniority {
  const t = title.toLowerCase()
  if (/\b(vp\b|vice president|chief|cto|cio|president)\b/.test(t)) return 'exec'
  if (/\b(principal|distinguished|fellow)\b/.test(t)) return 'principal'
  if (/\bstaff\b/.test(t)) return 'staff'
  if (/\b(lead|tech lead|team lead)\b/.test(t)) return 'lead'
  if (/\b(senior|sr\.?\b|iii\b|iii)\b/.test(t)) return 'senior'
  if (/\b(junior|jr\.?\b|entry|entry-level|graduate|intern|trainee)\b/.test(t)) return 'junior'
  return 'mid'
}
