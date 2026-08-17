#!/usr/bin/env node
/**
 * Referência executável do ingest de IFC do Coordly — faz exatamente o que o job
 * .NET vai fazer (ver .claude/plans/next_10-backend-ingest-handoff.md):
 *
 *   SSE parse até `complete` → GET geometria → corta em 3 → GET datamodel/symbolic
 *   → grava os 6 artefatos em {out}/{sha256}/v4/
 *
 * Uso:
 *   node scripts/coordly-ingest.mjs modelo.ifc
 *   node scripts/coordly-ingest.mjs modelo.ifc --server http://localhost:8080 --out ../ifc-files/output
 *
 * Flags: --server (default http://localhost:8080) · --out (default ../ifc-files/output)
 *        --token (Bearer, opcional)
 */
import { createReadStream, openAsBlob } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const VALUE_FLAGS = ['server', 'out', 'token'];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const file = args.find((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = args[i - 1];
  return !(prev?.startsWith('--') && VALUE_FLAGS.includes(prev.slice(2)));
});
const server = flag('server', 'http://localhost:8080').replace(/\/$/, '');
const outRoot = resolve(flag('out', '../ifc-files/output'));
const token = flag('token', process.env.IFC_SERVER_API_TOKEN || '');

if (!file) {
  console.error('uso: node scripts/coordly-ingest.mjs <arquivo.ifc> [--server URL] [--out DIR] [--token T]');
  process.exit(1);
}

const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
const MB = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...m) => console.log(`[${since()}]`, ...m);

/** sha256 do arquivo como está no disco — só pra provar a armadilha do .ifcZIP/.gz. */
async function sha256OfFile(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/**
 * Consome o SSE até `complete`. Abandonar no meio perde o parse inteiro: o
 * stream só avança enquanto é lido (parquet_stream.rs:227).
 */
async function parseViaSse(path) {
  const form = new FormData();
  form.set('file', await openAsBlob(path), basename(path));

  const res = await fetch(`${server}/api/v1/parse/parquet-stream`, {
    method: 'POST',
    headers: authHeaders,
    body: form,
  });
  if (!res.ok) throw new Error(`parse/parquet-stream: HTTP ${res.status} ${await res.text()}`);

  const decoder = new TextDecoder();
  let buf = '';
  let cacheKey = null;
  let batches = 0;
  let meshes = 0;
  let lastProgressLog = 0;
  let complete = null;

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const payload = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!payload) continue;

      const ev = JSON.parse(payload);
      switch (ev.type) {
        case 'start':
          cacheKey = ev.cache_key;
          log(`start · cache_key=${cacheKey} · total_estimate=${ev.total_estimate}`);
          break;
        case 'progress':
          if (Date.now() - lastProgressLog > 5000) {
            lastProgressLog = Date.now();
            log(`progress ${ev.processed}/${ev.total}`);
          }
          break;
        case 'batch':
          // descartado de propósito: serve pro render progressivo do browser
          batches += 1;
          meshes += ev.mesh_count ?? 0;
          break;
        case 'complete':
          complete = ev;
          log(`complete · ${batches} batches, ${meshes} meshes descartados`);
          break;
        case 'error':
          throw new Error(`SSE error: ${ev.message}`);
      }
    }
  }

  if (!cacheKey) throw new Error('SSE terminou sem evento `start` (cache_key perdido)');
  if (!complete) throw new Error('SSE terminou sem evento `complete` — o cache NÃO foi gravado');
  return { cacheKey, complete, batches, meshes };
}

/**
 * Polling com backoff. Usado nos 3 GETs: datamodel/symbolic respondem 202
 * enquanto escrevem, e a geometria responde 404 porque o `set_bytes` roda num
 * tokio::spawn disparado no `complete` — o evento chega antes do blob existir.
 */
async function getWithRetry(url, { accept = [200], retryOn = [202, 404], timeoutMs = 120000, label }) {
  const deadline = Date.now() + timeoutMs;
  let wait = 500;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const res = await fetch(url, { headers: authHeaders });
    if (accept.includes(res.status)) {
      if (attempt > 1) log(`${label}: pronto na tentativa ${attempt}`);
      return res;
    }
    if (!retryOn.includes(res.status)) {
      throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
    }
    if (Date.now() > deadline) throw new Error(`${label}: timeout após ${timeoutMs}ms (último status ${res.status})`);
    if (attempt === 1) log(`${label}: ${res.status}, aguardando…`);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 1.5, 5000);
  }
}

/**
 * O container é [u32 total][u32 len][bytes]… little-endian, sem divisória física.
 * Descarta o u32 externo e o [u32 dmLen=0] do fim.
 */
