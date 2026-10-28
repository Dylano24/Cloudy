#!/usr/bin/env node
/**
 * Read-only, repository-wide Cloudy source audit.
 *
 * Usage: npm ci && node scripts/audit-cloudy-code-quality.mjs
 * No code is automatically removed: dynamic module loading, event registration,
 * side-effect imports and migration compatibility require human review.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import * as espree from 'espree';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}).split('\0').filter(Boolean);
const sourcePaths = tracked.filter(path =>
  /(?:^|\/)(?:src|test|scripts|monitor)\/.*\.(?:js|mjs|cjs)$/.test(path)
  || /^(?:index|eslint\.config)\.(?:js|mjs|cjs)$/.test(path));
const sourceSet = new Set(sourcePaths);
const projectAreas = new Map();
const missingImports = [];
const imports = [];
const parseErrors = [];
const duplicateGroups = new Map();
const readErrors = [];
const covered = [];
const bucket = path => path.startsWith('src/')
  ? path.split('/').slice(0, Math.min(path.split('/').length - 1, 3)).join('/')
  : path.startsWith('test/') ? 'test'
  : path.startsWith('scripts/') ? 'scripts'
  : path.startsWith('monitor/') ? 'monitor' : 'root';
const possibleImportPaths = (parent, specifier) => {
  const path = normalize(join(dirname(parent), specifier));
  if (extname(path)) return [path];
  return [path + '.js', path + '.mjs', path + '.cjs',
    join(path, 'index.js'), join(path, 'index.mjs')];
};
for (const path of sourcePaths) {
  const area = bucket(path);
  projectAreas.set(area, (projectAreas.get(area) || 0) + 1);
  let source;
  try { source = readFileSync(resolve(root, path), 'utf8'); }
  catch (error) { readErrors.push({ path, error: error.code || error.name }); continue; }
  covered.push(path);
  const sha = createHash('sha256').update(source).digest('hex');
  const duplicates = duplicateGroups.get(sha) || [];
  duplicates.push(path);
  duplicateGroups.set(sha, duplicates);
  let ast;
  try {
    ast = espree.parse(source, { ecmaVersion: 'latest',
      sourceType: 'module', loc: true, range: true, allowHashBang: true });
  } catch (error) {
    parseErrors.push({ path, line: error.lineNumber || null, message: error.message });
    continue;
  }
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration'
      && statement.type !== 'ExportNamedDeclaration'
      && statement.type !== 'ExportAllDeclaration') continue;
    const specifier = statement.source?.value;
    if (typeof specifier !== 'string') continue;
    imports.push({ path, line: statement.loc.start.line,
      specifier, kind: statement.type,
      bindings: statement.type === 'ImportDeclaration'
        ? statement.specifiers.map(s => ({ name: s.local.name, line: s.loc.start.line,
          column: s.loc.start.column + 1 })) : [] });
    if (!specifier.startsWith('.')) continue;
    const candidates = possibleImportPaths(path, specifier);
    if (!candidates.some(candidate => sourceSet.has(candidate)
      || existsSync(resolve(root, candidate)))) {
      missingImports.push({ path, line: statement.loc.start.line, specifier });
    }
  }
}
const eslint = new ESLint({ cwd: root });
const lintResults = await eslint.lintFiles(
  sourcePaths.map(path => resolve(root, path)));
const warningMessages = [];
const unusedBindings = [];
let lintErrors = 0;
for (const result of lintResults) {
  lintErrors += result.errorCount || 0;
  const path = result.filePath?.startsWith(root)
    ? result.filePath.slice(root.length + 1).replaceAll('\\', '/') : result.filePath;
  const definitions = imports.filter(item => item.path === path)
    .flatMap(item => item.bindings);
  for (const msg of result.messages) {
    const item = { path, line: msg.line || null, column: msg.column || null,
      rule: msg.ruleId || 'unknown', severity: msg.severity,
      message: msg.message };
    warningMessages.push(item);
    if (msg.ruleId === 'no-unused-vars') {
      const binding = definitions.find(b =>
        b.line === msg.line && b.column === msg.column);
      if (binding) unusedBindings.push({ path, line: msg.line,
        binding: binding.name });
    }
  }
}
const duplicates = [...duplicateGroups.values()]
  .filter(group => group.length > 1)
  .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
const byRule = {};
for (const item of warningMessages) {
  byRule[item.rule] = (byRule[item.rule] || 0) + 1;
}
const report = {
  createdAt: new Date().toISOString(),
  scope: 'all tracked source, test, scripts and monitor JavaScript',
  totals: {
    tracked: tracked.length,
    sourceFiles: sourcePaths.length,
    sourceFilesRead: covered.length,
    sourceFilesLinted: lintResults.length,
    projectAreas: projectAreas.size,
    importsAndReexports: imports.length,
    missingStaticRelativeImports: missingImports.length,
    parserErrors: parseErrors.length,
    lintErrors,
    lintWarnings: warningMessages.filter(m => m.severity === 1).length,
    unusedImportCandidates: unusedBindings.length,
    exactDuplicateGroups: duplicates.length,
  },
  byArea: Object.fromEntries([...projectAreas].sort()),
  byRule, missingImports, parseErrors, readErrors,
  unusedImportCandidates: unusedBindings, exactDuplicates: duplicates,
  allDiagnostics: warningMessages,
  limits: [
    'This is automated static coverage, not individual manual line-by-line proof.',
    'Dynamic imports, runtime-registered handlers and side-effect dependencies must not be deleted based solely on static results.',
    'Unused variable lint diagnostics are review candidates, not permission to remove externally used code.',
    'Exact duplicate test files may be intentionally separate regression contracts.',
    'No Discord/Redis/PostgreSQL integration is exercised by this inventory.',
  ],
};
mkdirSync(join(root, 'audit-results'), { recursive: true });
writeFileSync(join(root, 'audit-results/code-quality.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report.totals,
  byRule: report.byRule, areas: report.byArea,
  missingImports: report.missingImports.slice(0, 30),
  parserErrors: report.parseErrors.slice(0, 10),
  unusedImportCandidates: report.unusedImportCandidates.slice(0, 100),
  exactDuplicateGroups: report.exactDuplicates.slice(0, 25),
}, null, 2));
if (missingImports.length || parseErrors.length || lintErrors || readErrors.length) {
  process.exitCode = 1;
}
