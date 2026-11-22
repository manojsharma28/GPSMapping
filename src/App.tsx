import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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

type PlannedRoute = {
  id: string
  label?: string
  positions: [number, number][]
}

type TrackBounds = {
  id: string
  label?: string
  start: { latitude: number; longitude: number }
  end: { latitude: number; longitude: number }
}

type FeedMessage =
  | { type: 'fix'; fix: GpsFix }
  | TrackBounds & { type: 'track-start' }
  | { type: 'status'; upstream: 'connecting' | 'connected' | 'error'; message?: string }

const socketUrl = import.meta.env.VITE_GPS_SOCKET_URL || 'ws://localhost:4174'
const coordinateApiUrl = import.meta.env.VITE_COORDINATE_API_URL || 'http://localhost:4175/coordinates'
const pathApiUrl = coordinateApiUrl.replace(/\/coordinates$/, '/paths')
const mdfPlaybackApiUrl = coordinateApiUrl.replace(/\/coordinates$/, '/mdf4')
const maxTrackPoints = 10_000
const maxRouteLocations = 100

const vehicleIcon = L.divIcon({
  className: 'vehicle-marker-wrap',
  html: '<span class="vehicle-marker"><span></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

function MapFollower({ fix, route, trackBounds }: { fix?: GpsFix; route?: PlannedRoute; trackBounds?: TrackBounds }) {
  const map = useMap()

  useEffect(() => {
    if (route) {
      map.fitBounds(L.latLngBounds(route.positions), { padding: [48, 48], maxZoom: 16 })
    } else if (trackBounds) {
      map.fitBounds(
        [
          [trackBounds.start.latitude, trackBounds.start.longitude],
          [trackBounds.end.latitude, trackBounds.end.longitude],
        ],
        { padding: [48, 48], maxZoom: 16 },
      )
    }
  }, [map, route, trackBounds])

  useEffect(() => {
    if (!route && !trackBounds && fix) {
      map.flyTo([fix.latitude, fix.longitude], Math.max(map.getZoom(), 14), { duration: 0.8 })
    }
  }, [fix, map, route, trackBounds])

  return null
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function parsePathCoordinates(value: string): Array<{ latitude: number; longitude: number }> {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.map((line, index) => {
    const parts = line.split(',').map((part) => part.trim())
    const latitude = Number(parts[0])
    const longitude = Number(parts[1])
    if (parts.length !== 2 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`Invalid coordinate on line ${index + 1}; use latitude, longitude within valid ranges`)
    }
    return { latitude, longitude }
  })
}

function App() {
  const [fixes, setFixes] = useState<GpsFix[]>([])
  const [plannedRoutes, setPlannedRoutes] = useState<PlannedRoute[]>([])
  const [trackBounds, setTrackBounds] = useState<TrackBounds | null>(null)
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [sourceStatus, setSourceStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [sourceMessage, setSourceMessage] = useState('Waiting for bridge')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sendState, setSendState] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [mdfPlaybackState, setMdfPlaybackState] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [mdfPlaybackFixes, setMdfPlaybackFixes] = useState<GpsFix[]>([])
  const [mdfPlaybackFixCount, setMdfPlaybackFixCount] = useState(0)
  const [isSending, setIsSending] = useState(false)
  const [isPlayingMdf, setIsPlayingMdf] = useState(false)
  const mdfPlaybackId = useRef<string | null>(null)

  async function playMdf4(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) {
      setMdfPlaybackState({ kind: 'error', message: 'Choose a non-empty MDF4 file' })
      return
    }

    const id = String(formData.get('id')).trim()
    const label = String(formData.get('label')).trim()
    const query = new URLSearchParams({
      id,
      speed: String(formData.get('speed')),
      ...(label ? { label } : {}),
    })
    const latitudeChannel = String(formData.get('latitudeChannel')).trim()
    const longitudeChannel = String(formData.get('longitudeChannel')).trim()
    if (latitudeChannel) query.set('latitudeChannel', latitudeChannel)
    if (longitudeChannel) query.set('longitudeChannel', longitudeChannel)

    setIsPlayingMdf(true)
    setMdfPlaybackState(null)
    mdfPlaybackId.current = id
    setMdfPlaybackFixes([])
    setMdfPlaybackFixCount(0)
    setSelectedId(id)
    setTrackBounds(null)
    setPlannedRoutes((current) => current.filter((route) => route.id !== id))
    try {
      const response = await fetch(`${mdfPlaybackApiUrl}?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const result = await response.json() as { error?: string; points?: number; latitudeChannel?: string; longitudeChannel?: string }
      if (!response.ok) throw new Error(result.error || `MDF4 playback returned HTTP ${response.status}`)
      setMdfPlaybackState({
        kind: 'success',
        message: `Played ${result.points} fixes (${result.latitudeChannel}, ${result.longitudeChannel})`,
      })
    } catch (error) {
      setMdfPlaybackState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not play MDF4 file' })
    } finally {
      setIsPlayingMdf(false)
    }
  }

  async function sendPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const id = String(formData.get('id')).trim()
    const label = String(formData.get('label')).trim() || undefined
    const start = {
      latitude: Number(formData.get('startLatitude')),
      longitude: Number(formData.get('startLongitude')),
    }
    const end = {
      latitude: Number(formData.get('endLatitude')),
      longitude: Number(formData.get('endLongitude')),
    }

    setIsSending(true)
    setSendState(null)
    try {
      const waypoints = parsePathCoordinates(String(formData.get('waypoints') || ''))
      const coordinates = [start, ...waypoints, end]
      if (coordinates.some(({ latitude, longitude }) => !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
        throw new Error('Start and end coordinates must be within valid latitude and longitude ranges')
      }
      if (coordinates.length > maxRouteLocations) {
        throw new Error(`A route can contain at most ${maxRouteLocations} coordinates`)
      }

      const response = await fetch(pathApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, label, start, end, waypoints }),
      })
      const result = await response.json() as { error?: string; id?: string; label?: string; positions?: [number, number][]; distance?: number }
      if (!response.ok) throw new Error(result.error || `Routing service returned HTTP ${response.status}`)
      if (!Array.isArray(result.positions) || result.positions.length < 2) throw new Error('Routing service returned no route geometry')
      if (result.positions.some((position) => !Array.isArray(position) || position.length !== 2
        || !Number.isFinite(position[0]) || position[0] < -90 || position[0] > 90
        || !Number.isFinite(position[1]) || position[1] < -180 || position[1] > 180)) {
        throw new Error('Routing service returned invalid route geometry')
      }

      const route: PlannedRoute = { id, label, positions: result.positions }
      setPlannedRoutes((current) => [...current.filter((item) => item.id !== id), route])
      setSelectedId(id)
      const distance = result.distance === undefined ? '' : ` (${(result.distance / 1000).toFixed(1)} km)`
      setSendState({ kind: 'success', message: `Road route found for ${id}${distance}` })
    } catch (error) {
      setSendState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not send path' })
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
          if (message.type === 'track-start') {
            setTrackBounds(message)
            setFixes((current) => current.filter((fix) => fix.id !== message.id))
            setPlannedRoutes((current) => current.filter((route) => route.id !== message.id))
            setSelectedId(message.id)
            if (message.id === mdfPlaybackId.current) {
              setMdfPlaybackFixes([])
              setMdfPlaybackFixCount(0)
            }
          }
          if (message.type === 'fix') {
            setFixes((current) => {
              return [message.fix, ...current].slice(0, maxTrackPoints * 40)
            })
            if (message.fix.id === mdfPlaybackId.current) {
              setMdfPlaybackFixes((current) => [...current, message.fix].slice(-maxTrackPoints))
              setMdfPlaybackFixCount((current) => current + 1)
            }
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
  const selectedRoute = plannedRoutes.find((route) => route.id === selectedId)
  const selectedTrackBounds = trackBounds?.id === selectedId ? trackBounds : undefined
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

          <details className="mdf4-playback" open>
            <summary><span>MDF4 GPS PLAYER</span><small>UPLOAD · PLAY</small></summary>
            <form className="coordinate-form mdf4-form" onSubmit={playMdf4}>
              <label className="form-field">
                <span>MDF4 file</span>
                <input name="file" type="file" accept=".mf4,.mdf4" required />
              </label>
              <details className="mdf4-options">
                <summary>Playback options</summary>
                <label className="form-field">
                  <span>Device ID</span>
                  <input name="id" type="text" defaultValue="mdf4-track" maxLength={128} required />
                </label>
                <label className="form-field">
                  <span>Label <small>OPTIONAL</small></span>
                  <input name="label" type="text" placeholder="Test drive" maxLength={128} />
                </label>
                <div className="coordinate-fields">
                  <label className="form-field">
                    <span>Latitude channel <small>AUTO</small></span>
                    <input name="latitudeChannel" type="text" placeholder="Latitude_2" maxLength={256} />
                  </label>
                  <label className="form-field">
                    <span>Longitude channel <small>AUTO</small></span>
                    <input name="longitudeChannel" type="text" placeholder="Longitude_2" maxLength={256} />
                  </label>
                </div>
                <label className="form-field">
                  <span>Playback speed <small>0 = AS FAST AS POSSIBLE</small></span>
                  <input name="speed" type="number" min="0" max="1000" step="any" defaultValue="10" required />
                </label>
              </details>
              <p className="mdf-playback-hint">Choose a file and play it. First and last fixes plus turns of at least 8° are sent through ZeroMQ and shown below.</p>
              <button className="send-coordinate-button" type="submit" disabled={isPlayingMdf}>
                <Send size={14} /> {isPlayingMdf ? 'Reading and playing…' : 'Play MDF4 file'}
              </button>
              {mdfPlaybackState && <p className={`send-feedback ${mdfPlaybackState.kind}`} role="status">{mdfPlaybackState.message}</p>}
              <section className="mdf-fix-list" aria-label="MDF4 GPS fixes sent through ZeroMQ">
                <div className="mdf-fix-list-heading">
                  <span>GPS FIXES SENT THROUGH ZEROMQ</span>
                  <small>{mdfPlaybackFixCount} FIXES</small>
                </div>
                {mdfPlaybackFixCount > maxTrackPoints && (
                  <p className="mdf-fix-note">Showing the latest {maxTrackPoints.toLocaleString()} of {mdfPlaybackFixCount.toLocaleString()} fixes.</p>
                )}
                {mdfPlaybackFixes.length > 0 ? (
                  <div className="mdf-fix-table-wrap">
                    <table className="mdf-fix-table">
                      <thead><tr><th>#</th><th>LATITUDE</th><th>LONGITUDE</th></tr></thead>
                      <tbody>
                        {mdfPlaybackFixes.map((fix, index) => (
                          <tr key={`${fix.timestamp}-${index}`}>
                            <td>{Math.max(1, mdfPlaybackFixCount - mdfPlaybackFixes.length + index + 1)}</td>
                            <td>{fix.latitude.toFixed(6)}</td>
                            <td>{fix.longitude.toFixed(6)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mdf-fix-empty">{isPlayingMdf ? 'Waiting for GPS fixes…' : 'Upload a file and press Play to see its GPS fixes.'}</p>
                )}
              </section>
            </form>
          </details>

          <form className="coordinate-form" onSubmit={sendPath}>
            <div className="form-heading">
              <span>FIND A ROAD ROUTE</span>
              <span>DRIVING</span>
            </div>
            <label className="form-field">
              <span>Device ID</span>
              <input name="id" type="text" placeholder="vehicle-01" maxLength={128} required />
            </label>
            <label className="form-field">
              <span>Label <small>OPTIONAL</small></span>
              <input name="label" type="text" placeholder="Field unit" maxLength={128} />
            </label>
            <div className="path-endpoint-heading">START</div>
            <div className="coordinate-fields">
              <label className="form-field">
                <span>Latitude</span>
                <input name="startLatitude" type="number" min="-90" max="90" step="any" placeholder="37.7749" required />
              </label>
              <label className="form-field">
                <span>Longitude</span>
                <input name="startLongitude" type="number" min="-180" max="180" step="any" placeholder="-122.4194" required />
              </label>
            </div>
            <div className="path-endpoint-heading">END</div>
            <div className="coordinate-fields">
              <label className="form-field">
                <span>Latitude</span>
                <input name="endLatitude" type="number" min="-90" max="90" step="any" placeholder="37.7849" required />
              </label>
              <label className="form-field">
                <span>Longitude</span>
                <input name="endLongitude" type="number" min="-180" max="180" step="any" placeholder="-122.4094" required />
              </label>
            </div>
            <label className="form-field waypoints-field">
              <span>Intermediate points <small>OPTIONAL</small></span>
              <textarea name="waypoints" rows={3} placeholder={'37.7780, -122.4160\n37.7810, -122.4130'} />
              <small>One latitude, longitude pair per line; the route follows roads through each point.</small>
            </label>
            <button className="send-coordinate-button" type="submit" disabled={isSending}>
              <Send size={14} /> {isSending ? 'Finding route…' : 'Find road route'}
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
                onClick={() => {
                  setTrackBounds(null)
                  setSelectedId(device.id)
                }}
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
              <strong>{selectedRoute?.label || selectedRoute?.id || selectedTrackBounds?.label || selectedTrackBounds?.id || (selectedFix ? selectedFix.label || selectedFix.id : 'Awaiting GPS coordinates')}</strong>
            </div>
            <div className="map-tools">
              <span className="map-updates"><SignalHigh size={15} /> {fixes.length} FIXES</span>
              <button
                className="map-action"
                type="button"
                title="Center map on selected device"
                aria-label="Center map on selected device"
                onClick={() => {
                  if (selectedFix) {
                    setTrackBounds(null)
                    setSelectedId(selectedFix.id)
                  }
                }}
              ><LocateFixed size={17} /></button>
            </div>
          </div>

          <div className="map-canvas">
            <MapContainer center={[37.7749, -122.4194]} zoom={4} scrollWheelZoom className="leaflet-map">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapFollower
                fix={selectedRoute || selectedTrackBounds ? undefined : selectedFix}
                route={selectedRoute}
                trackBounds={selectedTrackBounds}
              />
              {selectedRoute && (
                <Polyline
                  positions={selectedRoute.positions}
                  pathOptions={{ color: '#157a73', weight: 6, opacity: 0.88, lineCap: 'round', lineJoin: 'round' }}
                />
              )}
              {devices.map((device, index) => (
                <span key={device.id}>
                  {device.history.length > 1 && <Polyline positions={device.history.map((fix) => [fix.latitude, fix.longitude] as [number, number])} pathOptions={{ color: ['#db4e3f', '#157a73', '#cc8f30', '#577bb5', '#8d5b9c'][index % 5], weight: 3, opacity: 0.72 }} />}
                  <Marker position={[device.latest.latitude, device.latest.longitude]} icon={vehicleIcon} title={device.latest.label || device.id} />
                </span>
              ))}
            </MapContainer>
            {!selectedFix && !selectedRoute && !selectedTrackBounds && (
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
