// PinForge Jobs API - Simple, reliable, no external dependencies
// Uses global memory (works fine for sequential single-session use)
// Jobs persist as long as the Vercel instance stays warm (10-30 min)
// For longer sessions: redeploy with Vercel KV (see README)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension',
};

// Simple in-memory store - no imports, no dependencies, always works
if (!global._pf) global._pf = { jobs: [], extTs: 0 };

function getJobs() { return global._pf.jobs; }
function markExt()  { global._pf.extTs = Date.now(); }
function extAlive() { return Date.now() - global._pf.extTs < 20000; }

export default function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.headers['x-pinforge-extension']) markExt();

  const { action } = req.query;

  // PING
  if (action === 'ping') {
    const jobs = getJobs();
    res.json({
      pinforge: true,
      extensionOnline: extAlive(),
      pending: jobs.filter(j => j.status === 'pending').length,
      working: jobs.filter(j => j.status === 'working').length,
      total: jobs.length,
    });
    return;
  }

  // QUEUE - show all jobs for display
  if (action === 'queue') {
    res.json({ jobs: getJobs().slice(-100).map(j => ({ id: j.id, url: j.url, status: j.status, error: j.error || null })) });
    return;
  }

  // NEXT - extension polls for work
  if (action === 'next' && req.method === 'GET') {
    const jobs = getJobs();
    // Expire stale working jobs (> 6 min)
    jobs.forEach(j => {
      if (j.status === 'working' && Date.now() - new Date(j.startedAt || 0).getTime() > 360000) {
        j.status = 'error'; j.error = 'Timed out after 6 minutes';
      }
    });
    const busy = jobs.find(j => j.status === 'working');
    if (busy) { res.json({ job: null }); return; }
    const next = jobs.find(j => j.status === 'pending');
    if (!next) { res.json({ job: null }); return; }
    next.status = 'working';
    next.startedAt = new Date().toISOString();
    res.json({ job: { id: next.id, url: next.url, prompt: next.prompt, provider: next.provider } });
    return;
  }

  // ENQUEUE - webapp adds jobs
  if (action === 'enqueue' && req.method === 'POST') {
    const { jobs: incoming } = req.body || {};
    if (!Array.isArray(incoming)) { res.status(400).json({ error: 'jobs must be array' }); return; }
    const jobs = getJobs();
    let added = 0;
    for (const j of incoming) {
      if (!j.id || !j.prompt) continue;
      if (jobs.find(x => x.id === j.id)) continue;
      jobs.push({ id: j.id, url: j.url || '', prompt: j.prompt, provider: j.provider || 'claude',
        status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null });
      added++;
    }
    res.json({ ok: true, added, total: jobs.length });
    return;
  }

  // COMPLETE - extension posts result
  if (action === 'complete' && req.method === 'POST') {
    const { jobId, result } = req.body || {};
    if (!jobId) { res.status(400).json({ error: 'Missing jobId' }); return; }
    const jobs = getJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) {
      // Cold start: job list was reset. Store result anyway.
      job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending',
        result: null, error: null, createdAt: new Date().toISOString(), startedAt: null };
      jobs.push(job);
    }
    job.status = 'done';
    job.result = result;
    job.completedAt = new Date().toISOString();
    res.json({ ok: true });
    return;
  }

  // FAIL - extension reports error
  if (action === 'fail' && req.method === 'POST') {
    const { jobId, error } = req.body || {};
    if (!jobId) { res.status(400).json({ error: 'Missing jobId' }); return; }
    const jobs = getJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) {
      job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending',
        result: null, error: null, createdAt: new Date().toISOString(), startedAt: null };
      jobs.push(job);
    }
    job.status = 'error';
    job.error = error || 'Unknown error';
    res.json({ ok: true });
    return;
  }

  // RESULTS - webapp polls for completed jobs
  if (action === 'results' && req.method === 'GET') {
    res.json({
      results: getJobs()
        .filter(j => j.status === 'done' || j.status === 'error')
        .map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error }))
    });
    return;
  }

  // CLEAR - remove acknowledged jobs
  if (action === 'clear' && req.method === 'POST') {
    const { ids } = req.body || {};
    if (Array.isArray(ids)) global._pf.jobs = getJobs().filter(j => !ids.includes(j.id));
    res.json({ ok: true, remaining: getJobs().length });
    return;
  }

  // RESET - clear everything (debug)
  if (action === 'reset' && req.method === 'POST') {
    global._pf.jobs = [];
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
}
