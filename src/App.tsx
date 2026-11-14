import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Circle, Layers3, LocateFixed, MapPin, Radio, Send, Signal, SignalHigh } from 'lucide-react'
import L from 'leaflet'
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet'
import './App.css'

type GpsFix = {
  id: string
  latitude: number
  longitude: number
  timestamp: string
  label?: string
  speed?: number
  heading?: number
}

type FeedMessage =
  | { type: 'fix'; fix: GpsFix }
  | { type: 'status'; upstream: 'connecting' | 'connected' | 'error'; message?: string }

const socketUrl = import.meta.env.VITE_GPS_SOCKET_URL || 'ws://localhost:4174'
const coordinateApiUrl = import.meta.env.VITE_COORDINATE_API_URL || 'http://localhost:4175/coordinates'
const maxTrackPoints = 160

const vehicleIcon = L.divIcon({
  className: 'vehicle-marker-wrap',
  html: '<span class="vehicle-marker"><span></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

function MapFollower({ fix }: { fix?: GpsFix }) {
  const map = useMap()

  useEffect(() => {
    if (fix) map.flyTo([fix.latitude, fix.longitude], Math.max(map.getZoom(), 14), { duration: 0.8 })
  }, [fix, map])

  return null
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function App() {
  const [fixes, setFixes] = useState<GpsFix[]>([])
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [sourceStatus, setSourceStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [sourceMessage, setSourceMessage] = useState('Waiting for bridge')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sendState, setSendState] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [isSending, setIsSending] = useState(false)

  async function sendCoordinate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const payload = {
      id: String(formData.get('id')).trim(),
      label: String(formData.get('label')).trim() || undefined,
      latitude: Number(formData.get('latitude')),
      longitude: Number(formData.get('longitude')),
      timestamp: new Date().toISOString(),
    }

    setIsSending(true)
    setSendState(null)
    try {
      const response = await fetch(coordinateApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || `Publisher returned HTTP ${response.status}`)
      setSendState({ kind: 'success', message: `Sent ${payload.id} to ZeroMQ` })
    } catch (error) {
      setSendState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not send coordinate' })
    } finally {
      setIsSending(false)
    }
  }

  useEffect(() => {
    let active = true
    let retryTimer: number | undefined
    let socket: WebSocket | undefined

    const connect = () => {
      if (!active) return
      setSocketStatus('connecting')
      socket = new WebSocket(socketUrl)
      socket.onopen = () => active && setSocketStatus('connected')
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as FeedMessage
          if (message.type === 'status') {
            setSourceStatus(message.upstream)
            setSourceMessage(message.message || (message.upstream === 'connected' ? 'ZeroMQ source connected' : 'Waiting for source'))
          }
          if (message.type === 'fix') {
            setFixes((current) => {
              const next = [message.fix, ...current.filter((fix) => fix.id !== message.fix.id)].slice(0, 40)
              return next
            })
            setSelectedId((current) => current ?? message.fix.id)
          }
        } catch {
          setSourceMessage('Received an unreadable bridge message')
        }
      }
      socket.onclose = () => {
        if (!active) return
        setSocketStatus('offline')
        retryTimer = window.setTimeout(connect, 1800)
      }
      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      active = false
      window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  const devices = useMemo(() => {
    const byId = new Map<string, GpsFix[]>()
    for (const fix of [...fixes].reverse()) {
      const history = byId.get(fix.id) || []
      history.push(fix)
      byId.set(fix.id, history.slice(-maxTrackPoints))
    }
    return [...byId.entries()].map(([id, history]) => ({ id, latest: history[history.length - 1], history }))
  }, [fixes])
  const selectedDevice = devices.find((device) => device.id === selectedId) ?? devices[0]
  const selectedFix = selectedDevice?.latest
  const sourceIsLive = socketStatus === 'connected' && sourceStatus === 'connected'

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Field Atlas home">
          <span className="brand-mark"><MapPin size={19} strokeWidth={2.5} /></span>
          <span>FIELD<span className="brand-light">ATLAS</span></span>
        </a>
        <div className="topbar-right">
          <div className={`connection-pill ${sourceIsLive ? 'is-live' : ''}`}>
            <span className="connection-dot" />
            {sourceIsLive ? 'LIVE FEED' : socketStatus === 'offline' ? 'BRIDGE OFFLINE' : 'CONNECTING'}
          </div>
          <span className="topbar-caption">GPS MONITOR</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">OPERATIONS / TRACKING</p>
              <h1>Live positions</h1>
            </div>
            <span className="device-count">{devices.length.toString().padStart(2, '0')}</span>
          </div>

          <div className="source-status">
            <div className={`source-icon ${sourceIsLive ? 'source-icon-live' : ''}`}><Radio size={16} /></div>
            <div className="source-copy">
              <strong>Coordinate source</strong>
              <span>{socketStatus === 'offline' ? 'WebSocket reconnecting' : sourceMessage}</span>
            </div>
            <span className={`source-indicator ${sourceIsLive ? 'online' : ''}`} />
          </div>

          <form className="coordinate-form" onSubmit={sendCoordinate}>
            <div className="form-heading">
              <span>SEND A POSITION</span>
              <span>ZERO MQ</span>
            </div>
            <label className="form-field">
              <span>Device ID</span>
              <input name="id" type="text" placeholder="vehicle-01" maxLength={128} required />
            </label>
            <label className="form-field">
              <span>Label <small>OPTIONAL</small></span>
              <input name="label" type="text" placeholder="Field unit" maxLength={128} />
            </label>
            <div className="coordinate-fields">
              <label className="form-field">
                <span>Latitude</span>
                <input name="latitude" type="number" min="-90" max="90" step="any" placeholder="37.7749" required />
              </label>
              <label className="form-field">
                <span>Longitude</span>
                <input name="longitude" type="number" min="-180" max="180" step="any" placeholder="-122.4194" required />
              </label>
            </div>
            <button className="send-coordinate-button" type="submit" disabled={isSending}>
              <Send size={14} /> {isSending ? 'Sending…' : 'Send coordinate'}
            </button>
            {sendState && <p className={`send-feedback ${sendState.kind}`} role="status">{sendState.message}</p>}
          </form>

          <div className="section-label">
            <span>TRACKED DEVICES</span>
            <span>{devices.length} ACTIVE</span>
          </div>

          <div className="device-list">
            {devices.length === 0 ? (
              <div className="empty-devices">
                <div className="empty-icon"><LocateFixed size={19} /></div>
                <strong>Nothing on the map yet</strong>
                <span>New GPS positions appear here as they arrive from the feed.</span>
              </div>
            ) : devices.map((device, index) => (
              <button
                className={`device-row ${selectedDevice?.id === device.id ? 'selected' : ''}`}
                key={device.id}
                onClick={() => setSelectedId(device.id)}
                type="button"
              >
                <span className={`device-swatch swatch-${index % 5}`}><LocateFixed size={16} /></span>
                <span className="device-info">
                  <strong>{device.latest.label || device.id}</strong>
                  <span>{device.latest.latitude.toFixed(5)}, {device.latest.longitude.toFixed(5)}</span>
                </span>
                <span className="device-time">{formatTime(device.latest.timestamp)}</span>
              </button>
            ))}
          </div>

          <div className="sidebar-footer">
            <div className="footer-icon"><Layers3 size={15} /></div>
            <div><span>MAP LAYER</span><strong>OpenStreetMap</strong></div>
          </div>
        </aside>

        <section className="map-panel" aria-label="Live GPS map">
          <div className="map-topline">
            <div className="map-title">
              <span className="map-kicker"><Signal size={14} /> REAL-TIME VIEW</span>
              <strong>{selectedFix ? selectedFix.label || selectedFix.id : 'Awaiting GPS coordinates'}</strong>
            </div>
            <div className="map-tools">
              <span className="map-updates"><SignalHigh size={15} /> {fixes.length} FIXES</span>
              <button
                className="map-action"
                type="button"
                title="Center map on selected device"
                aria-label="Center map on selected device"
                onClick={() => selectedFix && setSelectedId(selectedFix.id)}
              ><LocateFixed size={17} /></button>
            </div>
          </div>

          <div className="map-canvas">
            <MapContainer center={[37.7749, -122.4194]} zoom={4} scrollWheelZoom className="leaflet-map">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapFollower fix={selectedFix} />
              {devices.map((device, index) => (
                <span key={device.id}>
                  {device.history.length > 1 && <Polyline positions={device.history.map((fix) => [fix.latitude, fix.longitude] as [number, number])} pathOptions={{ color: ['#db4e3f', '#157a73', '#cc8f30', '#577bb5', '#8d5b9c'][index % 5], weight: 3, opacity: 0.72 }} />}
                  <Marker position={[device.latest.latitude, device.latest.longitude]} icon={vehicleIcon} title={device.latest.label || device.id} />
                </span>
              ))}
            </MapContainer>
            {!selectedFix && (
              <div className="map-empty-state">
                <div className="radar-mark"><Circle size={31} /><span /></div>
                <strong>Map is ready</strong>
                <span>Listening for the first coordinate</span>
              </div>
            )}
            <div className="map-scale-note">WGS 84 <span /> LAT / LON</div>
          </div>

          <footer className="map-footer">
            <div className="coordinate-readout">
              <span className="readout-icon"><LocateFixed size={15} /></span>
              <div><span>SELECTED POSITION</span><strong>{selectedFix ? `${selectedFix.latitude.toFixed(6)}, ${selectedFix.longitude.toFixed(6)}` : 'No position received'}</strong></div>
            </div>
            <div className="last-update"><span>LAST UPDATE</span><strong>{selectedFix ? formatTime(selectedFix.timestamp) : '—'}</strong></div>
          </footer>
        </section>
      </section>
    </main>
  )
}

export default App
