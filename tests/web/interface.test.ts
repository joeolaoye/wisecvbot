import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('web sign-in interface', () => {
  it('keeps phone sign-in hidden and offers Telegram as a bot link', async () => {
    const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8')
    const script = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8')

    expect(html).not.toContain('id="phone"')
    expect(html).not.toContain('Continue with WhatsApp')
    expect(html).toContain('id="telegram-chip"')
    expect(html).toContain('You can also use WiseCV on Telegram — message the bot')
    expect(script).not.toContain("api('/api/auth/start'")
    expect(script).toContain('telegramChip.href = capabilities.telegramUrl')
  })
})
