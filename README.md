# Field Atlas GPS Monitor

A live GPS tracking web app. The React + Leaflet browser client receives position updates over WebSocket. A Node.js bridge subscribes to ZeroMQ GPS messages and relays validated fixes to the map. This workspace also includes a local ZeroMQ publisher and coordinate sender for testing or feeding coordinates from another application.

## Requirements

- Node.js 20.19+ or 22.12+
- .NET 9 SDK
- npm

The MDF4 player is implemented in C# and uses the .NET 9 SDK; no Python installation or Python packages are needed for playback. Python is only needed if you choose to run the optional MDF4 demo-generation script.

## Start the complete local stack

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`. The defaults run the included publisher locally on ZeroMQ port `5556`, the coordinate input on HTTP port `4175`, and the browser bridge on WebSocket port `4174`.
3. Start all services: `npm run dev`
4. Open the Vite URL shown in the terminal, normally `http://localhost:5173`.
5. Send a coordinate from another PowerShell terminal:

```powershell
$env:GPS_COORDINATE = '37.7749,-122.4194,vehicle-07'
npm run send:coordinate
```

The marker should appear on the map. Change the coordinates and send again with the same device ID to draw a track. The sender also accepts JSON or flags when called directly with `npx tsx scripts/send-coordinate.ts --id vehicle-07 --lat 37.7749 --lon -122.4194`.

## Send coordinates over HTTP

The included publisher accepts `POST /coordinates` at `http://127.0.0.1:4175/coordinates`. It publishes valid requests to ZeroMQ. For example, from PowerShell:

```powershell
$fix = @{
  id = 'vehicle-07'
  label = 'North crew'
  latitude = 37.7749
  longitude = -122.4194
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  speed = 12.4
  heading = 92
} | ConvertTo-Json

Invoke-RestMethod -Uri 'http://127.0.0.1:4175/coordinates' -Method Post -ContentType 'application/json' -Body $fix
```

The endpoint returns HTTP `202` after publishing. `GET http://127.0.0.1:4175/health` reports whether the publisher's HTTP service is ready. This input endpoint binds to localhost by default; keep it private or add authentication before exposing it beyond a trusted machine.

## Play GPS data from an MDF4 file

1. Start the app with `npm run dev` and open its Vite URL.
2. In **MDF4 GPS Player**, select an `.mf4` file. Device ID and playback speed can be changed under **Playback options**.
3. Click **Play MDF4 file**. The reader decodes valid coordinates and first sends the track's start and end coordinates through ZeroMQ. To reduce traffic, playback keeps the first and last fixes and sends an intermediate fix when the bearing changes by at least 8 degrees. The map fits the track bounds, and the WebSocket bridge forwards published fixes to Leaflet in recorded order. The player lists latitude and longitude fixes as they arrive from ZeroMQ. Playback defaults to 10x recorded time; set the speed to `0` to send fixes as fast as possible.

Latitude and longitude channels are detected automatically when their names include `Latitude`/`Longitude` or use common `lat`/`lon` names. Set the channel fields to exact channel names if detection picks the wrong signals. The upload limit is 256 MB.

MDF4 files with already-decoded coordinate channels need no DBC file. For raw CAN logs, place the matching DBC at `server/data/gnss-middle.dbc` or set `MDF4_DATABASE_FILE` to its path before starting `npm run dev`. The supplied sample GNSS DBC decodes `Latitude_2` and `Longitude_2` and filters invalid position fixes.

### Generate a Delhi-Mumbai Expressway MDF4 demo

Create a GPS MDF4 file that can be uploaded in the playback panel:

```powershell
.\.venv\Scripts\python.exe scripts\create_delhi_mumbai_mdf4.py
```

