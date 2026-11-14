const args = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < args.length; index += 1) {
  const key = args[index]
  if (key.startsWith('--') && args[index + 1] && !args[index + 1].startsWith('--')) {
    options.set(key.slice(2), args[index + 1])
    index += 1
  }
}

let fix: Record<string, unknown>
const jsonArgument = args.find((argument) => argument.startsWith('{'))
if (jsonArgument) {
  try {
    fix = JSON.parse(jsonArgument) as Record<string, unknown>
  } catch {
    console.error('Coordinate JSON argument is invalid')
    process.exit(1)
  }
} else {
  const positional = args.filter((argument) => !argument.startsWith('--'))
  const coordinateParts = (process.env.GPS_COORDINATE ?? positional[0] ?? '').split(',')
  const latitude = Number(options.get('lat') ?? options.get('latitude') ?? coordinateParts[0] ?? positional[0])
  const longitude = Number(options.get('lon') ?? options.get('lng') ?? options.get('longitude') ?? coordinateParts[1] ?? positional[1])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    console.error('Usage: npm run send:coordinate -- 37.7749,-122.4194,vehicle-07')
    console.error('Alternative: npx tsx scripts/send-coordinate.ts --id vehicle-07 --lat 37.7749 --lon -122.4194')
    process.exit(1)
  }

  fix = {
    id: options.get('id') || coordinateParts[2] || positional[2] || 'gps-device',
    label: options.get('label'),
    latitude,
    longitude,
    timestamp: new Date().toISOString(),
    ...(options.has('speed') ? { speed: Number(options.get('speed')) } : {}),
    ...(options.has('heading') ? { heading: Number(options.get('heading')) } : {}),
  }
}

const endpoint = process.env.PUBLISHER_HTTP_URL || 'http://127.0.0.1:4175/coordinates'
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(fix),
})
const result = await response.json() as { status?: string; error?: string; fix?: { id?: string; latitude?: number; longitude?: number } }
if (!response.ok) {
  console.error(result.error || `Publisher returned HTTP ${response.status}`)
  process.exit(1)
}
console.info(`Coordinate ${result.status}: ${result.fix?.id} ${result.fix?.latitude}, ${result.fix?.longitude}`)
