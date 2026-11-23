import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000; // keeps Cloudflare from idling out the socket (~100 s limit)

/**
 * Tracks connected print agents and routes jobs to them.
 * Protocol (JSON text frames):
 *   agent → server  {type:"hello", agentId, name, version, printer:{model, identifier, connected}}
 *   agent → server  {type:"status", printer:{connected, ...}}
 *   agent → server  {type:"job", jobId, status:"printing"|"done"|"error", error?}
 *   server → agent  {type:"print", jobId, label, image(base64 PNG), copies, cut}
 */
export class AgentHub extends EventEmitter {
  constructor({ jobTimeoutMs = 60_000 } = {}) {
    super();
    this.agents = new Map();
    this.pending = new Map();
    this.jobTimeoutMs = jobTimeoutMs;
    this.pinger = setInterval(() => this.#pingAll(), PING_INTERVAL_MS);
    this.pinger.unref();
  }

  attach(ws, meta = {}) {
    let agentId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const helloTimer = setTimeout(() => {
      if (!agentId) ws.close(4000, 'hello expected');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        agentId = String(msg.agentId || 'default').slice(0, 64);
        const existing = this.agents.get(agentId);
        if (existing && existing.ws !== ws) existing.ws.close(4001, 'replaced by new connection');
        this.agents.set(agentId, {
          ws,
          id: agentId,
          name: String(msg.name || agentId).slice(0, 100),
          version: msg.version || null,
          printer: msg.printer || {},
          connectedAt: new Date().toISOString(),
          lastSeen: Date.now(),
          remote: meta.remote || null,
        });
        console.log(`[agents] ${agentId} connected (${msg.name || ''}, v${msg.version || '?'})`);
        this.emit('change');
        return;
      }
      if (!agentId) return;
      const agent = this.agents.get(agentId);
      if (agent) agent.lastSeen = Date.now();

      if (msg.type === 'status' && agent) {
        agent.printer = { ...agent.printer, ...(msg.printer || {}) };
        this.emit('change');
      } else if (msg.type === 'job') {
        const p = this.pending.get(msg.jobId);
        if (!p) return;
        if (msg.status === 'printing') { p.onProgress?.('printing'); return; }
        clearTimeout(p.timer);
        this.pending.delete(msg.jobId);
        if (msg.status === 'done') p.resolve({ status: 'done', detail: msg.detail || null });
        else p.reject(Object.assign(new Error(msg.error || 'printer reported an error'), { status: 502 }));
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(helloTimer);
      if (agentId && this.agents.get(agentId)?.ws === ws) {
        this.agents.delete(agentId);
        console.log(`[agents] ${agentId} disconnected (${code} ${reason})`);
        // Fail any jobs that were waiting on this agent.
        for (const [jobId, p] of this.pending) {
          if (p.agentId === agentId) {
            clearTimeout(p.timer);
            this.pending.delete(jobId);
            p.reject(new Error('print agent disconnected before confirming the job'));
          }
        }
        this.emit('change');
      }
    });
    ws.on('error', (err) => console.warn('[agents] socket error:', err.message));
  }

  list() {
    return [...this.agents.values()].map(({ ws, ...a }) => a);
  }

  pick(agentId) {
    if (agentId) return this.agents.get(agentId);
    return this.agents.values().next().value; // first connected agent
  }

  /** Send a print job and resolve when the agent confirms it printed. */
  sendJob(agentId, { label, png, copies = 1, cut = true }, { onProgress } = {}) {
    const agent = this.pick(agentId);
    if (!agent) return Promise.reject(Object.assign(new Error('No printer is online'), { status: 503 }));
    const jobId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        reject(Object.assign(new Error('Timed out waiting for the printer to confirm'), { status: 504 }));
      }, this.jobTimeoutMs);
      this.pending.set(jobId, { resolve, reject, timer, agentId: agent.id, onProgress });
      agent.ws.send(JSON.stringify({
        type: 'print', jobId, label, copies, cut, image: png.toString('base64'),
      }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(jobId);
          reject(err);
        }
      });
    }).then((r) => ({ ...r, jobId, agentId: agent.id }));
  }

  #pingAll() {
    for (const { ws } of this.agents.values()) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }
}
