// ═══════════════════════════════════════════════════════════════
// PinForge Jobs API
//
// Storage priority:
//   1. Vercel KV  (if KV_REST_API_URL + KV_REST_API_TOKEN set)
//   2. global._pfJobs in-memory (works on single warm instance)
//
// For production with 100 URLs: set up Vercel KV (free):
//   vercel kv create pinforge-jobs && vercel --prod
// ═══════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension',
};

// ─── STORAGE LAYER ────────────────────────────────────────────
// Uses KV if available, falls back to global memory
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const JOBS_KEY = 'pf_jobs_v2';

// In-memory fallback (lost on cold start — acceptable for single-session use)
if (!global._pfStore) global._pfStore = { jobs: [], extSeen: 0 };

async function getJobs() {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${JOBS_KEY}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const d = await r.json();
      if (d.result) return JSON.parse(d.result);
    } catch (e) { console.error('KV get error:', e.message); }
  }
  return global._pfStore.jobs;
}

async function saveJobs(jobs) {
  global._pfStore.jobs = jobs; // always update memory
  if (KV_URL && KV_TOKEN) {
    try {
      await fetch(`${KV_URL}/set/${JOBS_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(jobs), ex: 86400 }),
      });
    } catch (e) { console.error('KV set error:', e.message); }
  }
}

// Extension heartbeat (in-memory only — just needs to survive a few seconds)
function markExtensionAlive() { global._pfStore.extSeen = Date.now(); }
function isExtensionAlive() { return Date.now() - (global._pfStore.extSeen || 0) < 15000; }

// ─── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  // ── PING ────────────────────────────────────────────────────
  if (action === 'ping') {
    // Extension calls ping too — use it as heartbeat
    const isExt = req.headers['x-pinforge-extension'];
    if (isExt) markExtensionAlive();

    const jobs = await getJobs();
    return res.json({
      pinforge:          true,
      version:           '1.0.0',
      extensionOnline:   isExtensionAlive(),
      kv:                !!(KV_URL && KV_TOKEN),
      pending:           jobs.filter(j => j.status === 'pending').length,
      jobs:              jobs.length,
    });
  }

  // ── QUEUE ────────────────────────────────────────────────────
  if (action === 'queue') {
    const isExt = req.headers['x-pinforge-extension'];
    if (isExt) markExtensionAlive();

    const jobs = await getJobs();
    return res.json({ jobs: jobs.slice(-50).map(j => ({ id: j.id, url: j.url, status: j.status, error: j.error || null })) });
  }

  // ── NEXT JOB ─────────────────────────────────────────────────
  if (action === 'next' && req.method === 'GET') {
    // Extension is alive if it's polling
    markExtensionAlive();

    const jobs = await getJobs();

    // Expire stale working jobs > 6 min
    let changed = false;
    jobs.forEach(j => {
      if (j.status === 'working') {
        if (Date.now() - new Date(j.startedAt || 0).getTime() > 360000) {
          j.status = 'error'; j.error = 'Timed out'; changed = true;
        }
      }
    });

    const working = jobs.find(j => j.status === 'working');
    if (working) { if (changed) await saveJobs(jobs); return res.json({ job: null }); }

    const next = jobs.find(j => j.status === 'pending');
    if (!next) { if (changed) await saveJobs(jobs); return res.json({ job: null }); }

    next.status    = 'working';
    next.startedAt = new Date().toISOString();
    await saveJobs(jobs);

    return res.json({ job: { id: next.id, url: next.url, prompt: next.prompt, provider: next.provider } });
  }

  // ── ENQUEUE ──────────────────────────────────────────────────
  if (action === 'enqueue' && req.method === 'POST') {
    const { jobs: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'jobs must be array' });

    const jobs = await getJobs();
    let added = 0;
    for (const j of incoming) {
      if (!j.id || !j.prompt) continue;
      if (jobs.find(x => x.id === j.id)) continue;
      jobs.push({
        id: j.id, url: j.url || '', prompt: j.prompt,
        provider: j.provider || 'claude', status: 'pending',
        result: null, error: null,
        createdAt: new Date().toISOString(), startedAt: null,
      });
      added++;
    }
    await saveJobs(jobs);
    return res.json({ ok: true, added });
  }

  // ── COMPLETE ─────────────────────────────────────────────────
  if (action === 'complete' && req.method === 'POST') {
    markExtensionAlive();
    const { jobId, result } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const jobs = await getJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) {
      // KV cold-start miss — create the job entry so webapp can pick it up
      console.warn('[PF] complete: job', jobId, 'not in store — creating orphan');
      job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending',
        result: null, error: null, createdAt: new Date().toISOString(), startedAt: null };
      jobs.push(job);
    }
    job.status = 'done';
    job.result = result;
    job.completedAt = new Date().toISOString();
    await saveJobs(jobs);
    return res.json({ ok: true });
  }

  // ── FAIL ─────────────────────────────────────────────────────
  if (action === 'fail' && req.method === 'POST') {
    markExtensionAlive();
    const { jobId, error } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const jobs = await getJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) {
      job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending',
        result: null, error: null, createdAt: new Date().toISOString(), startedAt: null };
      jobs.push(job);
    }
    job.status = 'error';
    job.error  = error;
    await saveJobs(jobs);
    return res.json({ ok: true });
  }

  // ── RESULTS ──────────────────────────────────────────────────
  if (action === 'results' && req.method === 'GET') {
    const jobs = await getJobs();
    return res.json({
      results: jobs.filter(j => j.status === 'done' || j.status === 'error')
        .map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error }))
    });
  }

  // ── CLEAR ────────────────────────────────────────────────────
  if (action === 'clear' && req.method === 'POST') {
    const { ids } = req.body;
    if (Array.isArray(ids)) {
      const jobs = await getJobs();
      await saveJobs(jobs.filter(j => !ids.includes(j.id)));
    }
    return res.json({ ok: true });
  }

  // ── RESET ────────────────────────────────────────────────────
  if (action === 'reset' && req.method === 'POST') {
    await saveJobs([]);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
