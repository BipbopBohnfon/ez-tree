// Godot `.import` sidecar patching. The exporter owns the `[params]` keys of
// its sidecar templates (textures.js); everything else in a game sidecar
// (`uid`, `path`, `[remap]`/`[deps]`, keys Godot added, `_subresources` and
// any other `_`-prefixed editor state) belongs to the game and is kept.

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_/.-]*)=/;
const SECTION = /^\[[^\]]+\]\s*$/;

/** The exporter-owned `[params]` entries of a template: [[key, value], ...]
 *  in template order, skipping `_`-prefixed keys. */
export function ownedParams(template) {
  const out = [];
  let inParams = false;
  for (const line of template.split('\n')) {
    if (SECTION.test(line)) { inParams = line.trim() === '[params]'; continue; }
    const m = inParams && KEY.exec(line);
    if (m && !m[1].startsWith('_')) out.push([m[1], line.slice(m[0].length)]);
  }
  return out;
}

/**
 * Updates an existing sidecar's exporter-owned `[params]` keys to the
 * template's values, appending missing ones at the end of `[params]` (a
 * `[params]` section is added if absent). A value may span lines (Godot
 * writes dictionaries that way); its continuation lines go with it.
 * Idempotent: patching an already-current sidecar returns it unchanged.
 * @param {string} existing the game's sidecar text
 * @param {string} template the exporter's sidecar text
 * @returns {string}
 */
export function patchImportSidecar(existing, template) {
  const owned = new Map(ownedParams(template));
  const lines = existing.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[params]');
  if (start < 0) {
    const body = [...owned].map(([k, v]) => `${k}=${v}`).join('\n');
    return `${existing.replace(/\n*$/, '')}\n\n[params]\n\n${body}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && SECTION.test(l));
  if (end < 0) end = lines.length;
  const out = lines.slice(0, start + 1);
  const seen = new Set();
  for (let i = start + 1; i < end; i++) {
    const m = KEY.exec(lines[i]);
    if (!m || !owned.has(m[1])) { out.push(lines[i]); continue; }
    out.push(`${m[1]}=${owned.get(m[1])}`);
    seen.add(m[1]);
    while (i + 1 < end && !KEY.test(lines[i + 1]) && lines[i + 1].trim() !== '') i++;
  }
  // Missing keys go after the last non-blank line of [params].
  let insert = out.length;
  while (insert > start + 1 && out[insert - 1].trim() === '') insert--;
  const missing = [...owned].filter(([k]) => !seen.has(k)).map(([k, v]) => `${k}=${v}`);
  out.splice(insert, 0, ...missing);
  return [...out, ...lines.slice(end)].join('\n');
}
