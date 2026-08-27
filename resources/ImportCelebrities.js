import { Resource, tables, transaction } from 'harper'
import { CELEBRITIES } from '../lib/celebrities.js'
import { embedImageBytes } from '../lib/embed.js'

const WIKI_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary'
const UA = 'harper-celebrity-match/0.1 (+https://github.com/HarperFast/harper-celebrity-match)'

// Wikipedia upload.wikimedia.org rate-limits unauthenticated bulk fetches.
// 250ms between requests keeps us comfortably under their threshold without
// dragging the full ~200-entry import past a minute or two.
const FETCH_DELAY_MS = 250
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// v5 propagates the active transaction through async context. `runImport` is
// deliberately detached from the POST that starts it, so every table call it
// makes would otherwise inherit the request's transaction — which Harper has
// already committed by the time the response is written. Handing `transaction()`
// a fresh context object opens a NEW transaction instead of joining the ambient
// one, and swaps the async context for the duration of the callback, so each
// unit of work commits on its own.
const inNewTransaction = (fn) => transaction({}, fn)

async function fetchWithRetry(url, init, attempts = 3) {
	let lastErr
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url, init)
			// 429 from upload.wikimedia.org — back off and retry.
			if (res.status === 429 && i < attempts - 1) {
				await sleep(1500 * (i + 1))
				continue
			}
			return res
		} catch (e) {
			lastErr = e
			await sleep(500 * (i + 1))
		}
	}
	if (lastErr) throw lastErr
	throw new Error(`fetch failed after ${attempts} attempts`)
}

// Fetch Wikipedia summary JSON for a page title.
async function fetchWikiSummary(title) {
	const url = `${WIKI_BASE}/${encodeURIComponent(title)}`
	const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA } })
	if (!res.ok) return { error: `wiki ${res.status} for "${title}"` }
	const data = await res.json()
	const thumb = data.thumbnail?.source || data.originalimage?.source
	if (!thumb) return { error: `no thumbnail for "${title}"` }
	return {
		title: data.title,
		description: data.description || '',
		extract: data.extract || '',
		thumbnailUrl: thumb,
		originalUrl: data.originalimage?.source || thumb,
		pageUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
	}
}

// Download an image with a proper User-Agent. vLLM's internal fetcher uses a
// default UA that Wikipedia rate-limits aggressively, so we relay the bytes.
async function downloadImage(url) {
	const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA, Accept: 'image/*' } })
	if (!res.ok) throw new Error(`download ${res.status} ${url}`)
	const mime = res.headers.get('content-type') || 'image/jpeg'
	const bytes = new Uint8Array(await res.arrayBuffer())
	return { bytes, mime }
}

// Process a single celebrity. Sleeps `FETCH_DELAY_MS` AFTER any real fetch
// (skip cached entries don't pay the throttle).
async function importOne(entry) {
	const existing = await inNewTransaction(() => tables.Celebrity.get(entry.title))
	if (existing?.embedding?.length) return { skipped: true }

	const summary = await fetchWikiSummary(entry.title)
	if (summary.error) return { error: summary.error }

	const { bytes, mime } = await downloadImage(summary.thumbnailUrl)
	const vector = await embedImageBytes(bytes, mime)

	await inNewTransaction(() =>
		tables.Celebrity.put({
			id: entry.title,
			name: summary.title,
			category: entry.category,
			wikipediaUrl: summary.pageUrl,
			photoUrl: summary.thumbnailUrl,
			blurb: summary.description || summary.extract.slice(0, 240),
			embedding: vector,
		}),
	)
	await sleep(FETCH_DELAY_MS)
	return { imported: true }
}

async function runImport(options) {
	const startedAt = new Date().toISOString()
	const requested = options?.subset != null ? CELEBRITIES.slice(0, options.subset) : CELEBRITIES
	let imported = 0
	let skipped = 0
	const errors = []

	for (const entry of requested) {
		try {
			const r = await importOne(entry)
			if (r.skipped) skipped++
			else if (r.imported) imported++
			else if (r.error) errors.push(r.error)
		} catch (e) {
			errors.push(`${entry.title}: ${String(e.message || e)}`)
		}
	}

	const finishedAt = new Date().toISOString()
	const logId = `import-${Date.now()}`
	await inNewTransaction(() =>
		tables.ImportLog.put({
			id: logId,
			startedAt,
			finishedAt,
			totalRequested: requested.length,
			totalImported: imported,
			totalSkipped: skipped,
			errors,
		}),
	)

	return {
		ok: true,
		logId,
		totalRequested: requested.length,
		totalImported: imported,
		totalSkipped: skipped,
		errorCount: errors.length,
		sampleErrors: errors.slice(0, 5),
	}
}

// In-process flag so concurrent POSTs don't fan out multiple parallel imports
// against Wikipedia. The flag clears when the background runImport finishes
// (or throws). Survives across requests inside the same worker, but not across
// worker threads — that's fine for a demo.
let importInFlight = null

export class ImportCelebrities extends Resource {
	// v5: endpoints are implemented as static methods. Harper's REST layer
	// dispatches directly to them with the RequestTarget, so no instance is
	// constructed and the `loadAsInstance = false` opt-out is no longer needed.
	static async post(target, data) {
		target.checkPermission = false
		// REST deserializes the request body lazily, so a static `post` receives
		// `data` as a promise — the base class's instance dispatch used to await it
		// on our behalf. Resolve it before touching any field.
		data = await data
		const subset = Number.isFinite(data?.subset) ? Number(data.subset) : undefined

		if (importInFlight) {
			return { ok: false, status: 'already_running' }
		}
		// Detach the run from the request lifecycle: returning immediately means
		// the Harper HTTP layer doesn't hold the socket open past its 60s cap,
		// and the inner fetch() AbortSignals stay un-aborted because nothing is
		// awaiting us. Caller polls GET /CelebrityLookalike (or scope the table)
		// to see progress. Under v5's async-context transactions that detachment
		// also means the run outlives this request's transaction, which is why
		// every table call inside it goes through `inNewTransaction`.
		importInFlight = runImport({ subset })
			.catch((e) => ({ ok: false, error: String(e.message || e) }))
			.finally(() => { importInFlight = null })

		return { ok: true, status: 'started', subset: subset ?? CELEBRITIES.length }
	}
}
