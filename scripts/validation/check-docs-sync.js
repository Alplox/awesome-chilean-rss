/**
 * CI: verifica que la documentación esté sincronizada con el código.
 *
 * Comprueba tres cosas:
 *   1. Todo script de `package.json` que ejecute un archivo bajo `scripts/`
 *      está mencionado en SCRIPT_README.md y en AGENTS.md.
 *   2. Todo archivo `.js` de `scripts/` y `lib/` está mencionado en ambos docs.
 *   3. Todos los valores de `ALLOWED_STATUSES` aparecen en SCRIPT_README.md.
 *
 * Evita que se agreguen scripts o estados nuevos sin documentar (AGENTS.md exige
 * mantener SCRIPT_README.md / VALIDATION_MODES.md / CONTRIBUTING.md en sync).
 *
 * Uso: pnpm check:docs
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { ALLOWED_STATUSES } from '../../lib/feed-utils.js';

const DOCS = ['SCRIPT_README.md', 'AGENTS.md'];
const DIRS = ['scripts', 'lib'];

/** Rutas relativas posix, p. ej. `scripts/core/generate.js`. */
function toPosix(p) {
  return p.split(sep).join('/');
}

function listJsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listJsFiles(full, acc);
    } else if (entry.endsWith('.js')) {
      acc.push(toPosix(relative('.', full)));
    }
  }
  return acc;
}

// ── Recolectar lo que debe estar documentado ────────────────────────────────

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

// 1. Comandos de package.json que delegan en un archivo de scripts/
const wiredScripts = [];
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  const match = /^node\s+(scripts\/\S+\.js)/.exec(command.trim());
  if (match) wiredScripts.push({ name, file: match[1] });
}

// 2. Todos los archivos .js del proyecto
const sourceFiles = DIRS.flatMap(dir => listJsFiles(dir));

// ── Verificar menciones ─────────────────────────────────────────────────────

const contents = Object.fromEntries(DOCS.map(doc => [doc, readFileSync(doc, 'utf-8')]));
const missing = [];

for (const doc of DOCS) {
  const text = contents[doc];

  for (const { name, file } of wiredScripts) {
    if (!text.includes(file)) {
      missing.push({ doc, what: `comando \`pnpm ${name}\` (falta la ruta ${file})` });
    }
  }

  for (const file of sourceFiles) {
    // Se acepta la ruta relativa (`lib/feed-overlap.js`) o el nombre de archivo
    // suelto (`feed-overlap.js`), que es como los lista AGENTS.md en su sección
    // de estructura de módulos.
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (text.includes(file) || text.includes(base)) continue;
    missing.push({ doc, what: `archivo \`${file}\`` });
  }

  if (doc === 'SCRIPT_README.md') {
    for (const status of ALLOWED_STATUSES) {
      if (new RegExp(`\`${status}\``).test(text)) continue;
      missing.push({ doc, what: `estado \`${status}\` de ALLOWED_STATUSES` });
    }
  }
}

// ── Resultado ───────────────────────────────────────────────────────────────

if (missing.length === 0) {
  console.log(
    `✅ Docs en sync: ${wiredScripts.length} comando(s), ${sourceFiles.length} archivo(s) .js y ` +
      `${ALLOWED_STATUSES.length} estado(s) documentados en ${DOCS.join(' y ')}`
  );
  process.exit(0);
}

console.error(`❌ Documentación desactualizada (${missing.length} falta(s)):\n`);
for (const { doc, what } of missing) {
  console.error(`   ${doc} → falta ${what}`);
}
console.error('\nAgrega la entrada en SCRIPT_README.md (docs de usuarios) y AGENTS.md (docs de agentes).');
process.exit(1);
