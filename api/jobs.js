// ═══════════════════════════════════════════════════════════════
// PinForge Jobs API
// GET  /api/jobs?action=ping          - extension health check
// GET  /api/jobs?action=next          - extension polls for next job
// GET  /api/jobs?action=queue         - popup fetches queue for display
// POST /api/jobs?action=enqueue       - webapp adds jobs to queue
// POST /api/jobs?action=complete      - extension posts result
// POST /api/jobs?action=fail          - extension posts error
// ═══════════════════════════════════════════════════════════════

// In-memory store (Vercel serverless — use KV/Redis for production persistence)
// For Vercel edge persistence, jobs are stored in a global variable
// that survives warm instances. For full persistence swap with Vercel KV.
if (!global._pfJobs)   global._pfJobs   = [];   // { id, url, prompt, provider, status, result, error, createdAt }
if (!global._pfSecret) global._pfSecret = null;  // optional auth token

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension, X-PinForge-Secret',
};

export default async function handler(req, res) {
  // CORS preflight
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || '';

  // ── PING ──────────────────────────────────────────────────
  if (action === 'ping') {
    return res.json({
      pinforge: true,
      version:  '1.0.0',
      jobs:     global._pfJobs.length,
      pending:  global._pfJobs.filter(j => j.status === 'pending').length,
    });
  }

  // ── QUEUE (popup display) ─────────────────────────────────
  if (action === 'queue') {
    const jobs = global._pfJobs.slice(-50).map(j => ({
      id:     j.id,
      url:    j.url,
      status: j.status,
      error:  j.error || null,
    }));
    return res.json({ jobs });
  }

  // ── NEXT JOB (extension polls) ────────────────────────────
  if (action === 'next' && req.method === 'GET') {
    // Only serve if no job is currently being worked
    const working = global._pfJobs.find(j => j.status === 'working');
    if (working) {
      // Check if it's been working too long (3 min = stale)
      const age = Date.now() - new Date(working.startedAt).getTime();
      if (age > 180000) {
        working.status = 'error';
        working.error  = 'Timed out after 3 minutes';
      } else {
        return res.json({ job: null }); // busy
      }
    }

    const next = global._pfJobs.find(j => j.status === 'pending');
    if (!next) return res.json({ job: null });

    next.status    = 'working';
    next.startedAt = new Date().toISOString();

    return res.json({
      job: {
        id:       next.id,
        url:      next.url,
        prompt:   next.prompt,
        provider: next.provider,
      }
    });
  }

  // ── ENQUEUE (webapp posts jobs) ───────────────────────────
  if (action === 'enqueue' && req.method === 'POST') {
    const { jobs } = req.body; // array of { id, url, prompt, provider }
    if (!Array.isArray(jobs)) return res.status(400).json({ error: 'jobs must be array' });

    let added = 0;
    for (const j of jobs) {
      if (!j.id || !j.prompt) continue;
      // Skip if already exists
      if (global._pfJobs.find(x => x.id === j.id)) continue;
      global._pfJobs.push({
        id:        j.id,
        url:       j.url || '',
        prompt:    j.prompt,
        provider:  j.provider || 'claude',
        status:    'pending',
        result:    null,
        error:     null,
        createdAt: new Date().toISOString(),
        startedAt: null,
      });
      added++;
    }

    return res.json({ ok: true, added });
  }

  // ── COMPLETE (extension posts result) ─────────────────────
  if (action === 'complete' && req.method === 'POST') {
    const { jobId, result } = req.body;
    const job = global._pfJobs.find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    job.status      = 'done';
    job.result      = result;
    job.completedAt = new Date().toISOString();

    return res.json({ ok: true });
  }

  // ── FAIL (extension posts error) ──────────────────────────
  if (action === 'fail' && req.method === 'POST') {
    const { jobId, error } = req.body;
    const job = global._pfJobs.find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    job.status = 'error';
    job.error  = error;

    return res.json({ ok: true });
  }

  // ── POLL RESULTS (webapp polls for done jobs) ─────────────
  if (action === 'results' && req.method === 'GET') {
    const done = global._pfJobs
      .filter(j => j.status === 'done' || j.status === 'error')
      .map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error }));
    return res.json({ results: done });
  }

  // ── CLEAR DONE JOBS ───────────────────────────────────────
  if (action === 'clear' && req.method === 'POST') {
    const { ids } = req.body;
    if (Array.isArray(ids)) {
      global._pfJobs = global._pfJobs.filter(j => !ids.includes(j.id));
    }
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
