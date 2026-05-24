import { Resource, tables } from 'harperdb'

function renderHtml(celebCount, lastImport) {
	const meta = celebCount
		? `${celebCount} celebrities indexed${lastImport ? ` · last refresh ${new Date(lastImport).toLocaleString()}` : ''}`
		: 'Not yet imported — POST /Import to populate the celebrity database.'

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Celebrity Lookalike — Harper Multimodal Embedding Demo</title>
<style>
	:root {
		--bg: #1a1620;
		--panel: #25202d;
		--panel-2: #2d2737;
		--text: #f5f5f5;
		--muted: #b8b0c4;
		--accent: #c63368;
		--accent-2: #7a3a87;
		--green: #66ffcc;
		--border: #3a3344;
	}
	* { box-sizing: border-box; }
	html, body {
		margin: 0; padding: 0;
		background: var(--bg);
		color: var(--text);
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		line-height: 1.55;
	}
	header {
		padding: 24px 32px;
		border-bottom: 1px solid var(--border);
		background: linear-gradient(135deg, #312556 0%, #7a3a87 100%);
	}
	header h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
	header .meta { color: rgba(255,255,255,0.75); font-size: 13px; }
	main { max-width: 1040px; margin: 0 auto; padding: 32px; }

	.dropzone {
		background: var(--panel);
		border: 2px dashed var(--border);
		border-radius: 16px;
		padding: 40px 32px;
		text-align: center;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}
	.dropzone.dragging { border-color: var(--accent); background: var(--panel-2); }
	.dropzone p { margin: 0 0 8px; }
	.dropzone .hint { color: var(--muted); font-size: 13px; }
	.dropzone input { display: none; }
	.dropzone button {
		margin-top: 14px;
		background: var(--accent); color: white; border: none;
		border-radius: 8px; padding: 10px 22px; font-weight: 600;
		font-size: 15px; cursor: pointer;
	}
	.dropzone button:hover { background: var(--accent-2); }

	.preview {
		display: none;
		margin-top: 20px;
		text-align: center;
	}
	.preview img {
		max-width: 220px; max-height: 220px;
		border-radius: 12px;
		border: 1px solid var(--border);
	}
	.preview .actions { margin-top: 12px; display: flex; gap: 8px; justify-content: center; }
	.btn-primary {
		background: var(--accent); color: white; border: none;
		border-radius: 8px; padding: 10px 18px; font-weight: 600;
		cursor: pointer;
	}
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-secondary {
		background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
		border-radius: 8px; padding: 10px 18px; cursor: pointer;
	}

	#results { margin-top: 28px; }
	.result-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 16px;
	}
	.result {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 12px;
		overflow: hidden;
		display: flex; flex-direction: column;
	}
	.result img {
		width: 100%; aspect-ratio: 1; object-fit: cover;
		border-bottom: 1px solid var(--border);
	}
	.result .body { padding: 12px 14px; }
	.result .name {
		font-weight: 600; font-size: 15px;
		color: var(--green);
	}
	.result .name a { color: inherit; text-decoration: none; }
	.result .name a:hover { text-decoration: underline; }
	.result .meta-line {
		color: var(--muted); font-size: 12px;
		margin-top: 4px;
		display: flex; gap: 8px; flex-wrap: wrap;
	}
	.result .pill {
		background: var(--panel-2); border-radius: 10px;
		padding: 2px 8px; font-size: 11px;
	}
	.result .similarity { color: var(--accent); font-weight: 600; }
	.empty { color: var(--muted); font-style: italic; }
	.error { color: #ff8b8b; }
	footer { text-align: center; padding: 24px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<header>
	<h1>🎭 Celebrity Lookalike</h1>
	<span class="meta">${meta}</span>
</header>
<main>
	<div class="dropzone" id="drop">
		<p><strong>Drop a photo</strong> or tap to upload</p>
		<p class="hint">JPEG / PNG · max 8 MB · works best on a centered selfie</p>
		<button type="button" id="pick">Choose a photo</button>
		<input type="file" id="file" accept="image/*" />
	</div>

	<div class="preview" id="preview">
		<img id="preview-img" alt="your upload" />
		<div class="actions">
			<button class="btn-primary" id="go">Find my celebrity match</button>
			<button class="btn-secondary" id="reset">Pick another</button>
		</div>
	</div>

	<div id="results"></div>
</main>
<footer>
	Harper multimodal vector demo · CLIP via vLLM · HNSW cosine search
</footer>

<script>
const $drop = document.getElementById('drop')
const $file = document.getElementById('file')
const $pick = document.getElementById('pick')
const $preview = document.getElementById('preview')
const $previewImg = document.getElementById('preview-img')
const $go = document.getElementById('go')
const $reset = document.getElementById('reset')
const $results = document.getElementById('results')

let currentFile = null

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[c]))
}

function readAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const r = new FileReader()
		r.onload = () => resolve(r.result)
		r.onerror = reject
		r.readAsDataURL(file)
	})
}

function setFile(file) {
	currentFile = file
	if (!file) { $preview.style.display = 'none'; return }
	const url = URL.createObjectURL(file)
	$previewImg.src = url
	$preview.style.display = 'block'
	$results.innerHTML = ''
}

$pick.addEventListener('click', (e) => { e.stopPropagation(); $file.click() })
$drop.addEventListener('click', () => $file.click())
$file.addEventListener('change', () => { if ($file.files[0]) setFile($file.files[0]) })

;['dragenter', 'dragover'].forEach((evt) => {
	$drop.addEventListener(evt, (e) => { e.preventDefault(); $drop.classList.add('dragging') })
})
;['dragleave', 'drop'].forEach((evt) => {
	$drop.addEventListener(evt, (e) => { e.preventDefault(); $drop.classList.remove('dragging') })
})
$drop.addEventListener('drop', (e) => {
	const file = e.dataTransfer.files?.[0]
	if (file) setFile(file)
})

$reset.addEventListener('click', () => { setFile(null); $results.innerHTML = '' })

$go.addEventListener('click', async () => {
	if (!currentFile) return
	$go.disabled = true
	$results.innerHTML = '<div class="empty">Comparing against the celebrity index…</div>'
	try {
		const dataUrl = await readAsDataUrl(currentFile)
		const res = await fetch('/Match', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: dataUrl }),
		})
		if (!res.ok) {
			const text = await res.text()
			$results.innerHTML = '<div class="error">Match failed: ' + escapeHtml(text.slice(0, 240)) + '</div>'
			return
		}
		const data = await res.json()
		const matches = data.matches || []
		if (matches.length === 0) {
			$results.innerHTML = '<div class="empty">No matches found. Has the celebrity index been imported?</div>'
			return
		}
		$results.innerHTML = '<h2 style="margin: 0 0 16px; font-size: 18px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted);">You look most like</h2>' +
			'<div class="result-grid">' +
				matches.map((m, i) => {
					const similarity = typeof m.distance === 'number'
						? (100 * (1 - m.distance)).toFixed(1) + '%'
						: ''
					return '<div class="result">' +
						'<img src="' + escapeHtml(m.photoUrl) + '" alt="' + escapeHtml(m.name) + '" />' +
						'<div class="body">' +
							'<div class="name"><a href="' + escapeHtml(m.wikipediaUrl) + '" target="_blank" rel="noopener">' + escapeHtml(m.name) + '</a></div>' +
							'<div class="meta-line">' +
								'<span class="pill">#' + (i + 1) + '</span>' +
								(m.category ? '<span class="pill">' + escapeHtml(m.category) + '</span>' : '') +
								(similarity ? '<span class="similarity">' + similarity + '</span>' : '') +
							'</div>' +
							(m.blurb ? '<div style="font-size:12px; color:var(--muted); margin-top:6px;">' + escapeHtml(m.blurb) + '</div>' : '') +
						'</div>' +
					'</div>'
				}).join('') +
			'</div>'
	} catch (e) {
		$results.innerHTML = '<div class="error">' + escapeHtml(e.message) + '</div>'
	} finally {
		$go.disabled = false
	}
})
</script>
</body>
</html>`
}

export class Lookalike extends Resource {
	static loadAsInstance = false

	async get(target) {
		target.checkPermission = false
		let count = 0
		const iter = tables.Celebrity.search({ limit: 1, sort: { attribute: 'id' } })
		for await (const _ of iter) count = 1
		// Cheap count: ask LMDB how many records via a full scan with count-only.
		// (Harper exposes a count() helper but compatibility varies; iterating is safe.)
		let total = 0
		for await (const _ of tables.Celebrity.search({ limit: 5000, select: ['id'] })) total++

		let lastImport = null
		for await (const r of tables.ImportLog.search({ limit: 5000, select: ['finishedAt'] })) {
			if (r.finishedAt && (!lastImport || r.finishedAt > lastImport)) lastImport = r.finishedAt
		}

		return new Response(renderHtml(total, lastImport), {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		})
	}
}
