import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

const API_URL = 'https://inai-col3.fishrungames.com'
const CHAT_URL = 'wss://inai-col3.fishrungames.com/chat/'

type Profile = {
  first_name: string
  bio: string
}

type User = {
  id: number
  username: string
  profile: Profile
}

type TokenResponse = { access: string; user?: User }
type ChatMessage = {
  sender: string
  text: string
  timestamp: number
}
type ChatEvent =
  | { type: 'AUTH_SUCCESS'; payload: { username: string } }
  | { type: 'NEW_MESSAGE'; payload: ChatMessage }

let accessToken: string | null = null

function setAccessToken(token: string | null) {
  accessToken = token
}

function getErrorMessage(body: unknown, status: number) {
  if (body && typeof body === 'object') {
    const values = Object.values(body)
    const detail = 'detail' in body ? body.detail : values[0]
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && typeof detail[0] === 'string') return detail[0]
  }
  return `Ошибка ${status}`
}

async function refreshAccessToken() {
  const response = await fetch(`${API_URL}/api/token/refresh/`, {
    method: 'POST',
    credentials: 'include',
  })
  const body = await response.json().catch(() => null) as TokenResponse | null
  if (!response.ok || !body?.access) {
    throw new Error(getErrorMessage(body, response.status))
  }
  setAccessToken(body.access)
  return body.access
}

