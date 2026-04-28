// PinForge Jobs API
// Uses global memory. On Vercel, keep instance warm by polling frequently.
// The extension polls every 2.5s which keeps the instance alive.
// Webapp polls every 2.5s too — same instance stays warm for entire session.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension',
};

if (!global._pf) global._pf = { jobs: [], extTs: 0 };

const store = global._pf;

function markExt() { store.extTs = Date.now(); }
function extAlive() { return Date.now() - store.extTs < 30000; }

export default function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.headers['x-pinforge-extension']) markExt();

  const { action } = req.query;

  // ── PING ──────────────────────────────────────────────────
  if (action === 'ping') {
    res.json({
      pinforge: true,
      extensionOnline: extAlive(),
      pending: store.jobs.filter(j => j.status === 'pending').length,
      working: store.jobs.filter(j => j.status === 'working').length,
      done:    store.jobs.filter(j => j.status === 'done').length,
      total:   store.jobs.length,
    });
    return;
  }

  // ── QUEUE ─────────────────────────────────────────────────
  if (action === 'queue') {
    res.json({
      jobs: store.jobs.slice(-100).map(j => ({
        id: j.id, url: j.url, status: j.status, error: j.error || null
      }))
    });
    return;
  }

  // ── NEXT (extension polls) ─────────────────────────────────
  if (action === 'next' && req.method === 'GET') {
    // Expire stale working jobs
    store.jobs.forEach(j => {
      if (j.status === 'working' && Date.now() - new Date(j.startedAt || 0).getTime() > 360000) {
        j.status = 'error';
        j.error = 'Timed out after 6 minutes';
      }
    });
    const busy = store.jobs.find(j => j.status === 'working');
    if (busy) { res.json({ job: null }); return; }
    const next = store.jobs.find(j => j.status === 'pending');
    if (!next) { res.json({ job: null }); return; }
    next.status = 'working';
    next.startedAt = new Date().toISOString();
    res.json({ job: { id: next.id, url: next.url, prompt: next.prompt, provider: next.provider } });
    return;
  }

  // ── ENQUEUE ───────────────────────────────────────────────
  if (action === 'enqueue' && req.method === 'POST') {
    const { jobs: incoming } = req.body || {};
    if (!Array.isArray(incoming)) { res.status(400).json({ error: 'jobs must be array' }); return; }
    let added = 0;
    for (const j of incoming) {
      if (!j.id || !j.prompt) continue;
      if (store.jobs.find(x => x.id === j.id)) continue;
      store.jobs.push({
        id: j.id, url: j.url || '', prompt: j.prompt,
        provider: j.provider || 'claude', status: 'pending',
        result: null, error: null,
        createdAt: new Date().toISOString(), startedAt: null,
      });
      added++;
    }
    res.json({ ok: true, added, total: store.jobs.length });
    return;
  }

  // ── COMPLETE ──────────────────────────────────────────────
  if (action === 'complete' && req.method === 'POST') {
    const { jobId, result } = req.body || {};
    if (!jobId) { res.status(400).json({ error: 'Missing jobId' }); return; }
    let job = store.jobs.find(j => j.id === jobId);
    if (!job) {
      // Cold-start miss — store as orphan so webapp can still get it
      store.jobs.push({
        id: jobId, url: '', prompt: '', provider: '', status: 'done',
        result, error: null,
        createdAt: new Date().toISOString(), startedAt: null,
        completedAt: new Date().toISOString(),
      });
    } else {
      job.status = 'done';
      job.result = result;
      job.completedAt = new Date().toISOString();
    }
    res.json({ ok: true });
    return;
  }

  // ── FAIL ──────────────────────────────────────────────────
  if (action === 'fail' && req.method === 'POST') {
    const { jobId, error } = req.body || {};
    if (!jobId) { res.status(400).json({ error: 'Missing jobId' }); return; }
    let job = store.jobs.find(j => j.id === jobId);
    if (!job) {
      store.jobs.push({
        id: jobId, url: '', prompt: '', provider: '', status: 'error',
        result: null, error: error || 'Unknown',
        createdAt: new Date().toISOString(), startedAt: null,
      });
    } else {
      job.status = 'error';
      job.error = error;
    }
    res.json({ ok: true });
    return;
  }

  // ── RESULTS (webapp polls for completed) ──────────────────
  if (action === 'results' && req.method === 'GET') {
    res.json({
      results: store.jobs
        .filter(j => j.status === 'done' || j.status === 'error')
        .map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error }))
    });
    return;
  }

  // ── CLEAR (remove acknowledged jobs) ──────────────────────
  if (action === 'clear' && req.method === 'POST') {
    const { ids } = req.body || {};
    if (Array.isArray(ids)) store.jobs = store.jobs.filter(j => !ids.includes(j.id));
    res.json({ ok: true, remaining: store.jobs.length });
    return;
  }

  // ── DOWNLOAD (extension fetches all pending jobs at once) ───
  if (action === 'download' && req.method === 'GET') {
    // Only return truly pending jobs — never reset working/done
    const pending = store.jobs.filter(j => j.status === 'pending');
    res.json({ jobs: pending });
    return;
  }

    // ── RESET (new project / clear all) ───────────────────────
  if (action === 'reset' && req.method === 'POST') {
    store.jobs = [];
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
}
