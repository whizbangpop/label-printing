const $ = (id) => document.getElementById(id);
const state = { templates: [], current: null, agents: [], previewUrl: null, previewSeq: 0 };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  if (res.redirected || res.type === 'opaqueredirect') { location.reload(); throw new Error('Session expired'); }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res;
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- templates ----------
function renderTemplateList(filter = '') {
  const list = $('templateList');
  list.replaceChildren();
  const q = filter.trim().toLowerCase();
  const items = state.templates.filter((t) => !q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q));
  let lastCat = null;
  for (const t of items) {
    if ((t.category || 'Other') !== lastCat) {
      lastCat = t.category || 'Other';
      const c = document.createElement('li');
      c.className = 'cat';
      c.textContent = lastCat;
      list.append(c);
    }
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(state.current?.id === t.id));
    b.innerHTML = '<div class="t-name"></div><div class="t-media"></div>';
    b.querySelector('.t-name').textContent = t.name;
    b.querySelector('.t-media').textContent = mediaText(t);
    b.addEventListener('click', () => selectTemplate(t.id));
    li.append(b);
    list.append(li);
  }
  if (!items.length) list.innerHTML = '<li class="none">No templates found.</li>';
}

function mediaText(t) {
  return t.labelName.includes('continuous') ? `${t.labelName}, ${t.lengthMm} mm long` : t.labelName;
}

function selectTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  state.current = t;
  store.set('lastTemplate', id);
  $('emptyState').hidden = true;
  $('labelForm').hidden = false;
  $('tplName').textContent = t.name;
  $('tplDesc').textContent = t.description;
  $('tplMedia').textContent = mediaText(t);
  $('currentTpl').textContent = t.name;
  buildFields(t);
  renderTemplateList($('templateSearch').value);
  schedulePreview(0);
  updatePrintButton();
}

function buildFields(t) {
  const wrap = $('fields');
  wrap.replaceChildren();
  const saved = store.get(`fields:${t.id}`) || {};
  for (const f of t.fields) {
    const row = document.createElement('div');
    row.className = 'row';
    const id = `f_${f.name}`;
    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = f.rows || 3;
    } else if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of f.options || []) {
        const o = document.createElement('option');
        const { value, label: text } = typeof opt === 'object' ? opt : { value: opt, label: opt };
        o.value = value; o.textContent = text;
        input.append(o);
      }
    } else {
      input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'checkbox' ? 'checkbox' : 'text';
    }
    input.name = f.name;
    input.id = id;
    if (f.placeholder && 'placeholder' in input) input.placeholder = f.placeholder;
    if (f.maxLength) input.maxLength = f.maxLength;
    if (f.required) input.required = true;

    // Initial value: remembered value (not for dates, which go stale) → default.
    let v = f.type === 'date' ? undefined : saved[f.name];
    if (v === undefined) v = f.default === 'today' ? todayIso() : f.default;
    if (f.type === 'checkbox') input.checked = Boolean(v);
    else if (v !== undefined) input.value = v;

    input.addEventListener('input', onFieldChange);
    input.addEventListener('change', onFieldChange);

    const title = document.createElement('label');
    title.htmlFor = id;
    if (f.required) title.insertAdjacentHTML('beforeend', '<span class="req" aria-hidden="true">*</span> ');
    title.append(`${f.label || f.name}:`);
    const cell = document.createElement('div');
    cell.append(input);
    row.append(title, cell);
    if (f.help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = f.help;
      row.append(h);
    }
    wrap.append(row);
  }
  wrap.querySelector('input,textarea,select')?.focus();
}

function readFields() {
  const out = {};
  for (const f of state.current?.fields || []) {
    const el = $('labelForm').elements.namedItem(f.name);
    out[f.name] = f.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function onFieldChange() {
  store.set(`fields:${state.current.id}`, readFields());
  schedulePreview();
  updatePrintButton();
}

$('clearBtn').addEventListener('click', () => {
  if (!state.current) return;
  store.set(`fields:${state.current.id}`, {});
  buildFields(state.current);
  schedulePreview(0);
  updatePrintButton();
});

// ---------- preview ----------
let previewTimer;
function schedulePreview(delay = 250) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, delay);
}

async function updatePreview() {
  if (!state.current) return;
  const seq = ++state.previewSeq;
  const img = $('previewImg');
  img.classList.add('loading');
  try {
    const res = await api('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ templateId: state.current.id, fields: readFields() }),
    });
    const blob = await res.blob();
    if (seq !== state.previewSeq) return; // a newer preview is on its way
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(blob);
    img.src = state.previewUrl;
    img.hidden = false;
    $('previewMsg').hidden = true;
  } catch (err) {
    if (seq !== state.previewSeq) return;
    img.hidden = true;
    $('previewMsg').hidden = false;
    $('previewMsg').textContent = `Error: preview could not be generated (${err.message}).`;
  } finally {
    if (seq === state.previewSeq) img.classList.remove('loading');
  }
}

