import { Resource, tables } from 'harperdb'
import { embedImageBytes } from '../lib/embed.js'

// Alternate match implementation that trusts the HNSW iterator to return
// results in distance-ascending order and exposes the precomputed cosine
// distance via the $distance metadata attribute — no JS re-rank, no
// over-fetch. Used as a benchmark control vs the original MatchCelebrity.

const MAX_BYTES = 8 * 1024 * 1024

export class MatchCelebrityV2 extends Resource {
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
			const err = new Error(`image too large`)
			err.statusCode = 413
			throw err
		}
		const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 5, 1), 20)

		const queryVector = await embedImageBytes(bytes, m[1])

		// Trust the HNSW iterator's distance-ascending order, ask it to
		// fetch exactly `limit` records.
		const matches = []
		const debugFirstEntry = []
		const iter = tables.Celebrity.search({
			conditions: { attribute: 'embedding', comparator: 'lt', value: 2, target: queryVector },
			limit,
			select: ['name', 'category', 'wikipediaUrl', 'photoUrl', 'blurb', '$distance'],
		})
		for await (const r of iter) {
			if (debugFirstEntry.length === 0) {
				// Capture the raw row shape — what keys, what's $distance / .distance, etc.
				debugFirstEntry.push({
					ownKeys: Object.keys(r),
					hasDistance: 'distance' in r,
					hasDollarDistance: '$distance' in r,
					distanceValue: r.distance,
					dollarDistanceValue: r.$distance,
					toJSON: typeof r.toJSON,
				})
			}
			matches.push(r)
		}

		return { matches, debug: debugFirstEntry[0], model: 'multimodal-clip', strategy: 'iterator-order' }
	}
}
