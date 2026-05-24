import { Resource, tables } from 'harperdb'
import { embedImageBytes } from '../lib/embed.js'

const DEFAULT_LIMIT = 5
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB cap on uploads

// Accept the uploaded image as raw body. Returns Buffer + mime.
async function readImage(target) {
	const ct = target.headers?.['content-type'] || target.req?.headers?.['content-type'] || ''
	// Streamed binary body — Harper passes the request body through target.body
	// or via target.arrayBuffer() depending on version. Try both.
	let bytes
	if (typeof target.arrayBuffer === 'function') {
		bytes = new Uint8Array(await target.arrayBuffer())
	} else if (target.body instanceof Uint8Array || Buffer.isBuffer?.(target.body)) {
		bytes = target.body
	} else if (typeof target.body === 'string') {
		// Allow base64 JSON: { "image": "data:image/jpeg;base64,..." }
		const parsed = JSON.parse(target.body)
		const m = /^data:([^;]+);base64,(.+)$/.exec(parsed.image || '')
		if (!m) throw Object.assign(new Error('expected data URL in body.image'), { statusCode: 400 })
		return { bytes: Buffer.from(m[2], 'base64'), mime: m[1] }
	} else {
		throw Object.assign(new Error('no image body found'), { statusCode: 400 })
	}
	if (bytes.length > MAX_BYTES) {
		throw Object.assign(new Error(`image too large (>${MAX_BYTES / 1024 / 1024} MB)`), { statusCode: 413 })
	}
	return { bytes, mime: ct.split(';')[0].trim() || 'image/jpeg' }
}

export class Match extends Resource {
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