// ---------- printers ----------
async function refreshAgents() {
  try {
    state.agents = await (await api('/api/agents')).json();
  } catch {
    state.agents = [];
  }
  const sel = $('agentSelect');
  const prev = sel.value || store.get('agent');
  sel.replaceChildren();
  for (const a of state.agents) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${a.name}${a.printer?.connected === false ? ' (not detected)' : ''}`;
    sel.append(o);
  }
  if (!state.agents.length) {
    const o = document.createElement('option');
    o.textContent = '<No printers available>';
    o.value = '';
    sel.append(o);
  }
  if (prev && state.agents.some((a) => a.id === prev)) sel.value = prev;

  const pill = $('printerStatus');
  const a = state.agents.find((x) => x.id === sel.value);
  if (!a) {
    pill.className = 'printer-status off';
    pill.querySelector('.txt').textContent = 'Printer: OFFLINE';
  } else if (a.printer?.connected === false) {
    pill.className = 'printer-status warn';
    pill.querySelector('.txt').textContent = `Printer: ${a.name} - NOT DETECTED`;
  } else {
    pill.className = 'printer-status on';
    pill.querySelector('.txt').textContent = `Printer: ${a.name} - ONLINE`;
  }
  updatePrintButton();
}
$('agentSelect').addEventListener('change', (e) => { store.set('agent', e.target.value); refreshAgents(); });

function updatePrintButton() {
  const ok = state.current && state.agents.length && $('labelForm').checkValidity();
  $('printBtn').disabled = !ok || state.printing;
}

// ---------- printing ----------
$('printBtn').addEventListener('click', async () => {
  if (!state.current) return;
  if (!$('labelForm').reportValidity()) return;
  const msg = $('printMsg');
  state.printing = true;
  updatePrintButton();
  $('printBtn').textContent = 'Printing...';
  msg.className = 'msg info';
  msg.textContent = 'Sending job to printer...';
  try {
    const copies = Math.max(1, Number($('copies').value) || 1);
    const job = await (await api('/api/print', {
      method: 'POST',
      body: JSON.stringify({
        templateId: state.current.id, fields: readFields(), copies, agentId: $('agentSelect').value || undefined,
      }),
    })).json();
    msg.className = 'msg ok';
    msg.textContent = `Job complete. ${job.copies} label${job.copies > 1 ? 's' : ''} printed.`;
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = `Error: ${err.message}`;
  } finally {
    state.printing = false;
    $('printBtn').textContent = 'Print Label';
    updatePrintButton();
    refreshJobs();
  }
});

async function refreshJobs() {
  try {
    const jobs = await (await api('/api/jobs')).json();
    const tbody = $('jobList');
    tbody.replaceChildren();
    if (!jobs.length) {
      tbody.innerHTML = '<tr><td colspan="6">No print jobs found.</td></tr>';
      return;
    }
    for (const j of jobs.slice(0, 15)) {
      const tr = document.createElement('tr');
      const d = new Date(j.createdAt);
      const p = (n) => String(n).padStart(2, '0');
      const status = j.status === 'error' ? 'Failed' : j.status === 'done' ? 'Printed' : 'Printing';
      const cells = [
        `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`,
        j.template, j.summary || '-', String(j.copies), j.user, status,
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i === 2) td.className = 'content';
        if (i === 5) { td.className = `s-${j.status}`; if (j.error) td.title = j.error; }
        tr.append(td);
      });
      tbody.append(tr);
    }
  } catch { /* ignore */ }
}

// ---------- boot ----------
async function boot() {
  $('templateSearch').addEventListener('input', (e) => renderTemplateList(e.target.value));
  try {
    const me = await (await api('/api/me')).json();
    $('user').textContent = me.email ? `Logged in as: ${me.email}` : '';
  } catch { /* ignore */ }
  try {
    state.templates = await (await api('/api/templates')).json();
  } catch (err) {
    $('templateList').innerHTML = '<li class="none"></li>';
    $('templateList').firstChild.textContent = `Error: could not load templates (${err.message}).`;
  }
  renderTemplateList();
  const last = store.get('lastTemplate');
  if (last && state.templates.some((t) => t.id === last)) selectTemplate(last);
  refreshAgents();
  refreshJobs();
  setInterval(refreshAgents, 5000);
  setInterval(refreshJobs, 15000);
}
boot();
