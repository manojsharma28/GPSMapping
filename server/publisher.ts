import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Publisher } from 'zeromq'

const zmqBind = process.env.PUBLISHER_BIND || 'tcp://0.0.0.0:5556'
const httpHost = process.env.PUBLISHER_HTTP_HOST || '127.0.0.1'
const httpPort = Number(process.env.PUBLISHER_HTTP_PORT || 4175)
const routingApiUrl = process.env.ROUTING_API_URL || 'https://router.project-osrm.org/route/v1/driving'
const maxRouteLocations = 100
const maxMdfFileSize = 256 * 1024 * 1024
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mdf4PlayerProject = join(projectRoot, 'Mdf4Player', 'Mdf4Player.csproj')
const allowedOrigins = new Set((process.env.PUBLISHER_CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()))
const publisher = new Publisher()

class MdfUploadTooLargeError extends Error {}

class MdfPlaybackError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

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

type Coordinate = { latitude: number; longitude: number }

function validateTrackStart(value: unknown): {
  type: 'track-start'
  id: string
  label?: string
  start: Coordinate
  end: Coordinate
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const id = String(input.id ?? '').trim()
  if (!id || id.length > 128) return undefined
  const label = input.label ? String(input.label).trim() : undefined
  if (label && label.length > 128) return undefined

  const readCoordinate = (value: unknown): Coordinate | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const point = value as Record<string, unknown>
    const latitude = Number(point.latitude ?? point.lat)
    const longitude = Number(point.longitude ?? point.lon ?? point.lng)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined
    return { latitude, longitude }
  }

  const start = readCoordinate(input.start)
  const end = readCoordinate(input.end)
  if (!start || !end) return undefined
  return { type: 'track-start', id, ...(label ? { label } : {}), start, end }
}

function validatePath(value: unknown): { id: string; label?: string; coordinates: Coordinate[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const waypoints = input.waypoints ?? []
  if (!Array.isArray(waypoints)) return undefined
  const rawCoordinates = [input.start, ...waypoints, input.end]
  if (rawCoordinates.length < 2 || rawCoordinates.length > maxRouteLocations) return undefined

  const id = String(input.id ?? input.deviceId ?? input.device_id ?? input.name ?? 'gps-device').trim()
  if (!id || id.length > 128) return undefined
  const label = input.label || input.name ? String(input.label ?? input.name) : undefined
  const coordinates: Coordinate[] = []

  for (const coordinate of rawCoordinates) {
    if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)) return undefined
    const point = coordinate as Record<string, unknown>
    const latitude = Number(point.latitude ?? point.lat)
    const longitude = Number(point.longitude ?? point.lon ?? point.lng)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined
    coordinates.push({ latitude, longitude })
  }

  return { id, ...(label ? { label } : {}), coordinates }
}

async function saveMdfUpload(request: import('node:http').IncomingMessage, destination: string): Promise<number> {
  let size = 0
  const sizeLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > maxMdfFileSize) {
        callback(new MdfUploadTooLargeError(`MDF4 file exceeds the ${maxMdfFileSize / 1024 / 1024} MB upload limit`))
        return
      }
      callback(null, chunk)
    },
  })

  await pipeline(request, sizeLimit, createWriteStream(destination, { flags: 'wx' }))
  if (size === 0) throw new MdfPlaybackError('Uploaded MDF4 file is empty', 400)
  return size
}

type MdfPlaybackSummary = {
  status: 'published'
  id: string
  points: number
  latitudeChannel: string
  longitudeChannel: string
}