function splitContainer(body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let p = 4; // pula o u32 externo
  const section = (name) => {
    if (p + 4 > body.byteLength) throw new Error(`corte estourou o buffer em ${name}`);
    const len = view.getUint32(p, true);
    const start = p + 4;
    const end = start + len;
    if (end > body.byteLength) throw new Error(`${name}: len=${len} passa do fim do buffer`);
    p = end;
    return body.subarray(start, end);
  };
  const mesh = section('mesh');
  const vertex = section('vertex');
  const index = section('index');
  const trailing = p + 4 <= body.byteLength ? view.getUint32(p, true) : null;
  return { mesh, vertex, index, trailing, consumed: p + 4 };
}

// Parquet tem o magic PAR1 no início E no fim. Checar os dois pega corte curto
// ou longo — só o header passaria batido se a seção terminasse no lugar errado.
const PAR1 = [0x50, 0x41, 0x52, 0x31];
const isParquet = (b) =>
  b.byteLength > 8 &&
  PAR1.every((v, i) => b[i] === v) &&
  PAR1.every((v, i) => b[b.byteLength - 4 + i] === v);

async function main() {
  const path = resolve(file);
  log(`arquivo: ${path}`);
  log(`server:  ${server}`);

  const diskHash = await sha256OfFile(path);
  log(`sha256 do arquivo em disco: ${diskHash}`);

  const { cacheKey, complete, batches, meshes } = await parseViaSse(path);
  const parseMs = Date.now() - t0;

  const sha256 = cacheKey.split('-')[0];
  if (sha256 !== diskHash) {
    log(`⚠️  hash do disco ≠ hash do server (arquivo comprimido) — a chave válida é a do server`);
  }

  const geoRes = await getWithRetry(`${server}/api/v1/cache/geometry/${sha256}`, {
    label: 'cache/geometry',
  });
  const metadataHeader = geoRes.headers.get('x-ifc-metadata');
  if (!metadataHeader) throw new Error('header X-IFC-Metadata ausente na resposta da geometria');
  const container = new Uint8Array(await geoRes.arrayBuffer());
  log(`geometria: ${MB(container.byteLength)} · metadata header: ${Buffer.byteLength(metadataHeader)} bytes`);

  const { mesh, vertex, index, trailing, consumed } = splitContainer(container);
  for (const [name, buf] of [['mesh', mesh], ['vertex', vertex], ['index', index]]) {
    if (!isParquet(buf)) throw new Error(`${name}.parquet não começa com PAR1 — o corte saiu do lugar`);
  }
  log(`corte OK · mesh ${MB(mesh.byteLength)} · vertex ${MB(vertex.byteLength)} · index ${MB(index.byteLength)}`);
  if (trailing !== 0) log(`⚠️  dmLen esperado 0, veio ${trailing}`);
  if (consumed !== container.byteLength) {
    log(`⚠️  sobraram ${container.byteLength - consumed} bytes não consumidos no container`);
  }

  const dmRes = await getWithRetry(`${server}/api/v1/parse/data-model/${cacheKey}`, { label: 'data-model' });
  const dataModel = new Uint8Array(await dmRes.arrayBuffer());
  const symRes = await getWithRetry(`${server}/api/v1/parse/symbolic/${cacheKey}`, { label: 'symbolic' });
  const symbolic = Buffer.from(await symRes.arrayBuffer());

  const outDir = resolve(outRoot, sha256, 'v4');
  await mkdir(outDir, { recursive: true });
  const artifacts = [
    ['mesh.parquet', mesh],
    ['vertex.parquet', vertex],
    ['index.parquet', index],
    ['metadata.json', Buffer.from(metadataHeader, 'utf8')], // verbatim: não re-serializar
    ['datamodel.parquet', dataModel], // inteiro: tem framing próprio, quem desmonta é o front
    ['symbolic.json', symbolic],
  ];
  for (const [name, buf] of artifacts) await writeFile(resolve(outDir, name), buf);

  console.log('\n─── resumo ───');
  console.log(`cache_key       ${cacheKey}`);
  console.log(`sha256          ${sha256}${sha256 === diskHash ? '' : '  (≠ hash do disco)'}`);
  console.log(`parse (SSE)     ${(parseMs / 1000).toFixed(1)}s · ${batches} batches · ${meshes} meshes`);
  console.log(`total           ${since()}`);
  console.log(`saída           ${outDir}`);
  for (const [name, buf] of artifacts) console.log(`  ${name.padEnd(18)} ${MB(buf.byteLength ?? buf.length)}`);
  if (complete?.stats) console.log(`stats           ${JSON.stringify(complete.stats)}`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
