import { createServer } from 'node:http'
import { Publisher } from 'zeromq'

const zmqBind = process.env.PUBLISHER_BIND || 'tcp://0.0.0.0:5556'
const httpHost = process.env.PUBLISHER_HTTP_HOST || '127.0.0.1'
const httpPort = Number(process.env.PUBLISHER_HTTP_PORT || 4175)
const allowedOrigins = new Set((process.env.PUBLISHER_CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()))
const publisher = new Publisher()

function sendJson(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, status: number, body: object) {
  const origin = request.headers.origin
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'Origin')
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function readJson(request: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16_384) {
        reject(new Error('Request body exceeds 16 KB'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Request body must be valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function validateCoordinate(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const nested = input.position && typeof input.position === 'object'
    ? input.position as Record<string, unknown>
    : input
  const latitude = Number(nested.latitude ?? nested.lat)
  const longitude = Number(nested.longitude ?? nested.lon ?? nested.lng)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined

  const id = String(input.id ?? input.deviceId ?? input.device_id ?? input.name ?? 'gps-device').trim()
  if (!id || id.length > 128) return undefined
  const timestampValue = input.timestamp ?? input.time ?? new Date().toISOString()
  const timestamp = typeof timestampValue === 'number'
    ? new Date(timestampValue < 1e12 ? timestampValue * 1000 : timestampValue).toISOString()
    : String(timestampValue)
  if (Number.isNaN(Date.parse(timestamp))) return undefined

  return {
    id,
    latitude,
    longitude,
    timestamp,
    ...(input.label || input.name ? { label: String(input.label ?? input.name) } : {}),
    ...(input.speed !== undefined ? { speed: Number(input.speed) } : {}),
    ...(input.heading !== undefined || input.course !== undefined ? { heading: Number(input.heading ?? input.course) } : {}),
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    const origin = request.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      })
      response.end()
      return
    }
    response.writeHead(403)
    response.end()
    return
  }
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(request, response, 200, { status: 'ok', zmq: zmqBind })
    return
  }
  if (request.method !== 'POST' || request.url !== '/coordinates') {
    sendJson(request, response, 404, { error: 'Use POST /coordinates or GET /health' })
    return
  }

  try {
    const fix = validateCoordinate(await readJson(request))
    if (!fix) {
      sendJson(request, response, 400, { error: 'Expected valid latitude (-90..90) and longitude (-180..180)' })
      return
    }
    await publisher.send(JSON.stringify(fix))
    console.info(`Published ${fix.id}: ${fix.latitude}, ${fix.longitude}`)
    sendJson(request, response, 202, { status: 'published', fix })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(request, response, 400, { error: message })
  }
})

async function start() {
  await publisher.bind(zmqBind)
  server.listen(httpPort, httpHost, () => {
    console.info(`ZeroMQ GPS publisher bound to ${zmqBind}`)
    console.info(`Coordinate input ready at http://${httpHost}:${httpPort}/coordinates`)
  })
}

async function stop() {
  server.close()
  await publisher.close()
  process.exit(0)
}

process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())

void start().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
