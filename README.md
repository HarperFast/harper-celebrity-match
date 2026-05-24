# harper-celebrity-match

Upload a photo, find the celebrity you most look like — a Harper multimodal-vector demo.

* **Embedding model**: `openai/clip-vit-large-patch14` served by vLLM (the third container in the Harper Fabric inference stack, behind `models.embedding.multimodal`).
* **Search**: HNSW cosine similarity over the `Celebrity.embedding` column.
* **Dataset**: ~200 curated public figures (actors, musicians, athletes, politicians, business, royals, directors), photos pulled from the Wikipedia REST API.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET`  | `/CelebrityLookalike` | Demo page with drag-drop image upload |
| `POST` | `/MatchCelebrity`     | Body = JSON `{ image: "data:image/jpeg;base64,…" }` or raw image bytes. Returns top-N celebrity matches |
| `POST` | `/ImportCelebrities`    | Body = JSON `{ subset?: number }` — pulls Wikipedia summaries, downloads thumbnails, embeds and stores. Idempotent |

## Bring-up

1. The host needs `hm.multimodalEmbeddingModel` enabled on its host-manager — the demo refuses to start otherwise.
2. Deploy this repo as a Harper component on a tenant on that host.
3. `curl -X POST -d '{}' https://<tenant-fqdn>/Import` — full import takes ~5 minutes (one CLIP forward pass per celebrity).
4. Open `https://<tenant-fqdn>/Lookalike` and drag in a selfie.

## Disclaimer

This is a tech demo, not a face-recognition product. It compares whole-image
embeddings; the results are entertainment-grade, not biometric. The celebrity
database is built from public Wikipedia infobox photos.
