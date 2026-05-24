import { Resource, tables } from 'harperdb'
import { embedImageBytes } from '../lib/embed.js'

const DEFAULT_LIMIT = 5
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB cap on uploads

// Accept the uploaded image. The frontend sends JSON
// `{ image: "data:image/...;base64,..." }`, which Harper parses for us — so
// `target` is the parsed JSON body directly in current harper-pro builds.
async function readImage(target) {
	let body
	if (target && typeof target === 'object' && !target.json && !target.body && typeof target.image === 'string') {
		body = target
	} else if (typeof target?.json === 'function') {
		try { body = await target.json() } catch { body = null }
	}
	const dataUrl = body?.image
	if (typeof dataUrl !== 'string') {
		throw Object.assign(new Error('expected JSON body { image: "data:image/...;base64,..." }'), { statusCode: 400 })
	}
	const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
	if (!m) {
		throw Object.assign(new Error('image must be a base64 data URL'), { statusCode: 400 })
	}
	const bytes = Buffer.from(m[2], 'base64')
	if (bytes.length > MAX_BYTES) {
		throw Object.assign(new Error(`image too large (>${MAX_BYTES / 1024 / 1024} MB)`), { statusCode: 413 })
	}
	return { bytes, mime: m[1] }
}

export class MatchCelebrity extends Resource {
	static loadAsInstance = false

	async post(target) {
		target.checkPermission = false
		const { bytes, mime } = await readImage(target)

		const limitParam = parseInt(target.url?.searchParams?.get('limit') ?? '', 10)
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 20) : DEFAULT_LIMIT

		const queryVector = await embedImageBytes(bytes, mime)

		// HNSW similarity search: closest N celebrities by cosine distance.
		// Harper's `search` accepts `vector` + `limit`; results include `distance`.
		const hits = []
		const iter = tables.Celebrity.search({
			conditions: [{ attribute: 'embedding', value: queryVector, operator: 'cosine' }],
			limit,
		})
		for await (const r of iter) {
			hits.push({
				name: r.name,
				category: r.category,
				wikipediaUrl: r.wikipediaUrl,
				photoUrl: r.photoUrl,
				blurb: r.blurb,
				distance: r.distance ?? r.score ?? null,
			})
		}

		return { matches: hits, model: 'multimodal-clip' }
	}
}
