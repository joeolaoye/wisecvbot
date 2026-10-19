/* global Blob, URLSearchParams, document, fetch, history, location */

const $ = (selector) => document.querySelector(selector)
const auth = $('#auth')
const chat = $('#chat')
const logout = $('#logout')
const messages = $('#messages')
const authError = $('#auth-error')
const chatError = $('#chat-error')
let csrfToken = ''

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
    }
    if (capabilities.telegramUrl) {
      const telegramChip = $('#telegram-chip')
      telegramChip.href = capabilities.telegramUrl
      telegramChip.classList.remove('hidden')
    }
  } catch {
    // Keep unavailable sign-in methods hidden when capabilities cannot be loaded.
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
