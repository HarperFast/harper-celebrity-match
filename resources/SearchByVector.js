import { Resource, tables } from 'harper'

// Benchmark helper — accepts a precomputed embedding vector and returns the
// HNSW search result without paying the embed cost. Used to isolate vector
// search throughput from CLIP/vLLM throughput.

function cosineDistance(a, b) {
	let dot = 0, na = 0, nb = 0
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
	const denom = Math.sqrt(na) * Math.sqrt(nb)
	return denom === 0 ? 1 : 1 - dot / denom
}

export class SearchByVector extends Resource {
	// v5: endpoints are implemented as static methods. Harper's REST layer
	// dispatches directly to them with the RequestTarget, so no instance is
	// constructed and the `loadAsInstance = false` opt-out is no longer needed.
	static async post(target, data) {
		target.checkPermission = false
		// REST deserializes the request body lazily, so a static `post` receives
		// `data` as a promise — the base class's instance dispatch used to await it
		// on our behalf. Resolve it before touching any field.
		data = await data
		const vector = data?.vector
		const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 10, 1), 50)
		if (!Array.isArray(vector) || vector.length === 0) {
			const err = new Error('expected JSON body { vector: number[], limit?: number }')
			err.statusCode = 400
			throw err
		}
		const candidates = []
		const iter = tables.Celebrity.search({
			conditions: { attribute: 'embedding', comparator: 'lt', value: 2, target: vector },
			limit: Math.max(50, limit * 5),
		})
		for await (const r of iter) {
			if (!r.embedding) continue
			candidates.push({ name: r.name, distance: cosineDistance(vector, r.embedding) })
		}
		candidates.sort((a, b) => a.distance - b.distance)
		return { matches: candidates.slice(0, limit) }
	}
}
