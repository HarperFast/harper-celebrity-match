// Direct multimodal-embed helper. We bypass scope.models.embed() because
// it's tailored for text input — vLLM's image-embed flow expects the OpenAI
// chat-message format with `image_url` content blocks, which scope.models
// doesn't currently relay.
//
// Reads baseUrl + apiKey from Harper's models.embedding.multimodal config
// block (host-manager injects this into HARPER_SET_CONFIG when
// hm.multimodalEmbeddingModel is enabled).

let cachedConfig = null

function readMultimodalConfig() {
	if (cachedConfig) return cachedConfig
	// harperdb exposes its config under server.config in v5+
	const cfg = globalThis.server?.config?.models?.embedding?.multimodal
	if (!cfg?.baseUrl || !cfg?.apiKey || !cfg?.model) {
		const err = new Error(
			'models.embedding.multimodal not configured. Set hm.multimodalEmbeddingModel on the host-manager to enable.',
		)
		err.statusCode = 503
		throw err
	}
	cachedConfig = cfg
	return cfg
}

/** Embed an image URL (vLLM fetches it itself). Returns Float[]. */
export async function embedImageUrl(url) {
	const { baseUrl, apiKey, model } = readMultimodalConfig()
	const body = {
		model,
		messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
	}
	const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`embed ${res.status}: ${text.slice(0, 200)}`)
	}
	const json = await res.json()
	const v = json.data?.[0]?.embedding
	if (!Array.isArray(v) || v.length === 0) {
		throw new Error('empty embedding response')
	}
	return v
}

/** Embed image bytes (Buffer or Uint8Array) by sending as base64 data URL. */
export async function embedImageBytes(bytes, mimeType = 'image/jpeg') {
	const b64 = Buffer.from(bytes).toString('base64')
	return embedImageUrl(`data:${mimeType};base64,${b64}`)
}
