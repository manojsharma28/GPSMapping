import { WebSocketServer, type WebSocket } from 'ws'
import { Subscriber } from 'zeromq'

const socketPort = Number(process.env.WS_PORT || 4174)
const zmqEndpoint = process.env.ZMQ_ENDPOINT || 'tcp://127.0.0.1:5556'
const topic = process.env.ZMQ_TOPIC || ''
const wss = new WebSocketServer({ port: socketPort })
const clients = new Set<WebSocket>()

function broadcast(message: object) {
  const payload = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload)
  }
}

wss.on('connection', (client) => {
  clients.add(client)
  client.on('close', () => clients.delete(client))
  client.send(JSON.stringify({ type: 'status', upstream: 'connecting', message: `Connecting to ${zmqEndpoint}` }))
})

function parseCoordinateFrame(frame: Buffer): Record<string, unknown> | undefined {
  const text = frame.toString('utf8').trim()
  const candidates = [text, ...text.split(/\r?\n/).reverse()]
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      continue
    }
  }
}

function toFix(payload: Record<string, unknown>) {
  const nested = payload.position && typeof payload.position === 'object'
    ? payload.position as Record<string, unknown>
    : payload
  const latitude = Number(nested.latitude ?? nested.lat)
  const longitude = Number(nested.longitude ?? nested.lon ?? nested.lng)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined

  const id = String(payload.id ?? payload.deviceId ?? payload.device_id ?? payload.name ?? 'gps-device')
  const timestampValue = payload.timestamp ?? payload.time ?? new Date().toISOString()
  const timestamp = typeof timestampValue === 'number'
    ? new Date(timestampValue < 1e12 ? timestampValue * 1000 : timestampValue).toISOString()
    : String(timestampValue)
  const speed = Number(payload.speed)
  const heading = Number(payload.heading ?? payload.course)

  return {
    id,
    latitude,
    longitude,
    timestamp,
    ...(payload.label || payload.name ? { label: String(payload.label ?? payload.name) } : {}),
    ...(Number.isFinite(speed) ? { speed } : {}),
    ...(Number.isFinite(heading) ? { heading } : {}),
  }
}

async function runSubscriber() {
  const subscriber = new Subscriber()
  subscriber.receiveTimeout = 1000
  subscriber.connect(zmqEndpoint)
  subscriber.subscribe(topic)
  console.info(`ZeroMQ subscriber connecting to ${zmqEndpoint} (topic: ${topic || '<all>'})`)

  let isConnected = false
  while (!subscriber.closed) {
    try {
      const frames = await subscriber.receive()
      if (!isConnected) {
        isConnected = true
        broadcast({ type: 'status', upstream: 'connected', message: `Subscribed to ${zmqEndpoint}` })
        console.info(`ZeroMQ message received from ${zmqEndpoint}`)
      }
      const payload = parseCoordinateFrame(frames[frames.length - 1])
      const fix = payload && toFix(payload)
      if (fix) {
        broadcast({ type: 'fix', fix })
      } else {
        console.warn('Ignored ZeroMQ message without valid latitude/longitude coordinates')
      }
    } catch (error) {
      if (subscriber.closed) break
      if (error instanceof Error && error.message.includes('timed out')) continue
      const message = error instanceof Error ? error.message : String(error)
      if (isConnected) console.error(`ZeroMQ receive error: ${message}`)
      isConnected = false
      broadcast({ type: 'status', upstream: 'error', message: `ZeroMQ receive error: ${message}` })
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}

wss.on('listening', () => {
  console.info(`GPS WebSocket bridge listening on ws://localhost:${socketPort}`)
  broadcast({ type: 'status', upstream: 'connecting', message: `Connecting to ${zmqEndpoint}` })
  void runSubscriber().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Could not start ZeroMQ subscriber: ${message}`)
    broadcast({ type: 'status', upstream: 'error', message })
  })
})

wss.on('error', (error) => console.error(`WebSocket server error: ${error.message}`))
