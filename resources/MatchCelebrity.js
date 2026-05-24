import { Resource, tables } from 'harperdb'
import { embedImageBytes } from '../lib/embed.js'

const DEFAULT_LIMIT = 5
const MAX_BYTES = 8 * 1024 * 1024

function cosineDistance(a, b) {
	let dot = 0, na = 0, nb = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb)
	return denom === 0 ? 1 : 1 - dot / denom
}

export class MatchCelebrity extends Resource {
	static loadAsInstance = false

	async post(target, data) {
		target.checkPermission = false
		const dataUrl = data?.image
		if (typeof dataUrl !== 'string') {
			const err = new Error('expected JSON body { image: "data:image/...;base64,..." }')
			err.statusCode = 400
			throw err
		}
		const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
		if (!m) {
			const err = new Error('image must be a base64 data URL')
			err.statusCode = 400
			throw err
		}
		const bytes = Buffer.from(m[2], 'base64')
		if (bytes.length > MAX_BYTES) {
			const err = new Error(`image too large (>${MAX_BYTES / 1024 / 1024} MB)`)
			err.statusCode = 413
			throw err
		}
		const limit = Math.min(Math.max(parseInt(data?.limit, 10) || DEFAULT_LIMIT, 1), 20)

		const queryVector = await embedImageBytes(bytes, m[1])

		// HNSW search: pull a wider candidate set than `limit` because the
		// HNSW iterator isn't guaranteed distance-ordered, then rank by exact
		// cosine distance ourselves and take the top N.
		const candidates = []
		const iter = tables.Celebrity.search({
			conditions: {
				attribute: 'embedding',
				comparator: 'lt',
				value: 2,
				target: queryVector,
			},
			limit: Math.max(50, limit * 5),
		})
		for await (const r of iter) {
			if (!r.embedding) continue
			candidates.push({
				row: r,
				distance: cosineDistance(queryVector, r.embedding),
			})
		}
		candidates.sort((a, b) => a.distance - b.distance)

		return {
			matches: candidates.slice(0, limit).map(({ row, distance }) => ({
				name: row.name,
				category: row.category,
				wikipediaUrl: row.wikipediaUrl,
				photoUrl: row.photoUrl,
				blurb: row.blurb,
				distance,
			})),
			model: 'multimodal-clip',
		}
	}
}
