import palette from './palette.json'

export interface Place {
  name: string
  lat: number
  lon: number
}

export interface Slot {
  start: number
  mm: number
}

export interface ImmediateEntry {
  start: number
  end: number
  level: number
  desc: string
}

export interface VerdictView {
  state: 'oui' | 'bof' | 'non' | 'inconnu'
  big: string
  sub: string
  detail: string
}

export const SLOT_MIN = palette.slotMin
export const WET_MM = palette.wetMm
export const LIGHT_MAX_MM = palette.lightMaxMm
export const QUEBEC_CITY: Place = { name: 'Québec', lat: 46.8139, lon: -71.2080 }
// Emprise de recherche et de carte; la couverture radar est plus restreinte.
export const QUEBEC_BOUNDS: [[number, number], [number, number]] = [[44.9, -79.8], [62.6, -57.1]]

export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
}

export function inQuebecBounds(lat: number, lon: number): boolean {
  const [[south, west], [north, east]] = QUEBEC_BOUNDS
  return lat >= south && lat <= north && lon >= west && lon <= east
}

const STALE_MS = 60 * 60 * 1000
export const STEP_5MIN_MS = 5 * 60 * 1000
const LEGERE_MM = palette.steps.find((s) => s.name === 'legere')?.mm ?? LIGHT_MAX_MM

// forme francaise collee ("4h15", "23h"), le format 4:15 est un anglicisme
export function fmtHM(t: number | Date): string {
  const d = new Date(t)
  const m = d.getMinutes()
  return d.getHours() + 'h' + (m ? String(m).padStart(2, '0') : '')
}

export function fmtDay(tMs: number, nowMs: number): string {
  const t = new Date(tMs)
  const n = new Date(nowMs)
  const days = Math.round(
    (new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
      - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86400000,
  )
  if (days <= 0) return ''
  if (days === 1) return 'demain'
  return t.toLocaleDateString('fr-FR', { weekday: 'long' })
}

function fmtDayHM(tMs: number, nowMs: number): string {
  const d = fmtDay(tMs, nowMs)
  return d ? d + ' ' + fmtHM(tMs) : fmtHM(tMs)
}

export function slotIndexNow(slots: Slot[], nowMs: number): number {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].start + SLOT_MIN * 60000 > nowMs) return i
  }
  return -1
}

function slotsEndMs(slots: Slot[]): number {
  return slots.length ? slots[slots.length - 1].start + SLOT_MIN * 60000 : 0
}

function immediateEntryAt(entries: ImmediateEntry[] | null, tMs: number): ImmediateEntry | null {
  if (!entries) return null
  for (const e of entries) {
    if (tMs >= e.start && tMs < e.end) return e
  }
  return null
}

function slotAt(slots: Slot[], tMs: number): Slot | null {
  if (!slots.length) return null
  const i = Math.floor((tMs - slots[0].start) / (SLOT_MIN * 60000))
  return i >= 0 && i < slots.length ? slots[i] : null
}

// Conversion d'une classe de précipitation vers l'échelle de la palette.
export function immediateLevelMm(level: number): number {
  const table = palette.immediateLevelMm
  return table[Math.max(0, Math.min(level, table.length - 1))]
}

function mmAtMs(slots: Slot[], entries: ImmediateEntry[] | null, tMs: number): number | null {
  const e = immediateEntryAt(entries, tMs)
  if (e) return immediateLevelMm(e.level)
  const s = slotAt(slots, tMs)
  return s ? s.mm : null
}

function wetAtMs(slots: Slot[], entries: ImmediateEntry[] | null, tMs: number): boolean | null {
  const mm = mmAtMs(slots, entries, tMs)
  return mm === null ? null : mm >= WET_MM
}

function maxMmWindow(slots: Slot[], entries: ImmediateEntry[] | null, startMs: number, durMin: number): number | null {
  const endMs = startMs + durMin * 60000
  let max = 0
  for (let t = startMs; t < endMs; t += STEP_5MIN_MS) {
    const mm = mmAtMs(slots, entries, t)
    if (mm === null) return null
    max = Math.max(max, mm)
  }
  const last = mmAtMs(slots, entries, endMs - 1)
  return last === null ? null : Math.max(max, last)
}

function isDryWindowMs(slots: Slot[], entries: ImmediateEntry[] | null, startMs: number, durMin: number): boolean {
  const mm = maxMmWindow(slots, entries, startMs, durMin)
  return mm !== null && mm < WET_MM
}

function next5min(t: number): number {
  return (Math.floor(t / STEP_5MIN_MS) + 1) * STEP_5MIN_MS
}

function firstWetMs(slots: Slot[], entries: ImmediateEntry[] | null, fromMs: number): number {
  const endMs = Math.min(fromMs + 48 * 3600000, slotsEndMs(slots))
  for (let t = fromMs; t < endMs; t = next5min(t)) {
    if (wetAtMs(slots, entries, t) === true) return t
  }
  return -1
}

function nextDryDepartureMs(slots: Slot[], entries: ImmediateEntry[] | null, fromMs: number, durMin: number): number {
  const endMs = Math.min(fromMs + 48 * 3600000, slotsEndMs(slots))
  for (let t = fromMs; t < endMs; t = next5min(t)) {
    if (isDryWindowMs(slots, entries, t, durMin)) return t
  }
  return -1
}

export function intensityColor(mm15: number): string | null {
  let name: string | null = null
  for (const s of palette.steps) {
    if (mm15 >= s.mm) name = s.name
  }
  return name ? 'var(--color-' + name + ')' : null
}

function lightWord(mm15: number): string {
  return mm15 < LEGERE_MM ? 'Bruine' : 'Pluie faible'
}

