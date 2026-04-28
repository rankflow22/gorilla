// ═══════════════════════════════════════════════════════════════
// PinForge Jobs API — Vercel KV backed (persistent across instances)
//
// ONE-TIME SETUP:
//   vercel link
//   vercel kv create pinforge-jobs
//   vercel env pull .env.local
//   vercel --prod
// ═══════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension',
};

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const JOBS_KEY = 'pf_jobs_v2';
const JOB_TTL  = 86400; // 24h

// ─── KV HELPERS ──────────────────────────────────────────────
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const d = await r.json();
    if (d.result == null) return null;
    return typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
  } catch (e) { console.error('kvGet error', e.message); return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', JOB_TTL]]),
    });
  } catch (e) { console.error('kvSet error', e.message); }
}

async function getJobs() {
  const j = await kvGet(JOBS_KEY);
  return Array.isArray(j) ? j : [];
}

async function saveJobs(jobs) {
  await kvSet(JOBS_KEY, jobs);
}

// ─── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  // PING
  if (action === 'ping') {
    const jobs = await getJobs();
    return res.json({
      pinforge: true, version: '1.0.0',
      jobs: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      kv: !!(KV_URL && KV_TOKEN),
    });
  }

  // QUEUE
  if (action === 'queue') {
    const jobs = await getJobs();
    return res.json({ jobs: jobs.slice(-50).map(j => ({ id: j.id, url: j.url, status: j.status, error: j.error || null })) });
  }

  // NEXT (extension polls)
  if (action === 'next' && req.method === 'GET') {
    const jobs = await getJobs();
    let changed = false;

    // Expire stale working jobs > 6 min
    jobs.forEach(j => {
      if (j.status === 'working') {
        const age = Date.now() - new Date(j.startedAt || 0).getTime();
        if (age > 360000) { j.status = 'error'; j.error = 'Timed out (6 min)'; changed = true; }
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

  // ENQUEUE
  if (action === 'enqueue' && req.method === 'POST') {
    const { jobs: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'jobs must be array' });

    const jobs = await getJobs();
    let added = 0;
    for (const j of incoming) {
      if (!j.id || !j.prompt) continue;
      if (jobs.find(x => x.id === j.id)) continue;
      jobs.push({ id: j.id, url: j.url || '', prompt: j.prompt, provider: j.provider || 'claude',
        status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null });
      added++;
    }
    await saveJobs(jobs);
    return res.json({ ok: true, added });
  }

  // COMPLETE
  if (action === 'complete' && req.method === 'POST') {
    const { jobId, result } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const jobs = await getJobs();
    let job = jobs.find(j => j.id === jobId);

    if (!job) {
      // KV miss — store result as orphan so webapp can still pick it up
      console.warn('[PF] complete: job not found in KV:', jobId);
      jobs.push({ id: jobId, url: '', prompt: '', provider: '', status: 'done',
        result, error: null, createdAt: new Date().toISOString(), startedAt: null,
        completedAt: new Date().toISOString() });
      await saveJobs(jobs);
      return res.json({ ok: true, orphan: true });
    }

    job.status = 'done';
    job.result = result;
    job.completedAt = new Date().toISOString();
    await saveJobs(jobs);
    return res.json({ ok: true });
  }

  // FAIL
  if (action === 'fail' && req.method === 'POST') {
    const { jobId, error } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const jobs = await getJobs();
    const job  = jobs.find(j => j.id === jobId);
    if (!job) {
      // Still store failure
      jobs.push({ id: jobId, url: '', prompt: '', provider: '', status: 'error',
        result: null, error: error || 'Unknown', createdAt: new Date().toISOString(), startedAt: null });
      await saveJobs(jobs);
      return res.json({ ok: true, orphan: true });
    }
    job.status = 'error';
    job.error  = error;
    await saveJobs(jobs);
    return res.json({ ok: true });
  }

  // RESULTS
  if (action === 'results' && req.method === 'GET') {
    const jobs = await getJobs();
    return res.json({
      results: jobs.filter(j => j.status === 'done' || j.status === 'error')
        .map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error }))
    });
  }

  // CLEAR
  if (action === 'clear' && req.method === 'POST') {
    const { ids } = req.body;
    if (Array.isArray(ids)) {
      const jobs = await getJobs();
      await saveJobs(jobs.filter(j => !ids.includes(j.id)));
    }
    return res.json({ ok: true });
  }

  // RESET (debug)
  if (action === 'reset' && req.method === 'POST') {
    await saveJobs([]);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
