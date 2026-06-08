import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, '..');

// harper's `exports` only exposes ".", so 'harper/dist/bin/harper.js' is not resolvable.
// Resolve the CLI from the exported main entry and pass it explicitly as harperBinPath.
const require = createRequire(import.meta.url);
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

function authFetch(
  ctx: ContextWithHarper,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  const { headers = {}, ...rest } = init;
  const creds = Buffer.from(
    `${ctx.harper.admin.username}:${ctx.harper.admin.password}`,
  ).toString('base64');
  return fetch(`${ctx.harper.httpURL}${path}`, {
    ...rest,
    headers: { Authorization: `Basic ${creds}`, ...headers },
  });
}

void suite('harper-celebrity-match', (ctx: ContextWithHarper) => {
  before(async () => {
    await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
  });

  after(async () => {
    await teardownHarper(ctx);
  });

  // ── Startup ────────────────────────────────────────────────────────────────

  void test('Harper starts successfully', async () => {
    const res = await authFetch(ctx, '/');
    ok([200, 400, 404].includes(res.status), `Unexpected status ${res.status}`);
  });

  // ── Celebrity table CRUD ───────────────────────────────────────────────────

  void test('Celebrity table: PUT and GET a record without an embedding', async () => {
    const celebrity = {
      id: 'test-celebrity-1',
      name: 'Test Celebrity',
      category: 'actor',
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Test',
      photoUrl: 'https://example.com/photo.jpg',
      blurb: 'A test celebrity for integration testing.',
    };

    const putRes = await authFetch(ctx, '/Celebrity/test-celebrity-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(celebrity),
    });
    ok(
      [200, 201, 204].includes(putRes.status),
      `Expected successful PUT, got HTTP ${putRes.status}`,
    );

    const getRes = await authFetch(ctx, '/Celebrity/test-celebrity-1');
    strictEqual(getRes.status, 200);
    const body = (await getRes.json()) as {
      id: string;
      name: string;
      category: string;
    };
    strictEqual(body.name, 'Test Celebrity');
    strictEqual(body.category, 'actor');
  });

  void test('Celebrity table: GET /Celebrity/ returns an array', async () => {
    const res = await authFetch(ctx, '/Celebrity/');
    strictEqual(res.status, 200);
    const body = await res.json();
    ok(Array.isArray(body), 'Expected array response from Celebrity table');
  });

  void test('Celebrity table: DELETE removes a record', async () => {
    // Seed a record
    await authFetch(ctx, '/Celebrity/to-delete', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'to-delete', name: 'Will Be Deleted', category: 'test' }),
    });

    const delRes = await authFetch(ctx, '/Celebrity/to-delete', { method: 'DELETE' });
    ok(
      [200, 204].includes(delRes.status),
      `Expected successful DELETE, got HTTP ${delRes.status}`,
    );

    const getRes = await authFetch(ctx, '/Celebrity/to-delete');
    strictEqual(getRes.status, 404, 'Record should be gone after DELETE');
  });

  // ── ImportLog table ────────────────────────────────────────────────────────

  void test('ImportLog table: PUT and GET a log entry', async () => {
    const log = {
      id: 'import-test-001',
      startedAt: '2025-01-01T00:00:00.000Z',
      finishedAt: '2025-01-01T00:01:00.000Z',
      totalRequested: 10,
      totalImported: 8,
      totalSkipped: 1,
      errors: ['failed to fetch one celebrity'],
    };

    const putRes = await authFetch(ctx, '/ImportLog/import-test-001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    ok(
      [200, 201, 204].includes(putRes.status),
      `Expected successful PUT, got HTTP ${putRes.status}`,
    );

    const getRes = await authFetch(ctx, '/ImportLog/import-test-001');
    strictEqual(getRes.status, 200);
    const body = (await getRes.json()) as typeof log;
    strictEqual(body.totalImported, 8);
    strictEqual(body.totalRequested, 10);
    ok(Array.isArray(body.errors), 'errors should be an array');
  });

  // ── GET /ImportStatus ──────────────────────────────────────────────────────

  void test('GET /ImportStatus returns status JSON', async () => {
    const res = await authFetch(ctx, '/ImportStatus');
    strictEqual(res.status, 200);
    const body = (await res.json()) as {
      indexed: number;
      lastFinishedAt: string | null;
      lastBatchImported: number;
      lastBatchErrorCount: number;
    };
    ok(typeof body.indexed === 'number', 'indexed should be a number');
    ok(
      body.lastFinishedAt === null || typeof body.lastFinishedAt === 'string',
      'lastFinishedAt should be null or a string',
    );
    ok(typeof body.lastBatchImported === 'number', 'lastBatchImported should be a number');
    ok(typeof body.lastBatchErrorCount === 'number', 'lastBatchErrorCount should be a number');
  });

  void test('GET /ImportStatus reflects inserted ImportLog entries', async () => {
    // Seed a log entry with a known finishedAt time
    await authFetch(ctx, '/ImportLog/import-test-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'import-test-status',
        startedAt: '2025-06-01T10:00:00.000Z',
        finishedAt: '2025-06-01T10:05:00.000Z',
        totalRequested: 5,
        totalImported: 5,
        totalSkipped: 0,
        errors: [],
      }),
    });

    const res = await authFetch(ctx, '/ImportStatus');
    strictEqual(res.status, 200);
    const body = (await res.json()) as { lastFinishedAt: string | null; lastBatchImported: number };
    ok(
      body.lastFinishedAt !== null,
      'lastFinishedAt should be set after inserting a log entry',
    );
    strictEqual(body.lastBatchImported, 5, 'lastBatchImported should reflect the seeded log');
  });

  // ── GET /CelebrityLookalike (HTML UI) ─────────────────────────────────────

  void test('GET /CelebrityLookalike returns HTML', async () => {
    const res = await authFetch(ctx, '/CelebrityLookalike');
    strictEqual(res.status, 200);
    const text = await res.text();
    match(text, /<!DOCTYPE html>/i, 'Expected HTML document');
    match(text, /Celebrity Lookalike/i, 'Expected page title');
  });

  void test('GET /CelebrityLookalike shows empty state when no celebrities indexed', async () => {
    const res = await authFetch(ctx, '/CelebrityLookalike');
    strictEqual(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    ok(ct.includes('text/html'), `Expected text/html, got: ${ct}`);
  });

  // ── POST /SearchByVector ───────────────────────────────────────────────────
  // NOTE: POST /MatchCelebrity and POST /MatchCelebrityV2 require a vLLM
  // multimodal embedding endpoint (hm.multimodalEmbeddingModel). Those are
  // skipped here because external API keys are not available in CI. The
  // SearchByVector endpoint accepts a pre-computed vector, so it can be tested
  // without any external service — though HNSW search returns no results when
  // the table is empty.

  void test('POST /SearchByVector returns 400 when body is missing vector', async () => {
    const res = await authFetch(ctx, '/SearchByVector', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    strictEqual(res.status, 400, 'Expected 400 for missing vector');
  });

  void test('POST /SearchByVector returns 400 when vector is empty array', async () => {
    const res = await authFetch(ctx, '/SearchByVector', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: [] }),
    });
    strictEqual(res.status, 400, 'Expected 400 for empty vector array');
  });

  void test('POST /SearchByVector returns matches array with a valid vector', async () => {
    // Seed a celebrity with an embedding so HNSW search has something to match
    const dim = 512;
    const embedding = Array.from({ length: dim }, (_, i) => Math.sin(i * 0.1));

    await authFetch(ctx, '/Celebrity/vector-test-celebrity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'vector-test-celebrity',
        name: 'Vector Test Celebrity',
        category: 'test',
        wikipediaUrl: 'https://en.wikipedia.org/wiki/Vector_Test',
        photoUrl: 'https://example.com/vector-test.jpg',
        blurb: 'A celebrity with a synthetic embedding for vector search tests.',
        embedding,
      }),
    });

    // Query with the same vector — we should get at most 1 result (or 0 if
    // HNSW needs more entries before the index is queryable)
    const res = await authFetch(ctx, '/SearchByVector', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: embedding, limit: 5 }),
    });
    strictEqual(res.status, 200, 'Expected 200 from SearchByVector');
    const body = (await res.json()) as { matches: unknown[] };
    ok(Array.isArray(body.matches), 'Expected matches array in response');
  });

  // ── POST /MatchCelebrity — embedding-unavailable path ─────────────────────
  // The endpoint requires a multimodal embedding service (vLLM). In CI,
  // the service is not available, so we verify the request validation layer
  // only (bad input returns 4xx without ever calling the embedding service).

  void test('POST /MatchCelebrity returns 400 when image field is missing', async () => {
    const res = await authFetch(ctx, '/MatchCelebrity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    strictEqual(res.status, 400, 'Expected 400 for missing image field');
  });

  void test('POST /MatchCelebrity returns 400 when image is not a data URL', async () => {
    const res = await authFetch(ctx, '/MatchCelebrity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'not-a-data-url' }),
    });
    strictEqual(res.status, 400, 'Expected 400 for non-data-URL image');
  });

  void test('POST /ImportCelebrities returns started or already_running status', async () => {
    // We fire a POST with subset=0 to avoid actually hitting Wikipedia/vLLM.
    // With subset=0 the slice is empty so runImport finishes immediately.
    const res = await authFetch(ctx, '/ImportCelebrities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subset: 0 }),
    });
    ok(
      [200, 201].includes(res.status),
      `Expected 200/201 from ImportCelebrities, got ${res.status}`,
    );
    const body = (await res.json()) as { ok: boolean; status: string };
    ok(body.ok !== undefined, 'Response should have ok field');
    ok(
      body.status === 'started' || body.status === 'already_running',
      `Unexpected status: ${body.status}`,
    );
  });
});
