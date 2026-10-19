/* global Blob, URLSearchParams, clearInterval, document, fetch, history, location, setInterval */

const $ = (selector) => document.querySelector(selector)
const auth = $('#auth')
const chat = $('#chat')
const logout = $('#logout')
const messages = $('#messages')
const authError = $('#auth-error')
const chatError = $('#chat-error')
let csrfToken = ''
let challengeToken = ''
let pollTimer = null

const query = new URLSearchParams(location.search)
if (query.get('email') === 'invalid') {
  authError.textContent = 'That sign-in link is invalid or has expired. Request a new one.'
  history.replaceState({}, '', '/')
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof Blob ? {} : { 'content-type': 'application/json' }),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Something went wrong.')
  return data
}

function showChat() {
  auth.classList.add('hidden')
  chat.classList.remove('hidden')
  logout.classList.remove('hidden')
}

async function loadAuthCapabilities() {
  try {
    const capabilities = await api('/api/auth/capabilities')
    if (capabilities.email) {
      $('#email-form').classList.remove('hidden')
      $('#email-divider').classList.remove('hidden')
      $('#auth-intro').textContent = 'No password. Sign in by email, Telegram, or WhatsApp.'
    }
    document.querySelector('[data-method="telegram"]').disabled = !capabilities.telegram
    document.querySelector('[data-method="whatsapp"]').disabled = !capabilities.whatsapp
  } catch {
    document.querySelectorAll('[data-method]').forEach((button) => {
      button.disabled = true
    })
  }
}

function render(items) {
  messages.replaceChildren()
  for (const item of items) {
    const bubble = document.createElement('article')
    bubble.className = `message ${item.role === 'user' ? 'user' : 'assistant'}`
    const copy = document.createElement('div')
    copy.textContent = item.body
    bubble.append(copy)
    if (item.actions?.length) {
      const actions = document.createElement('div')
      actions.className = 'message-actions'
      for (const action of item.actions) {
        if (action.value.startsWith('url:')) {
          const link = document.createElement('a')
          const target = action.value.slice(4)
          if (!/^https?:\/\//.test(target)) continue
          link.href = target
          link.target = '_blank'
          link.rel = 'noreferrer'
          link.textContent = action.label
          actions.append(link)
        } else {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = action.label
          button.addEventListener('click', () => sendAction(action.value))
          actions.append(button)
        }
      }
      bubble.append(actions)
    }
    messages.append(bubble)
  }
  messages.scrollTop = messages.scrollHeight
}

async function loadChat() {
  showChat()
  const data = await api('/api/chat')
  render(data.messages)
}

async function sendAction(action) {
  chatError.textContent = ''
  try {
    const data = await api('/api/chat/action', { method: 'POST', body: JSON.stringify({ action }) })
    render(data.messages)
  } catch (error) {
    chatError.textContent = error.message
  }
}

async function finishAuthentication(data) {
  csrfToken = data.csrfToken
  clearInterval(pollTimer)
  await loadChat()
}

async function pollChallenge() {
  try {
    const data = await api(`/api/auth/status?token=${encodeURIComponent(challengeToken)}`)
    if (data.authenticated) await finishAuthentication(data)
  } catch (error) {
    authError.textContent = error.message
  }
}

document.querySelectorAll('[data-method]').forEach((button) => {
  button.addEventListener('click', async () => {
    authError.textContent = ''
    const phone = $('#phone').value
    const method = button.dataset.method
    try {
      const data = await api('/api/auth/start', {
        method: 'POST',
        body: JSON.stringify({ phone, method }),
      })
      challengeToken = data.token
      $('#verify').classList.remove('hidden')
      if (method === 'telegram') {
        $('#verify-copy').textContent =
          'Open Telegram and share your phone number with WiseBot. This tab will sign in automatically.'
        $('#telegram-link').href = data.telegramUrl
        $('#telegram-link').classList.remove('hidden')
        $('#code-form').classList.add('hidden')
        pollTimer = setInterval(pollChallenge, 1800)
      } else {
        $('#verify-copy').textContent = 'We sent a 6-digit verification code through WhatsApp.'
        $('#telegram-link').classList.add('hidden')
        $('#code-form').classList.remove('hidden')
      }
    } catch (error) {
      authError.textContent = error.message
    }
  })
})

$('#email-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  authError.textContent = ''
  try {
    const data = await api('/api/auth/email/start', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value }),
    })
    $('#verify').classList.remove('hidden')
    $('#verify-copy').textContent = data.message
    $('#telegram-link').classList.add('hidden')
    $('#code-form').classList.add('hidden')
  } catch (error) {
    authError.textContent = error.message
  }
})

$('#code-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  authError.textContent = ''
  try {
    const data = await api('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token: challengeToken, code: $('#code').value }),
    })
    await finishAuthentication(data)
  } catch (error) {
    authError.textContent = error.message
  }
})

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = $('#message')
  const message = input.value.trim()
  if (!message) return
  input.value = ''
  try {
    const data = await api('/api/chat/message', {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
    render(data.messages)
  } catch (error) {
    chatError.textContent = error.message
  }
})

$('#cv').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  if (!file) return
  chatError.textContent = 'Uploading and reading your CV…'
  try {
    const data = await api('/api/chat/cv', {
      method: 'POST',
      body: file,
      headers: {
        'x-filename': encodeURIComponent(file.name),
        'content-type': file.type || 'application/octet-stream',
      },
    })
    chatError.textContent = ''
    render(data.messages)
  } catch (error) {
    chatError.textContent = error.message
  }
  event.target.value = ''
})

logout.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {})
  location.reload()
})

api('/api/session')
  .then((data) => {
    if (data.authenticated) {
      csrfToken = data.csrfToken
      return loadChat()
    }
  })
  .catch(() => {})

void loadAuthCapabilities()