function runMdfPlayback(filePath: string, options: {
  id: string
  label?: string
  speed: number
  latitudeChannel?: string
  longitudeChannel?: string
  database?: string
}): Promise<MdfPlaybackSummary> {
  const publisherHost = httpHost === '0.0.0.0' ? '127.0.0.1' : httpHost === '::' ? '[::1]' : httpHost
  const publisherUrl = `http://${publisherHost}:${httpPort}/coordinates`
  const args = [
    'run',
    '--project',
    mdf4PlayerProject,
    '--no-launch-profile',
    '--',
    filePath,
    '--id', options.id,
    '--publisher-url', publisherUrl,
    '--speed', String(options.speed),
  ]
  if (options.label) args.push('--label', options.label)
  if (options.latitudeChannel) args.push('--latitude-channel', options.latitudeChannel)
  if (options.longitudeChannel) args.push('--longitude-channel', options.longitudeChannel)
  if (options.database) args.push('--database', options.database)

  return new Promise((resolvePlayback, rejectPlayback) => {
    const child = spawn('dotnet', args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-64_000)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-64_000)
    })
    child.once('error', (error) => {
      rejectPlayback(new MdfPlaybackError(`Could not start the .NET MDF4 player: ${error.message}`, 500))
    })
    child.once('close', (code, signal) => {
      if (code !== 0) {
        const detail = stderr.trim() || `MDF4 playback process exited with ${signal || `code ${code}`}`
        rejectPlayback(new MdfPlaybackError(detail, 422))
        return
      }
      try {
        const summary = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '') as MdfPlaybackSummary
        if (summary.status !== 'published' || !Number.isInteger(summary.points) || summary.points < 1) {
          throw new Error('MDF4 reader returned an invalid playback summary')
        }
        resolvePlayback(summary)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        rejectPlayback(new MdfPlaybackError(`Could not read MDF4 playback result: ${message}`, 500))
      }
    })
  })
}

