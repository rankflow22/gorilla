// PinForge Jobs API — Vercel KV (Redis) backed
// Fully persistent across all serverless instances
// Setup: vercel kv create pinforge && vercel --prod

import { kv } from '@vercel/kv';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension',
};

const KEY = 'pf:jobs';
const TTL = 86400; // 24h

async function getJobs() {
  try {
    const jobs = await kv.get(KEY);
    return Array.isArray(jobs) ? jobs : [];
  } catch { return []; }
}

async function saveJobs(jobs) {
  try { await kv.set(KEY, jobs, { ex: TTL }); } catch (e) { console.error('KV save error:', e.message); }
}

// Extension heartbeat
async function markExt() {
  try { await kv.set('pf:ext_seen', Date.now(), { ex: 30 }); } catch {}
}
async function extOnline() {
  try { const t = await kv.get('pf:ext_seen'); return t && Date.now() - t < 20000; } catch { return false; }
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isExt = !!req.headers['x-pinforge-extension'];
  if (isExt) markExt();

  const action = req.query.action || '';

  if (action === 'ping') {
    const jobs = await getJobs();
    return res.json({
      pinforge: true,
      extensionOnline: await extOnline(),
      pending: jobs.filter(j => j.status === 'pending').length,
      working: jobs.filter(j => j.status === 'working').length,
    });
  }

  if (action === 'queue') {
    const jobs = await getJobs();
    return res.json({ jobs: jobs.slice(-50).map(j => ({ id: j.id, url: j.url, status: j.status, error: j.error || null })) });
  }

  if (action === 'next' && req.method === 'GET') {
    const jobs = await getJobs();
    // Expire stale working > 6min
    jobs.forEach(j => {
      if (j.status === 'working' && Date.now() - new Date(j.startedAt || 0).getTime() > 360000) {
        j.status = 'error'; j.error = 'Timed out';
      }
    });
    const working = jobs.find(j => j.status === 'working');
    if (working) { await saveJobs(jobs); return res.json({ job: null }); }
    const next = jobs.find(j => j.status === 'pending');
    if (!next) { await saveJobs(jobs); return res.json({ job: null }); }
    next.status = 'working';
    next.startedAt = new Date().toISOString();
    await saveJobs(jobs);
    return res.json({ job: { id: next.id, url: next.url, prompt: next.prompt, provider: next.provider } });
  }

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

  if (action === 'complete' && req.method === 'POST') {
    const { jobId, result } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
    const jobs = await getJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) { job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null }; jobs.push(job); }
    job.status = 'done'; job.result = result; job.completedAt = new Date().toISOString();
    await saveJobs(jobs);
    return res.json({ ok: true });
  }

  if (action === 'fail' && req.method === 'POST') {
    const { jobId, error } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
    const jobs = await getJobs();
    let job = jobs.find(j => j.id === jobId);
    if (!job) { job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null }; jobs.push(job); }
    job.status = 'error'; job.error = error;
    await saveJobs(jobs);
    return res.json({ ok: true });
  }

  if (action === 'results' && req.method === 'GET') {
    const jobs = await getJobs();
    return res.json({ results: jobs.filter(j => j.status === 'done' || j.status === 'error').map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error })) });
  }

  if (action === 'clear' && req.method === 'POST') {
    const { ids } = req.body;
    if (Array.isArray(ids)) { const jobs = await getJobs(); await saveJobs(jobs.filter(j => !ids.includes(j.id))); }
    return res.json({ ok: true });
  }

  if (action === 'reset' && req.method === 'POST') {
    await saveJobs([]);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
