import palette from './palette.json'
import { cleanName, QUEBEC_BOUNDS, inQuebecBounds, type Place } from './meteo'

export interface OpenMeteoPayload {
  minutely_15: { time: number[]; precipitation: (number | null)[] }
  hourly: { time: number[]; precipitation: number[]; precipitation_probability: (number | null)[] }
}

export interface FutureFrame {
  time: number
  url: string
  bounds: [[number, number], [number, number]]
}

export interface FutureRain {
  radarRun: string | null
  past: FutureFrame[]
  frames: FutureFrame[]
}

export interface GeoResult {
  name: string
  lat: number
  lon: number
  area: string
}

export async function fetchWeather(place: Place): Promise<OpenMeteoPayload> {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + place.lat + '&longitude=' + place.lon
    + '&models=gem_seamless'
    + '&minutely_15=precipitation'
    + '&hourly=precipitation,precipitation_probability'
    + '&forecast_days=2&timezone=auto&timeformat=unixtime'
  const res = await fetch(url)
  if (!res.ok) throw new Error('open-meteo http ' + res.status)
  return res.json()
}

const RADAR_BASE: string = import.meta.env.VITE_RADAR_BASE
  || import.meta.env.VITE_DATA_BASE
  || 'https://raw.githubusercontent.com/SamHazVez/pleutpasqc/radar'

interface FrameManifest {
  run: string
  past: FutureFrame[]
  frames: FutureFrame[]
}

async function fetchManifest(base: string): Promise<FrameManifest | null> {
  const res = await fetch(base + '/manifest.json')
  if (!res.ok) throw new Error('manifest frames http ' + res.status)
  const m = await res.json()
  if (!m.run || !m.bounds || !m.frames?.length) return null
  const toFrame = (f: { time: number; file: string }) => ({ time: f.time, url: base + '/' + f.file, bounds: m.bounds })
  return {
    run: m.run,
    past: (m.past ?? []).map(toFrame),
    frames: m.frames.map(toFrame),
  }
}

export async function fetchFutureRain(): Promise<FutureRain | null> {
  if (!RADAR_BASE) return null
  const radar = await fetchManifest(RADAR_BASE).catch(() => null)
  if (!radar) return null
  return {
    radarRun: radar.run,
    past: radar.past,
    frames: radar.frames,
  }
}

const STEP_COLORS = palette.steps.map((s) => ({
  mm: s.mm,
  rgb: [parseInt(s.hex.slice(1, 3), 16), parseInt(s.hex.slice(3, 5), 16), parseInt(s.hex.slice(5, 7), 16)],
}))

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

// Echantillonne une frame radar (PNG publiee par le pipeline Quebec, lignes reechantillonnees
// en Mercator) au-dessus du lieu : fenetre 3x3 px (~5 km), renvoie l'intensite la plus
// forte trouvee (mm / 15 min de la palette, 0 si aucun pixel colore), null hors de la frame
export async function sampleFrameMm(frame: FutureFrame, lat: number, lon: number): Promise<number | null> {
  const [[south, west], [north, east]] = frame.bounds
  if (lat <= south || lat >= north || lon <= west || lon >= east) return null
  const res = await fetch(frame.url)
  if (!res.ok) throw new Error('frame pluie http ' + res.status)
  const bmp = await createImageBitmap(await res.blob())
  const cv = document.createElement('canvas')
  cv.width = bmp.width
  cv.height = bmp.height
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('canvas 2d indisponible')
  ctx.drawImage(bmp, 0, 0)
  const x = Math.floor(((lon - west) / (east - west)) * bmp.width)
  const y = Math.floor(((merc(north) - merc(lat)) / (merc(north) - merc(south))) * bmp.height)
  const x0 = Math.max(0, x - 1)
  const y0 = Math.max(0, y - 1)
  const img = ctx.getImageData(x0, y0, Math.min(bmp.width - 1, x + 1) - x0 + 1, Math.min(bmp.height - 1, y + 1) - y0 + 1)
  let max = 0
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] !== 255) continue
    const step = STEP_COLORS.find((c) => c.rgb[0] === img.data[i] && c.rgb[1] === img.data[i + 1] && c.rgb[2] === img.data[i + 2])
    if (step && step.mm > max) max = step.mm
  }
  return max
}

const PHOTON = 'https://photon.komoot.io'
const GEO_TIMEOUT_MS = 6000
const geoFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(GEO_TIMEOUT_MS) })
const PHOTON_BBOX = [QUEBEC_BOUNDS[0][1], QUEBEC_BOUNDS[0][0], QUEBEC_BOUNDS[1][1], QUEBEC_BOUNDS[1][0]].join(',')

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: { name?: string; city?: string; county?: string; state?: string; country?: string; countrycode?: string }
}

async function photonName(lat: number, lon: number): Promise<string | null> {
  const res = await geoFetch(PHOTON + '/reverse?lat=' + lat + '&lon=' + lon + '&lang=fr')
  if (!res.ok) throw new Error('photon http ' + res.status)
  const data = await res.json()
  const p = ((data.features || []) as PhotonFeature[])[0]?.properties
  return cleanName(p?.city ?? p?.name) || null
}

export async function reverseGeocodeName(lat: number, lon: number): Promise<string | null> {
  return photonName(lat, lon)
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

async function searchPhoton(q: string): Promise<GeoResult[]> {
  const res = await geoFetch(PHOTON + '/api/?q=' + encodeURIComponent(q)
    + '&lang=fr&limit=10&layer=city&bbox=' + PHOTON_BBOX)
  if (!res.ok) throw new Error('photon http ' + res.status)
  const data = await res.json()
  const seen = new Set<string>()
  const out: GeoResult[] = []
  for (const f of (data.features || []) as PhotonFeature[]) {
    const qc = f.properties.countrycode === 'CA'
      && fold(f.properties.state ?? '') === 'quebec'
    const name = cleanName(f.properties.name)
    const area = cleanName(f.properties.county)
    if (!qc) continue
    if (!name || seen.has(name + '|' + area)) continue
    seen.add(name + '|' + area)
    out.push({ name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], area })
  }
  return out
}

export async function searchPlaces(q: string): Promise<GeoResult[]> {
  const result = await searchPhoton(q)
  const found = result.filter((r) => r.name && inQuebecBounds(r.lat, r.lon))
  const wanted = fold(q.trim())
  const exact = found.filter((r) => fold(r.name) === wanted)
  return [...exact, ...found.filter((r) => !exact.includes(r))].slice(0, 5)
}
