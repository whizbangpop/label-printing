import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AgentHub } from './agents.js';
import { accessMiddleware, accessVerificationEnabled, safeEqual, verifyAccess } from './auth.js';
import { getTemplate, loadTemplates, publicTemplate, USER_DIR } from './templates.js';
import { renderLabel } from './render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_PATH = process.env.AGENT_PATH || '/agent';
const MAX_COPIES = Number(process.env.MAX_COPIES || 20);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60_000);

if (AGENT_TOKEN.length < 24) {
  console.warn('[server] AGENT_TOKEN is missing or shorter than 24 characters – print agents will be refused.');
}

const hub = new AgentHub({ jobTimeoutMs: JOB_TIMEOUT_MS });
const jobs = []; // recent job history (in memory)
const MAX_HISTORY = 100;

function record(job) {
  jobs.unshift(job);
  if (jobs.length > MAX_HISTORY) jobs.length = MAX_HISTORY;
  return job;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.get('/healthz', (_req, res) => res.json({ ok: true, agents: hub.list().length }));

app.use(accessMiddleware());
app.use(express.json({ limit: '256kb' }));

app.get('/api/me', (req, res) => {
  res.json({ email: req.identity?.email || null, accessVerified: accessVerificationEnabled });
});

app.get('/api/templates', (_req, res) => {
  res.json(loadTemplates().map(publicTemplate));
});

app.get('/api/agents', (_req, res) => {
  res.json(hub.list().map((a) => ({
    id: a.id, name: a.name, version: a.version, printer: a.printer,
    connectedAt: a.connectedAt, lastSeen: new Date(a.lastSeen).toISOString(),
  })));
});

app.get('/api/jobs', (_req, res) => res.json(jobs.slice(0, 30)));

function findTemplateOr404(req, res) {
  const t = getTemplate(String(req.body?.templateId || ''));
  if (!t) { res.status(404).json({ error: 'Template not found' }); return null; }
  return t;
}

app.post('/api/preview', async (req, res, next) => {
  try {
    const t = findTemplateOr404(req, res);
    if (!t) return;
    const out = await renderLabel(t, req.body.fields || {}, { user: req.identity?.email, preview: true, lenient: true });
    res.set('Cache-Control', 'no-store').type('png').send(out.png);
  } catch (err) { next(err); }
});

app.post('/api/print', async (req, res, next) => {
  const t = findTemplateOr404(req, res);
  if (!t) return;
  const copies = Math.min(MAX_COPIES, Math.max(1, Number.parseInt(req.body.copies, 10) || 1));
  const job = {
    id: null,
    template: t.name,
    templateId: t.id,
    label: t.label,
    copies,
    user: req.identity?.email || 'unknown',
    agentId: req.body.agentId || null,
    summary: summarise(t, req.body.fields || {}),
    status: 'sending',
    createdAt: new Date().toISOString(),
  };
  try {
    const out = await renderLabel(t, req.body.fields || {}, { user: req.identity?.email });
    record(job);
    const result = await hub.sendJob(req.body.agentId || null, {
      label: out.label, png: out.png, copies, cut: t.cut !== false,
    }, { onProgress: (s) => { job.status = s; } });
    Object.assign(job, { id: result.jobId, agentId: result.agentId, status: 'done', finishedAt: new Date().toISOString() });
    console.log(`[print] ${job.user} printed ${copies}× "${t.name}" on ${result.agentId}`);
    res.json(job);
  } catch (err) {
    if (jobs.includes(job)) Object.assign(job, { status: 'error', error: err.message, finishedAt: new Date().toISOString() });
    next(err);
  }
});

function summarise(t, fields) {
  const first = t.fields.find((f) => ['text', 'textarea'].includes(f.type) && fields[f.name]);
  return first ? String(fields[first.name]).split('\n')[0].slice(0, 60) : '';
}

app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

// ---------- WebSocket endpoint for print agents ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const reject = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== AGENT_PATH) return reject(404, 'Not Found');

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-agent-token'];
  if (AGENT_TOKEN.length < 24 || !safeEqual(token, AGENT_TOKEN)) {
    console.warn(`[agents] rejected connection from ${req.headers['cf-connecting-ip'] || req.socket.remoteAddress}: bad token`);
    return reject(401, 'Unauthorized');
  }
  try {
    await verifyAccess(req.headers);
  } catch (err) {
    console.warn(`[agents] rejected connection: ${err.message}`);
    return reject(403, 'Forbidden');
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    hub.attach(ws, { remote: req.headers['cf-connecting-ip'] || req.socket.remoteAddress });
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] agent endpoint ${AGENT_PATH}; custom templates from ${USER_DIR}`);
  console.log(`[server] Cloudflare Access JWT verification: ${accessVerificationEnabled ? 'ON' : 'off'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, shutting down`);
    for (const c of wss.clients) c.close(1001, 'server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