async function request<T>(path: string, options: RequestInit = {}, canRefresh = true): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  })
  if (response.status === 401 && canRefresh && path !== '/api/token/refresh/' && path !== '/api/login/' && path !== '/api/register/') {
    await refreshAccessToken()
    return request<T>(path, options, false)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(getErrorMessage(body, response.status))
  }
  return response.status === 204 ? ({} as T) : response.json()
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileMessage, setProfileMessage] = useState('')
  const [profileError, setProfileError] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [chatStatus, setChatStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [chatError, setChatError] = useState('')
  const chatSocket = useRef<WebSocket | null>(null)

  useEffect(() => {
    const restoreSession = async () => {
      try {
        await refreshAccessToken()
        setUser(await request<User>('/api/profile/'))
      } catch {
        setAccessToken(null)
      }
    }

    Promise.all([
      restoreSession(),
    ]).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!user || !accessToken) return

    const socket = new WebSocket(CHAT_URL)
    chatSocket.current = socket

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'AUTH',
        payload: { token: accessToken },
      }))
    }

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ChatEvent
        if (message.type === 'AUTH_SUCCESS') {
          setChatStatus('connected')
          return
        }
        if (message.type === 'NEW_MESSAGE') {
          setChatMessages((messages) => [...messages, message.payload])
        }
      } catch {
        setChatError('Сервер прислал некорректный ответ')
      }
    }

    socket.onerror = () => {
      setChatStatus('error')
      setChatError('Не удалось подключиться к чату')
    }

    socket.onclose = () => {
      chatSocket.current = null
      setChatStatus((status) => status === 'connected' ? 'error' : status)
    }

    return () => {
      socket.close()
      chatSocket.current = null
    }
  }, [user])

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthLoading(true)
    setAuthError('')
    const form = new FormData(event.currentTarget)
    try {
      const path = authMode === 'login' ? '/api/login/' : '/api/register/'
      const result = await request<TokenResponse>(path, {
        method: 'POST',
        body: JSON.stringify({
          username: form.get('username'),
          password: form.get('password'),
        }),
      })
      setAccessToken(result.access)
      setChatStatus('connecting')
      setChatError('')
      setChatMessages([])
      setUser(result.user || await request<User>('/api/profile/'))
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Не удалось выполнить запрос')
    } finally {
      setAuthLoading(false)
    }
  }

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user) return
    setProfileLoading(true)
    setProfileError('')
    setProfileMessage('')
    const form = new FormData(event.currentTarget)
    try {
      const updated = await request<User>('/api/profile/', {
        method: 'PATCH',
        body: JSON.stringify({
          first_name: form.get('first_name'),
          bio: form.get('bio'),
        }),
      })
      setUser(updated)
      setProfileMessage('Профиль обновлён')
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось сохранить изменения')
    } finally {
      setProfileLoading(false)
    }
  }

  const logout = async () => {
    try {
      await request('/api/logout/', { method: 'POST' })
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось выйти')
    } finally {
      setAccessToken(null)
      setUser(null)
      setAuthMode('login')
    }
  }

  const sendChatMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = chatText.trim()
    if (!text || chatSocket.current?.readyState !== WebSocket.OPEN || chatStatus !== 'connected') return

    chatSocket.current.send(JSON.stringify({
      type: 'CHAT_MESSAGE',
      payload: { text },
    }))
    setChatText('')
  }

  if (loading) {
    return <div className="loading-screen"><div className="loader-ring" /><p>Настраиваем звук<span>...</span></p></div>
  }

  return (
    <main>
      <header className="topbar">
        <div className="header-action">
          {user && <span className="user-name">{user.username}</span>}
        </div>
      </header>

      {user ? (
        <section className="dashboard-section">
          <div className="profile-section" id="profile">
            <div className="profile-header"><div><p className="eyebrow">Личный кабинет</p><h1>Мой профиль</h1><p className="profile-intro">Просматривайте и редактируйте данные своего профиля.</p></div><button className="outline-button" onClick={logout}>Выйти</button></div>
            <form className="profile-form" onSubmit={saveProfile}>
              <label>Имя / псевдоним<input name="first_name" defaultValue={user.profile?.first_name} placeholder="Как тебя зовут?" maxLength={100} /></label>
              <label className="full-field">О себе<textarea name="bio" defaultValue={user.profile?.bio} placeholder="Расскажи о себе..." rows={4} /></label>
              <div className="form-actions"><button className="primary-button" type="submit" disabled={profileLoading}>{profileLoading ? 'Сохраняем...' : 'Сохранить изменения'} <span>↗</span></button>{profileMessage && <span className="success-message">{profileMessage}</span>}{profileError && <span className="error-message">{profileError}</span>}</div>
            </form>
          </div>
          <section className="chat-section" id="chat">
            <div className="chat-header"><div><p className="eyebrow">Общий канал</p><h2>Групповой чат</h2></div><span className={`chat-status ${chatStatus}`}>{chatStatus === 'connected' ? 'В сети' : chatStatus === 'connecting' ? 'Подключение...' : 'Нет связи'}</span></div>
            <div className="chat-messages" aria-live="polite">
              {chatMessages.length === 0 && <p className="chat-empty">{chatStatus === 'connected' ? 'Здесь пока тихо. Напишите первым.' : 'Подключаемся к чату...'}</p>}
              {chatMessages.map((message, index) => <article className="chat-message" key={`${message.timestamp}-${index}`}><div><strong>{message.sender}</strong><time>{new Date(message.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></article>)}
            </div>
            {chatError && <p className="error-message">{chatError}</p>}
            <form className="chat-form" onSubmit={sendChatMessage}><input value={chatText} onChange={(event) => setChatText(event.target.value)} disabled={chatStatus !== 'connected'} placeholder="Напишите сообщение..." maxLength={1000} /><button className="primary-button" type="submit" disabled={chatStatus !== 'connected' || !chatText.trim()}>Отправить <span>↗</span></button></form>
          </section>
        </section>
      ) : (
        <section className="auth-section" id="auth">
          <div className="auth-grid">
            <div><p className="eyebrow">Профиль пользователя</p><h1>Добро<br /><em>пожаловать.</em></h1><p>Войдите или зарегистрируйтесь, чтобы общаться в групповом чате.</p></div>
            <div className="auth-card">
              <div className="auth-tabs"><button className={authMode === 'login' ? 'active' : ''} onClick={() => { setAuthMode('login'); setAuthError('') }}>Войти</button><button className={authMode === 'register' ? 'active' : ''} onClick={() => { setAuthMode('register'); setAuthError('') }}>Регистрация</button></div>
              <form onSubmit={submitAuth}><label>Логин<input name="username" required autoComplete="username" placeholder="your_name" /></label><label>Пароль<input name="password" required minLength={6} type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} placeholder="••••••••" /></label>{authError && <p className="error-message">{authError}</p>}<button className="primary-button form-submit" type="submit" disabled={authLoading}>{authLoading ? 'Подождите...' : authMode === 'login' ? 'Войти в кабинет' : 'Создать профиль'} <span>↗</span></button></form>
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
