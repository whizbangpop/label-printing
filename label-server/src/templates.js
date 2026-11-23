import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, resolveGeometry } from './labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_DIR = path.resolve(here, '..', 'templates');
export const USER_DIR = process.env.TEMPLATES_DIR || '/data/templates';

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'select', 'checkbox']);

function readDir(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(dir, f);
      try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        t.id ??= path.basename(f, '.json');
        t._dir = dir;
        t._source = source;
        validate(t);
        return t;
      } catch (err) {
        console.error(`[templates] skipping ${file}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function validate(t) {
  if (!t.name) throw new Error('missing "name"');
  if (!LABELS[t.label]) throw new Error(`unknown label "${t.label}"`);
  if (!Array.isArray(t.fields)) t.fields = [];
  if (!Array.isArray(t.elements) || !t.elements.length) throw new Error('needs at least one element');
  for (const f of t.fields) {
    if (!f.name) throw new Error('field missing "name"');
    f.type ??= 'text';
    if (!FIELD_TYPES.has(f.type)) throw new Error(`field ${f.name}: unknown type ${f.type}`);
  }
  resolveGeometry(t); // throws on bad geometry
}

/** Templates are re-read on every call so edits in the mounted folder show up without a restart. */
export function loadTemplates() {
  const byId = new Map();
  for (const t of readDir(BUILTIN_DIR, 'builtin')) byId.set(t.id, t);
  for (const t of readDir(USER_DIR, 'custom')) byId.set(t.id, t); // custom overrides built-in
  return [...byId.values()].sort((a, b) =>
    (a.category || 'Other').localeCompare(b.category || 'Other') || a.name.localeCompare(b.name));
}

export function getTemplate(id) {
  return loadTemplates().find((t) => t.id === id);
}

export function publicTemplate(t) {
  const g = resolveGeometry(t);
  return {
    id: t.id,
    name: t.name,
    description: t.description || '',
    category: t.category || '',
    label: t.label,
    labelName: g.label.name,
    lengthMm: Math.round((g.print.height / (300 / 25.4)) * 10) / 10,
    fields: t.fields,
    source: t._source,
  };
}
