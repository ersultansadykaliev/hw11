import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/'

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

type SignalingMessage =
  | { type: 'peer-left' }
  | { type: 'hello'; clientId: string }
  | { type: 'hello-ack'; clientId: string }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit; clientId: string }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit; clientId: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit; clientId: string }

type ConnectionPhase = 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'error'

function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function App() {
  const [phase, setPhase] = useState<ConnectionPhase>('connecting')
  const [statusText, setStatusText] = useState('Подключение...')
  const [mediaWarning, setMediaWarning] = useState('')
  const [hasAudio, setHasAudio] = useState(false)
  const [hasVideo, setHasVideo] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [camEnabled, setCamEnabled] = useState(true)
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [sessionKey, setSessionKey] = useState(0)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const clientIdRef = useRef<string>(createClientId())
  const peerIdRef = useRef<string | null>(null)
  const negotiatingWithRef = useRef<string | null>(null)

  const closePeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.onicecandidate = null
      pcRef.current.ontrack = null
      pcRef.current.onconnectionstatechange = null
      pcRef.current.close()
      pcRef.current = null
    }
    pendingCandidatesRef.current = []
    negotiatingWithRef.current = null
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    setHasRemoteStream(false)
  }, [])

  const sendSignal = useCallback((msg: Exclude<SignalingMessage, { type: 'peer-left' }>) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const createPeerConnection = useCallback(() => {
    closePeerConnection()

    const pc = new RTCPeerConnection(RTC_CONFIG)
    pcRef.current = pc

    const localStream = localStreamRef.current
    if (localStream && localStream.getTracks().length > 0) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream)
      }
      if (!localStream.getVideoTracks().length) {
        pc.addTransceiver('video', { direction: 'recvonly' })
      }
      if (!localStream.getAudioTracks().length) {
        pc.addTransceiver('audio', { direction: 'recvonly' })
      }
    } else {
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
          clientId: clientIdRef.current,
        })
      }
    }

    pc.ontrack = (event) => {
      const videoEl = remoteVideoRef.current
      if (!videoEl) return

      if (event.streams[0]) {
        videoEl.srcObject = event.streams[0]
      } else {
        const currentStream =
          videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : new MediaStream()
        currentStream.addTrack(event.track)
        videoEl.srcObject = currentStream
      }
      setHasRemoteStream(true)
    }

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected':
          setPhase('connected')
          setStatusText('Собеседник подключён')
          break
        case 'connecting':
          setPhase('connecting')
          setStatusText('Установка WebRTC-соединения...')
          break
        case 'disconnected':
        case 'failed':
          setPhase('waiting')
          setStatusText('Соединение потеряно, ожидание...')
          break
      }
    }

    return pc
  }, [closePeerConnection, sendSignal])

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queue = pendingCandidatesRef.current
    pendingCandidatesRef.current = []
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        // Ignore stale candidates from a previous negotiation
      }
    }
  }, [])

  const startOffer = useCallback(
    async (remotePeerId: string) => {
      if (negotiatingWithRef.current === remotePeerId && pcRef.current) return
      negotiatingWithRef.current = remotePeerId

      const pc = createPeerConnection()
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      if (pc.localDescription) {
        sendSignal({
          type: 'offer',
          sdp: pc.localDescription.toJSON(),
          clientId: clientIdRef.current,
        })
      }
    },
    [createPeerConnection, sendSignal],
  )

  useEffect(() => {
    let active = true
    const localVideoEl = localVideoRef.current
    clientIdRef.current = createClientId()
    peerIdRef.current = null

    const acquireMedia = async (): Promise<MediaStream | null> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMediaWarning('Браузер не поддерживает доступ к камере и микрофону (режим только просмотра).')
        return null
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        setMediaWarning('')
        setHasAudio(stream.getAudioTracks().length > 0)
        setHasVideo(stream.getVideoTracks().length > 0)
        setMicEnabled(true)
        setCamEnabled(true)
        return stream
      } catch {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true })
          setMediaWarning('Камера недоступна — используется только микрофон.')
          setHasAudio(audioOnly.getAudioTracks().length > 0)
          setHasVideo(false)
          setMicEnabled(true)
          setCamEnabled(false)
          return audioOnly
        } catch {
          setMediaWarning('Нет доступа к камере и микрофону (режим только просмотра).')
          setHasAudio(false)
          setHasVideo(false)
          setMicEnabled(false)
          setCamEnabled(false)
          return null
        }
      }
    }

    const start = async () => {
      setPhase('connecting')
      setStatusText('Запрос доступа к камере и микрофону...')

      const stream = await acquireMedia()
      if (!active) {
        stream?.getTracks().forEach((t) => t.stop())
        return
      }

      localStreamRef.current = stream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      setStatusText('Подключение к signaling-серверу...')
      const ws = new WebSocket(SIGNALING_URL)
      wsRef.current = ws

      ws.onopen = () => {
        if (!active) {
          ws.close()
          return
        }
        setPhase('waiting')
        setStatusText('Ожидание собеседника...')
        sendSignal({ type: 'hello', clientId: clientIdRef.current })
      }

      ws.onmessage = async (event) => {
        if (!active) return

        let data: SignalingMessage
        try {
          data = JSON.parse(String(event.data)) as SignalingMessage
        } catch {
          return
        }

        if (data.type === 'peer-left') {
          peerIdRef.current = null
          closePeerConnection()
          setPhase('waiting')
          setStatusText('Собеседник отключился. Ожидание нового подключения...')
          return
        }

        if (data.clientId === clientIdRef.current) return

        if (data.type === 'hello') {
          peerIdRef.current = data.clientId
          sendSignal({ type: 'hello-ack', clientId: clientIdRef.current })
          if (clientIdRef.current > data.clientId) {
            await startOffer(data.clientId)
          }
          return
        }

        if (data.type === 'hello-ack') {
          peerIdRef.current = data.clientId
          if (clientIdRef.current > data.clientId) {
            await startOffer(data.clientId)
          }
          return
        }

        if (data.type === 'offer') {
          peerIdRef.current = data.clientId
          negotiatingWithRef.current = data.clientId
          const pc = createPeerConnection()
          await pc.setRemoteDescription(data.sdp)
          await flushPendingCandidates(pc)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          if (pc.localDescription) {
            sendSignal({
              type: 'answer',
              sdp: pc.localDescription.toJSON(),
              clientId: clientIdRef.current,
            })
          }
          return
        }

        if (data.type === 'answer') {
          const pc = pcRef.current
          if (!pc) return
          await pc.setRemoteDescription(data.sdp)
          await flushPendingCandidates(pc)
          return
        }

        if (data.type === 'ice-candidate') {
          const pc = pcRef.current
          if (pc && pc.remoteDescription) {
            try {
              await pc.addIceCandidate(data.candidate)
            } catch {
              // Ignore invalid/late candidate
            }
          } else {
            pendingCandidatesRef.current.push(data.candidate)
          }
        }
      }

      ws.onerror = () => {
        if (!active) return
        setPhase('error')
        setStatusText('Ошибка WebSocket-соединения')
      }

      ws.onclose = () => {
        if (!active) return
        peerIdRef.current = null
        closePeerConnection()
        setPhase('disconnected')
        setStatusText('Отключено от сервера (возможно, подключился другой участник)')
      }
    }

    void start()

    return () => {
      active = false
      if (wsRef.current) {
        wsRef.current.onopen = null
        wsRef.current.onmessage = null
        wsRef.current.onerror = null
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
      closePeerConnection()
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop())
        localStreamRef.current = null
      }
      if (localVideoEl) {
        localVideoEl.srcObject = null
      }
    }
  }, [closePeerConnection, createPeerConnection, flushPendingCandidates, sendSignal, sessionKey, startOffer])

  const toggleMic = () => {
    const stream = localStreamRef.current
    if (!stream) return
    const tracks = stream.getAudioTracks()
    if (!tracks.length) return
    const next = !micEnabled
    tracks.forEach((t) => {
      t.enabled = next
    })
    setMicEnabled(next)
  }

  const toggleCam = () => {
    const stream = localStreamRef.current
    if (!stream) return
    const tracks = stream.getVideoTracks()
    if (!tracks.length) return
    const next = !camEnabled
    tracks.forEach((t) => {
      t.enabled = next
    })
    setCamEnabled(next)
  }

  const handleReconnect = () => {
    setSessionKey((prev) => prev + 1)
  }

  const handleHangup = () => {
    if (wsRef.current) {
      wsRef.current.close()
    }
    closePeerConnection()
    setPhase('disconnected')
    setStatusText('Звонок завершён')
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Видеособеседование 1 на 1</h1>
        <span className={`status ${phase}`}>{statusText}</span>
      </header>

      {mediaWarning && <div className="warning">{mediaWarning}</div>}

      <section className="videos">
        <div className="video-card">
          <video ref={localVideoRef} className="local-video" autoPlay muted playsInline />
          <span className="video-label">Вы</span>
        </div>

        <div className="video-card">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <span className="video-label">
            {hasRemoteStream ? 'Собеседник' : 'Собеседник (ожидание видео...)'}
          </span>
        </div>
      </section>

      <footer className="controls">
        <button
          type="button"
          className={micEnabled ? '' : 'off'}
          onClick={toggleMic}
          disabled={!hasAudio}
        >
          {micEnabled ? 'Выкл. микрофон' : 'Вкл. микрофон'}
        </button>

        <button
          type="button"
          className={camEnabled ? '' : 'off'}
          onClick={toggleCam}
          disabled={!hasVideo}
        >
          {camEnabled ? 'Выкл. камеру' : 'Вкл. камеру'}
        </button>

        {phase === 'disconnected' || phase === 'error' ? (
          <button type="button" className="primary" onClick={handleReconnect}>
            Переподключиться
          </button>
        ) : (
          <button type="button" className="off" onClick={handleHangup}>
            Завершить
          </button>
        )}
      </footer>
    </main>
  )
}

export default App
