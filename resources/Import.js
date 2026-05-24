import { Resource, tables } from 'harperdb'
import { CELEBRITIES } from '../lib/celebrities.js'
import { embedImageBytes } from '../lib/embed.js'

const WIKI_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary'
const UA = 'harper-celebrity-match/0.1 (+https://github.com/HarperFast/harper-celebrity-match)'

// Fetch Wikipedia summary JSON for a page title.
async function fetchWikiSummary(title) {
	const url = `${WIKI_BASE}/${encodeURIComponent(title)}`
	const res = await fetch(url, { headers: { 'User-Agent': UA } })
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
	const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' } })
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

export class Import extends Resource {
	static loadAsInstance = false

	async post(target) {
		target.checkPermission = false
		const body = (await target.json?.()) ?? {}
		return runImport({ subset: body?.subset })
	}
}