async function handleMdfUpload(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  requestUrl: URL,
) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/octet-stream') {
    request.resume()
    sendJson(request, response, 415, { error: 'Upload the MDF4 file as application/octet-stream' })
    return
  }

  const declaredSize = Number(request.headers['content-length'])
  if (Number.isFinite(declaredSize) && declaredSize > maxMdfFileSize) {
    request.resume()
    sendJson(request, response, 413, { error: `MDF4 file exceeds the ${maxMdfFileSize / 1024 / 1024} MB upload limit` })
    return
  }

  const id = (requestUrl.searchParams.get('id') || 'mdf4-track').trim()
  const label = requestUrl.searchParams.get('label')?.trim() || undefined
  const speed = Number(requestUrl.searchParams.get('speed') ?? 10)
  const latitudeChannel = requestUrl.searchParams.get('latitudeChannel')?.trim() || undefined
  const longitudeChannel = requestUrl.searchParams.get('longitudeChannel')?.trim() || undefined
  if (!id || id.length > 128 || (label && label.length > 128)) {
    request.resume()
    sendJson(request, response, 400, { error: 'Device ID and label must be between 1 and 128 characters' })
    return
  }
  if (!Number.isFinite(speed) || speed < 0 || speed > 1000) {
    request.resume()
    sendJson(request, response, 400, { error: 'Playback speed must be between 0 and 1000' })
    return
  }
  if ((latitudeChannel && latitudeChannel.length > 256) || (longitudeChannel && longitudeChannel.length > 256)) {
    request.resume()
    sendJson(request, response, 400, { error: 'Channel names must be no longer than 256 characters' })
    return
  }

  const configuredDatabase = process.env.MDF4_DATABASE_FILE
  const defaultDatabase = join(projectRoot, 'server', 'data', 'gnss-middle.dbc')
  const database = configuredDatabase ? resolve(projectRoot, configuredDatabase) : defaultDatabase
  if (configuredDatabase && !existsSync(database)) {
    request.resume()
    sendJson(request, response, 500, { error: `Configured MDF4 DBC file was not found: ${database}` })
    return
  }

  let temporaryDirectory: string | undefined
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'gpsmapping-mdf4-'))
    const filePath = join(temporaryDirectory, 'upload.mf4')
    await saveMdfUpload(request, filePath)
    const summary = await runMdfPlayback(filePath, {
      id,
      ...(label ? { label } : {}),
      speed,
      ...(latitudeChannel ? { latitudeChannel } : {}),
      ...(longitudeChannel ? { longitudeChannel } : {}),
      ...(existsSync(database) ? { database } : {}),
    })
    console.info(`Played MDF4 GPS track ${summary.id}: ${summary.points} fixes`)
    sendJson(request, response, 200, summary)
  } catch (error) {
    const status = error instanceof MdfUploadTooLargeError
      ? 413
      : error instanceof MdfPlaybackError
        ? error.statusCode
        : 500
    const message = error instanceof Error ? error.message : String(error)
    console.error(`MDF4 playback failed: ${message}`)
    sendJson(request, response, status, { error: message })
  } finally {
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true })
      } catch (error) {
        console.error(`Could not remove temporary MDF4 upload ${temporaryDirectory}: ${String(error)}`)
      }
    }
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
  const requestUrl = new URL(request.url || '/', `http://${httpHost}`)
  if (request.method === 'POST' && requestUrl.pathname === '/mdf4') {
    await handleMdfUpload(request, response, requestUrl)
    return
  }
  if (request.method !== 'POST' || !['/coordinates', '/paths', '/track-start'].includes(requestUrl.pathname)) {
    sendJson(request, response, 404, { error: 'Use POST /coordinates, POST /paths, POST /track-start, POST /mdf4, or GET /health' })
    return
  }

  try {
    const body = await readJson(request)
    if (requestUrl.pathname === '/track-start') {
      const trackStart = validateTrackStart(body)
      if (!trackStart) {
        sendJson(request, response, 400, { error: 'Expected a device ID and valid start/end coordinates' })
        return
      }
      await publisher.send(JSON.stringify(trackStart))
      sendJson(request, response, 202, { status: 'track-started', id: trackStart.id })
      return
    }
    if (requestUrl.pathname === '/paths') {
      const fixes = validatePath(body)
      if (!fixes) {
        sendJson(request, response, 400, { error: `Expected start and end coordinates, up to ${maxRouteLocations - 2} waypoints, and valid latitude (-90..90) and longitude (-180..180)` })
        return
      }

      const coordinates = fixes.coordinates.map(({ latitude, longitude }) => `${longitude},${latitude}`).join(';')
      const routeUrl = `${routingApiUrl.replace(/\/$/, '')}/${coordinates}?overview=full&geometries=geojson&steps=false`
      const routeResponse = await fetch(routeUrl, { signal: AbortSignal.timeout(15_000) })
      if (!routeResponse.ok) {
        sendJson(request, response, 502, { error: `Routing service returned HTTP ${routeResponse.status}` })
        return
      }
      const routeResult: unknown = await routeResponse.json()
      if (!routeResult || typeof routeResult !== 'object') {
        sendJson(request, response, 502, { error: 'Routing service returned an invalid response' })
        return
      }
      const routeData = routeResult as Record<string, unknown>
      const routes = routeData.routes
      const firstRoute = Array.isArray(routes) ? routes[0] : undefined
      const geometry = firstRoute && typeof firstRoute === 'object'
        ? (firstRoute as Record<string, unknown>).geometry
        : undefined
      const routeCoordinates = geometry && typeof geometry === 'object'
        ? (geometry as Record<string, unknown>).coordinates
        : undefined
      if (routeData.code !== 'Ok' || !Array.isArray(routeCoordinates) || routeCoordinates.length < 2) {
        const message = typeof routeData.message === 'string' ? routeData.message : 'No drivable route was found for these coordinates'
        sendJson(request, response, 422, { error: message })
        return
      }

      const positions: [number, number][] = []
      for (const coordinate of routeCoordinates) {
        if (!Array.isArray(coordinate) || coordinate.length < 2) {
          sendJson(request, response, 502, { error: 'Routing service returned invalid route coordinates' })
          return
        }
        const [longitude, latitude] = coordinate
        if (typeof latitude !== 'number' || typeof longitude !== 'number'
          || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
          || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
          sendJson(request, response, 502, { error: 'Routing service returned invalid route coordinates' })
          return
        }
        positions.push([latitude, longitude])
      }

      const firstRouteData = firstRoute as Record<string, unknown>
      const distance = firstRouteData.distance
      console.info(`Calculated road route for ${fixes.id}: ${positions.length} points`)
      sendJson(request, response, 200, {
        status: 'routed',
        id: fixes.id,
        ...(fixes.label ? { label: fixes.label } : {}),
        positions,
        ...(typeof distance === 'number' && Number.isFinite(distance) ? { distance } : {}),
      })
      return
    }

    const fix = validateCoordinate(body)
    if (!fix) {
      sendJson(request, response, 400, { error: 'Expected valid latitude (-90..90) and longitude (-180..180)' })
      return
    }
    await publisher.send(JSON.stringify(fix))
    console.info(`Published ${fix.id}: ${fix.latitude}, ${fix.longitude}`)
    sendJson(request, response, 202, { status: 'published', fix })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(request, response, requestUrl.pathname === '/paths' ? 502 : 400, { error: message })
  }
})

async function start() {
  await publisher.bind(zmqBind)
  server.listen(httpPort, httpHost, () => {
    console.info(`ZeroMQ GPS publisher bound to ${zmqBind}`)
    console.info(`Coordinate input ready at http://${httpHost}:${httpPort}/coordinates`)
    console.info(`MDF4 reader: ${mdf4PlayerProject}`)
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