export interface TimelineCell {
  start: number
  wet: boolean
  color: string | null
  title: string
}

// Vue unique des 2 prochaines heures en cases de 5 min, utilisée par le verdict
// et la timeline pour conserver une représentation cohérente.
export function timelineCells(slots: Slot[], entries: ImmediateEntry[] | null, nowMs: number): TimelineCell[] {
  const firstMs = Math.floor(nowMs / STEP_5MIN_MS) * STEP_5MIN_MS
  const cells: TimelineCell[] = []
  for (let i = 0; i < 24; i++) {
    const t = firstMs + i * STEP_5MIN_MS
    const e = immediateEntryAt(entries, t)
    if (e) {
      const mm = immediateLevelMm(e.level)
      cells.push({ start: t, wet: mm >= WET_MM, color: intensityColor(mm), title: fmtHM(t) + ' : ' + e.desc })
      continue
    }
    const s = slotAt(slots, t)
    if (!s) break
    cells.push({
      start: t,
      wet: s.mm >= WET_MM,
      color: intensityColor(s.mm),
      title: fmtHM(t) + ' : ' + s.mm.toFixed(1) + ' mm / 15 min',
    })
  }
  return cells
}

export interface DayCell {
  start: number
  mm: number
  wetAt: number | null
}

// prend le relais de la timeline 2 h : cumuls horaires recalcules depuis la meme serie
// minutely_15 que lit le verdict au-dela de l'heure MF, coherence par construction
export function dayCells(slots: Slot[], nowMs: number): DayCell[] {
  const bandEndMs = Math.floor(nowMs / STEP_5MIN_MS) * STEP_5MIN_MS + 24 * STEP_5MIN_MS
  const firstHourMs = Math.floor(bandEndMs / 3600000) * 3600000
  const cells: DayCell[] = []
  for (let i = 0; i < 24; i++) {
    const h0 = firstHourMs + i * 3600000
    let mm = 0
    let wetAt: number | null = null
    let filled = 0
    for (let t = h0; t < h0 + 3600000; t += SLOT_MIN * 60000) {
      const s = slotAt(slots, t)
      if (!s) break
      filled++
      mm += s.mm
      if (wetAt === null && s.mm >= WET_MM) wetAt = s.start
    }
    if (filled < 4) break
    cells.push({ start: h0, mm, wetAt })
  }
  return cells
}

export function computeVerdict(
  slots: Slot[],
  entries: ImmediateEntry[] | null,
  radarMmNow: number | null,
  tripMin: number,
  nowMs: number,
  fetchedAtMs: number | null,
): VerdictView {
  const stale = fetchedAtMs !== null && nowMs - fetchedAtMs > STALE_MS
  const idx = slotIndexNow(slots, nowMs)
  if (idx < 0 || stale) {
    return {
      state: 'inconnu',
      big: '?',
      sub: stale ? 'Données trop anciennes' : 'Pas de données',
      detail: 'Actualise quand tu as du réseau.',
    }
  }
  const radarMm = radarMmNow
  const tripMm = maxMmWindow(slots, entries, nowMs, tripMin)
  const worstMm = tripMm === null ? null : Math.max(tripMm, radarMm ?? 0)
  if (worstMm !== null && worstMm < WET_MM) {
    const wetT = firstWetMs(slots, entries, nowMs)
    return {
      state: 'oui',
      big: 'OUI',
      sub: 'Prends ton vélo',
      detail: wetT < 0
        ? 'Pas de pluie prévue jusqu\'à ' + fmtDayHM(slotsEndMs(slots), nowMs) + ' (fin des prévisions).'
        : 'Sec jusqu\'à ' + fmtDayHM(wetT, nowMs) + ' environ.',
    }
  }
  const nowMm = Math.max(mmAtMs(slots, entries, nowMs) ?? 0, radarMm ?? 0)
  const rainingNow = nowMm >= WET_MM
  const wetT = firstWetMs(slots, entries, nowMs)
  const depMs = nextDryDepartureMs(slots, entries, nowMs, tripMin)
  const noDryWindow = 'Pas de fenêtre sèche trouvée d\'ici ' + fmtDayHM(slotsEndMs(slots), nowMs) + ' (fin des prévisions).'
  // bruine ou pluie faible seulement sur le trajet : ca se roule avec une veste, le
  // NON est reserve a la vraie pluie
  const radarOnly = tripMm !== null && tripMm < WET_MM
  const unforeseen = 'Averse non prévue, reviens voir quand elle passe.'
  if (worstMm !== null && worstMm < LIGHT_MAX_MM) {
    const word = lightWord(rainingNow ? nowMm : worstMm)
    return {
      state: 'bof',
      big: 'OUI',
      sub: rainingNow || wetT < 0
        ? word + ' en ce moment, sors la veste'
        : word + ' prévue vers ' + fmtDayHM(wetT, nowMs) + ', sors la veste',
      detail: radarOnly ? unforeseen
        : depMs < 0 ? noDryWindow : 'Sinon, prochain départ au sec : ' + fmtDayHM(depMs, nowMs) + '.',
    }
  }
  if (radarOnly) {
    return {
      state: 'non',
      big: 'NON',
      sub: 'Il pleut en ce moment (vu au radar)',
      detail: unforeseen,
    }
  }
  const sub = rainingNow || wetT < 0 ? 'Il pleut en ce moment' : 'Pluie prévue vers ' + fmtDayHM(wetT, nowMs)
  if (depMs < 0) {
    return { state: 'non', big: 'NON', sub, detail: noDryWindow }
  }
  return {
    state: 'non',
    big: 'NON',
    sub,
    detail: 'Prochain départ au sec : ' + fmtDayHM(depMs, nowMs),
  }
}
