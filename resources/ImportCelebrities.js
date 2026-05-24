import { Resource, tables } from 'harperdb'
import { CELEBRITIES } from '../lib/celebrities.js'
import { embedImageBytes } from '../lib/embed.js'

const WIKI_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary'
const UA = 'harper-celebrity-match/0.1 (+https://github.com/HarperFast/harper-celebrity-match)'

// Wikipedia upload.wikimedia.org rate-limits unauthenticated bulk fetches.
// 250ms between requests keeps us comfortably under their threshold without
// dragging the full ~200-entry import past a minute or two.
const FETCH_DELAY_MS = 250
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function runImport(options) {
	const startedAt = new Date().toISOString()
	const requested = options?.subset ? CELEBRITIES.slice(0, options.subset) : CELEBRITIES
	let imported = 0
	let skipped = 0
	const errors = []

	for (const entry of requested) {
		try {
			const existing = await tables.Celebrity.get(entry.title)
			if (existing?.embedding?.length) {
				skipped++
				continue
			}

			const summary = await fetchWikiSummary(entry.title)
			if (summary.error) {
				errors.push(summary.error)
				continue
			}

			const { bytes, mime } = await downloadImage(summary.thumbnailUrl)
			const vector = await embedImageBytes(bytes, mime)

			await tables.Celebrity.put({
				id: entry.title,
				name: summary.title,
				category: entry.category,
				wikipediaUrl: summary.pageUrl,
				photoUrl: summary.thumbnailUrl,
				blurb: summary.description || summary.extract.slice(0, 240),
				embedding: vector,
			})
			imported++
		} catch (e) {
			errors.push(`${entry.title}: ${String(e.message || e)}`)
		}
		// Throttle Wikipedia requests to dodge the 429 cliff. Cheap compared to
		// the embedding cost (~250ms tax on a ~1.5s/entry pipeline).
		await sleep(FETCH_DELAY_MS)
	}

	const finishedAt = new Date().toISOString()
	const logId = `import-${Date.now()}`
	await tables.ImportLog.put({
		id: logId,
		startedAt,
		finishedAt,
		totalRequested: requested.length,
		totalImported: imported,
		totalSkipped: skipped,
		errors,
	})

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

export class ImportCelebrities extends Resource {
	static loadAsInstance = false

	async post(target) {
		target.checkPermission = false
		// The Harper Resource shape is inconsistent across versions — `target` is
		// sometimes the parsed body itself, sometimes a wrapper exposing .json().
		// Try both so the demo can be driven from curl with either JSON or no body.
		let body = {}
		if (target && typeof target === 'object' && !target.json && !target.body) {
			body = target
		} else if (typeof target?.json === 'function') {
			try { body = await target.json() } catch { body = {} }
		}
		const subset = Number.isFinite(body?.subset) ? Number(body.subset) : undefined
		return runImport({ subset })
	}
}
