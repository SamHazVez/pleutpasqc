import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const WMS = 'https://geo.weather.gc.ca/geomet'
const OUT = 'out-radar'
const LAYERS = {
  observed: 'RADAR_1KM_RRAI',
  extrapolated: 'Radar_1km_RainPrecipRate-Extrapolation',
}
const BOUNDS = { west: -79.8, south: 44.9, east: -57.1, north: 62.6 }
const WIDTH = 900
const HEIGHT = 700
const PAST_COUNT = 12
const MAX_AGE_MS = 40 * 60 * 1000

const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const invMerc = (y) => (Math.atan(Math.exp(y)) - Math.PI / 4) * (360 / Math.PI)
const xMerc = (lon) => lon * 20037508.34 / 180
const yMerc = (lat) => merc(lat) * 20037508.34 / Math.PI

const bbox = [
  xMerc(BOUNDS.west),
  yMerc(BOUNDS.south),
  xMerc(BOUNDS.east),
  yMerc(BOUNDS.north),
].join(',')

function pngResponse(res, body) {
  const type = res.headers.get('content-type') || ''
  if (!res.ok || !type.includes('image/png')) {
    const detail = Buffer.from(body).toString('utf8', 0, 300).replace(/\s+/g, ' ')
    throw new Error('GeoMet WMS invalide: HTTP ' + res.status + ' ' + type + ' ' + detail)
  }
  const bytes = Buffer.from(body)
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('GeoMet WMS: réponse PNG invalide')
  }
  return bytes
}

async function getCapabilities() {
  const url = WMS + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities'
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error('GetCapabilities HTTP ' + res.status)
  return res.text()
}

function layerBlock(xml, name) {
  const marker = '<Name>' + name + '</Name>'
  const start = xml.indexOf(marker)
  if (start < 0) throw new Error('Couche GeoMet absente: ' + name)
  const end = xml.indexOf('</Layer>', start)
  if (end < 0) throw new Error('Bloc GeoMet incomplet: ' + name)
  return xml.slice(start, end)
}

function timesFor(xml, name) {
  const block = layerBlock(xml, name)
  const match = block.match(/<Dimension[^>]+name="time"[^>]*>([^<]+)<\/Dimension>/i)
  if (!match) throw new Error('Dimension time absente: ' + name)
  const value = match[1].trim()
  const parts = value.split('/')
  if (parts.length === 3) {
    const start = Date.parse(parts[0])
    const end = Date.parse(parts[1])
    const step = /^PT(\d+)M$/i.exec(parts[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || !step) {
      throw new Error('Dimension time non supportée: ' + value)
    }
    const stepMs = Number(step[1]) * 60000
    const out = []
    for (let t = start; t <= end; t += stepMs) out.push(t)
    return out
  }
  return value.split(',').map((v) => Date.parse(v.trim())).filter(Number.isFinite)
}

async function getPng(layer, time) {
  const iso = new Date(time).toISOString().replace('.000Z', 'Z')
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    CRS: 'EPSG:3857',
    BBOX: bbox,
    WIDTH: String(WIDTH),
    HEIGHT: String(HEIGHT),
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    EXCEPTIONS: 'XML',
    TIME: iso,
  })
  const res = await fetch(WMS + '?' + params, { signal: AbortSignal.timeout(60000) })
  return pngResponse(res, await res.arrayBuffer())
}

function fileName(time, suffix) {
  return 'frames/' + new Date(time).toISOString().replace(/[-:.]/g, '').replace('000Z', 'Z') + '-' + suffix + '.png'
}

function frame(time, file, model) {
  return { time: time / 1000, file, model }
}

async function main() {
  const xml = await getCapabilities()
  const observedTimes = timesFor(xml, LAYERS.observed)
  const extrapolatedTimes = timesFor(xml, LAYERS.extrapolated)
  const now = Date.now()
  const pastTimes = observedTimes.filter((t) => t <= now).slice(-PAST_COUNT)
  const futureTimes = extrapolatedTimes.filter((t) => t > now)
  if (!pastTimes.length && !futureTimes.length) throw new Error('Aucune échéance radar disponible')

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT + '/frames', { recursive: true })
  const past = []
  const frames = []

  for (const time of pastTimes) {
    const file = fileName(time, 'obs')
    writeFileSync(OUT + '/' + file, await getPng(LAYERS.observed, time))
    past.push(frame(time, file, 'observed'))
    console.log(new Date(time).toISOString() + ' observation')
  }
  for (const time of futureTimes) {
    const file = fileName(time, 'projection')
    writeFileSync(OUT + '/' + file, await getPng(LAYERS.extrapolated, time))
    frames.push(frame(time, file, 'extrapolated'))
    console.log(new Date(time).toISOString() + ' extrapolation')
  }

  const latest = [...past, ...frames].reduce((a, b) => Math.max(a, b.time), 0) * 1000
  const manifest = {
    run: new Date(now).toISOString(),
    generatedAt: new Date().toISOString(),
    model: 'ECCC radar observation + ECCC radar extrapolation',
    bounds: [[BOUNDS.south, BOUNDS.west], [BOUNDS.north, BOUNDS.east]],
    source: 'MSC GeoMet',
    frames: frames.map(({ time, file, model }) => ({ time, file, model })),
    past: past.map(({ time, file, model }) => ({ time, file, model })),
  }
  writeFileSync(OUT + '/manifest.json', JSON.stringify(manifest))
  if (now - latest > MAX_AGE_MS) throw new Error('Données radar trop anciennes')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