By default, this writes `server/data/delhi-mumbai-expressway-demo.mf4` with `Latitude`, `Longitude`, and `PositionValid` channels. Upload that file using **Play an MDF4 GPS log**. The built-in route is a synthetic, approximate expressway-corridor demo, not surveyed or actual vehicle GPS data. For an exact road trace, supply a GeoJSON `LineString` from a verified Delhi-Mumbai Expressway route:

```powershell
.\.venv\Scripts\python.exe scripts\create_delhi_mumbai_mdf4.py --route-geojson .\expressway-route.geojson
```

Use `--spacing-meters` and `--sample-interval` to adjust the generated track density and timestamps.

The map's **Find road route** form requests a driving route between the start and end, optionally passing through intermediate coordinates (one `latitude, longitude` pair per line). The route is drawn along roads on the map; these planned routes are not published as live GPS fixes. You can request a route directly:

```powershell
$path = @{
  id = 'vehicle-07'
  label = 'North crew'
  start = @{ latitude = 37.7749; longitude = -122.4194 }
  waypoints = @(
    @{ latitude = 37.7780; longitude = -122.4160 }
    @{ latitude = 37.7810; longitude = -122.4130 }
  )
  end = @{ latitude = 37.7849; longitude = -122.4094 }
} | ConvertTo-Json -Depth 4

$route = Invoke-RestMethod -Uri 'http://127.0.0.1:4175/paths' -Method Post -ContentType 'application/json' -Body $path
$route.positions
```

Route requests must contain between 2 and 100 valid coordinates, counting the start and end. The included publisher requests driving routes from the OSRM demo service (`ROUTING_API_URL` can point to another OSRM-compatible routing service). The public demo service may be rate-limited or unavailable; use a hosted or self-managed routing service for production. The existing `/coordinates` endpoint remains available for streaming individual GPS fixes.

## Coordinate message format

The publisher emits one JSON message per ZeroMQ frame:

```json
{
  "id": "vehicle-07",
  "label": "North crew",
  "latitude": 37.7749,
  "longitude": -122.4194,
  "timestamp": "2026-10-28T15:04:05.000Z",
  "speed": 12.4,
  "heading": 92
}
```

Coordinates are required; latitude must be between -90 and 90 and longitude between -180 and 180. The bridge also accepts `lat`, `lon` or `lng`, and a nested `position` object. Device identity can be `id`, `deviceId`, or `device_id`. Timestamp can be an ISO string or Unix time in seconds/milliseconds. Invalid fixes are rejected by the included publisher and ignored by the bridge.

## Use an existing ZeroMQ publisher

The included bridge uses a ZeroMQ SUB socket. Your existing GPS server should publish JSON messages using PUB or XPUB and be reachable from this machine. Set `ZMQ_ENDPOINT` to the publisher endpoint in `.env`, for example `tcp://192.168.1.40:5556`. Set `ZMQ_TOPIC` if each message starts with a topic prefix. Then run `npm run dev:bridge` alongside `npm run dev:web` (or use the normal `npm run dev`, which also starts the local publisher). If using your own publisher on port 5556, stop the included publisher or configure `PUBLISHER_BIND` to another port.

A PUB/SUB publisher does not retain messages. Start the bridge and allow the ZeroMQ subscription to connect before sending the first fix. The HTTP sender is only an input for the included local publisher; external ZeroMQ publishers can publish the JSON message directly.

## Individual services and checks

- `npm run dev`: start web client, WebSocket bridge, and included ZeroMQ publisher.
- `npm run dev:web`: start only the web client.
- `npm run dev:bridge`: start only the ZeroMQ-to-WebSocket bridge.
- `npm run dev:publisher`: start only the included ZeroMQ publisher and HTTP input.
- Set `$env:GPS_COORDINATE = '37.7,-122.4,device-1'` then run `npm run send:coordinate` to send a single coordinate from PowerShell.
- `npm run build`: type-check and build the frontend.
- `npm run check:bridge`: type-check the bridge, publisher, and sender.
- `npm run lint`: run Oxlint.
- `npm run preview`: serve the production frontend build locally.
