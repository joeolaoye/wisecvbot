import { PROVIDER_DEFAULT_CHAT, resolveChatModelId } from '../../src/llm.js'

describe('LLM provider model resolution', () => {
  test('each provider has a default chat model', () => {
    expect(PROVIDER_DEFAULT_CHAT.openai).toBe('gpt-4o-mini')
    expect(PROVIDER_DEFAULT_CHAT.anthropic).toMatch(/^claude-/)
  })

  test('no override → provider default', () => {
    expect(resolveChatModelId('openai')).toBe('gpt-4o-mini')
    expect(resolveChatModelId('anthropic')).toBe(PROVIDER_DEFAULT_CHAT.anthropic)
  })

  test('CHAT_MODEL override wins regardless of provider', () => {
    expect(resolveChatModelId('openai', 'gpt-4.1')).toBe('gpt-4.1')
    expect(resolveChatModelId('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })
})
