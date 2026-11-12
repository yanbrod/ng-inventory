#!/usr/bin/env node
/**
 * ng-inventory.js: static inventory of an Angular codebase for migration sizing.
 *
 * What it does
 *   Walks a repo / app / library folder, parses every TypeScript file with the
 *   TypeScript compiler API and writes counts: components (size and coupling
 *   metrics plus an S/M/L/XL bucket), services, guards, interceptors, resolvers,
 *   directives, pipes, modules, routes, forms, state management, template
 *   features, third-party packages tied to Angular, the share of framework-free
 *   code, unit and e2e tests.
 *
 * What it does not do
 *   No network access, no build, no code execution. It only reads files and
 *   writes numbers and (unless --anonymize is set) file paths and class names.
 *   Source code never ends up in the report.
 *
 * Requirements
 *   Node.js 14+ and the `typescript` package (4.x to 6.x), which every Angular
 *   project already has in node_modules. TypeScript 7 no longer ships the
 *   compiler API: pass an older copy with --ts in that case. Nx is not
 *   required; angular.json and project.json files are used for a per-project
 *   breakdown when present.
 *
 * What counts as application code
 *   When angular.json or project.json files say where the projects live, the
 *   script counts those folders plus every file they import (a shared library
 *   in a sibling folder or a git submodule, for instance). Mock servers,
 *   scripts and tooling next to the app are left out and listed in the report.
 *   --include adds folders by hand, --all counts every .ts file.
 *
 * Usage
 *   node ng-inventory.js [path] [--out <dir>] [--xl <n>] [--include <a,b>] [--all]
 *                        [--anonymize] [--semicolon] [--ts <path>] [--quiet]
 *   node ng-inventory.js --merge <summary.json> <summary.json> ... [--out <dir>]
 *
 * Output (./ng-inventory-report by default)
 *   summary.md       human-readable report, ends with a sizing sheet
 *   summary.json     the same numbers, machine-readable (the file to send back)
 *   components.csv   one row per component: raw metrics, bucket, reasons
 *   classes.csv      one row per service, guard, interceptor, resolver,
 *                    directive, pipe and module
 *
 *   --merge writes portfolio.md and portfolio.csv: one row per application
 *   plus a total, built from the summary.json files of several runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '1.1.0';

/* ------------------------------------------------------------------ *
 * Tunables: adjust to your own definition of "complex"
 * ------------------------------------------------------------------ */
const SIZE = { S: 100, M: 250, L: 400 }; // class LOC + template LOC; above L => XL (L is set by --xl)
const COUPLING = {
  deps: 5, //         injected dependencies: constructor params + inject() calls
  subscribes: 4, //   .subscribe() calls
  formControls: 8, // reactive form controls, or form bindings in the template
  queries: 3, //      @ViewChild / @ContentChild / viewChild() ...
  projection: 2, //   <ng-content> + ngTemplateOutlet
  api: 12, //         inputs + outputs
};
const BUMP = { one: 2, two: 4 }; // coupling points that move a component up by 1 / 2 buckets

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out-tsc', 'coverage', 'tmp', 'temp', 'storybook-static', 'test-results', 'playwright-report', 'ng-inventory-report']);
const E2E_DIR_RE = /(^|[-_.])(e2e|cypress|playwright)([-_.]|$)/; // e2e, e2e-playwright, app-e2e, cypress ...
const TOOL_CONFIG_RE = /(^|[.\-_])(jest|karma|playwright|cypress|protractor|vite|vitest|tailwind|eslint|postcss|rollup|esbuild|commitlint|prettier)([.\-_][\w\-]*)*\.(config|conf|preset|setup)\.ts$|^(jest|karma|playwright|cypress|protractor|vite|vitest|tailwind|eslint|postcss|rollup|esbuild|commitlint|prettier)[.\-]/;
const GENERATED_PATH_RE = /(^|\/)(__generated__|generated)\/|\.(generated|gen)\.ts$/i;
const CODEGEN_SIGNATURE_RE = /export type Maybe<T> = [\s\S]{0,600}export type Scalars = /; // graphql-codegen output
const LIFECYCLE = new Set(['ngOnChanges', 'ngOnInit', 'ngDoCheck', 'ngAfterContentInit', 'ngAfterContentChecked', 'ngAfterViewInit', 'ngAfterViewChecked', 'ngOnDestroy']);
const QUERY_DECORATORS = new Set(['ViewChild', 'ViewChildren', 'ContentChild', 'ContentChildren']);
const QUERY_FNS = new Set(['viewChild', 'viewChild.required', 'viewChildren', 'contentChild', 'contentChild.required', 'contentChildren']);
const INPUT_FNS = new Set(['input', 'input.required']);
const MODEL_FNS = new Set(['model', 'model.required']);
const OUTPUT_FNS = new Set(['output', 'outputFromObservable']);
const SIGNAL_FNS = new Set(['signal', 'computed', 'linkedSignal', 'toSignal', 'resource', 'rxResource', 'httpResource']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);
const STRONG_ROUTE_KEYS = ['component', 'loadComponent', 'loadChildren', 'children', 'redirectTo'];
const GUARD_KEYS = ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch', 'canLoad'];
const GUARD_IFACES = new Set(['CanActivate', 'CanActivateChild', 'CanDeactivate', 'CanMatch', 'CanLoad']);
const FN_TYPES = new Set(['CanActivateFn', 'CanActivateChildFn', 'CanDeactivateFn', 'CanMatchFn', 'ResolveFn', 'HttpInterceptorFn']);
const NGRX_CALLS = new Set(['createAction', 'createActionGroup', 'createReducer', 'createEffect', 'createSelector', 'createFeatureSelector', 'createFeature', 'createEntityAdapter', 'signalStore', 'signalStoreFeature']);
const DOM_TOKENS = ['ElementRef', 'Renderer2', 'NgZone'];
const DYNAMIC_TOKENS = ['ViewContainerRef', 'ComponentFactoryResolver'];
const FRAMEWORK_TOKENS = new Set(['HttpClient', 'Router', 'ActivatedRoute', 'Location', 'Title', 'Meta', 'DomSanitizer', 'Injector', 'DestroyRef', 'ChangeDetectorRef', 'ElementRef', 'Renderer2', 'NgZone', 'ViewContainerRef', 'TemplateRef', 'ComponentFactoryResolver', 'ApplicationRef', 'FormBuilder', 'NonNullableFormBuilder', 'UntypedFormBuilder', 'Store', 'Actions', 'Apollo', 'MatDialog', 'MatDialogRef', 'MatSnackBar', 'MatBottomSheet', 'Overlay', 'BreakpointObserver', 'TranslateService', 'TranslocoService', 'DialogService', 'MessageService', 'ConfirmationService', 'NgbModal', 'DOCUMENT', 'MAT_DIALOG_DATA', 'LOCALE_ID']);
const KIND_RANK = { Component: 0, Directive: 1, Pipe: 2, NgModule: 3, State: 4, Injectable: 5 };
const CORE_ANGULAR_RE = /^@angular\/(core|common|forms|router|platform-browser|platform-browser-dynamic|platform-server|compiler|compiler-cli|ssr|upgrade)$/;
const FORM_NEW_RE = /^(Untyped)?Form(Control|Group|Array|Record)$/;
const SUBJECT_RE = /^(Behavior|Replay|Async)?Subject$/;
const TEST_CASE_RE = /\b(?:it|test|fit|xit)(?:\.(?:only|skip|concurrent|fixme|failing))?(?:\.each\s*(?:\([\s\S]*?\)|`[\s\S]*?`))?\s*\(\s*['"`]/g;
const TESTBED_RE = /\bTestBed\b|\bcreate(?:Component|Service|Http|Directive|Pipe|Routing|Host)Factory\b|\bMockBuilder\b|\bMockRender\b|@testing-library\/angular/;
const ANGULAR_NAME_RE = /^@angular[\/-]|^@ngrx\/|^@ngxs\/|^@ngneat\/|^@ngx-|^ngx-|^ng-|^@ng-|-angular$|\/angular$|^angular-|^primeng$|^@nebular\/|^@taiga-ui\/|^@jsverse\/transloco|^@swimlane\/ngx|^@progress\/kendo-angular|^@clr\/angular|^@ionic\/angular|^@fortawesome\/angular|^@nx\/angular$|^@nrwl\/angular$|^@angular-architects\/|^@datorama\/akita|^@rx-angular\/|^@tanstack\/angular/;
const TOOLING = {
  unit: ['karma', 'jasmine-core', 'jest', 'jest-preset-angular', 'vitest', '@analogjs/vitest-angular', '@testing-library/angular', '@ngneat/spectator', 'ng-mocks', 'jest-marbles', 'jasmine-marbles'],
  e2e: ['cypress', '@playwright/test', 'playwright', 'protractor', '@cucumber/cucumber', 'cucumber', '@badeball/cypress-cucumber-preprocessor', 'webdriverio', '@wdio/cli', 'testcafe', 'selenium-webdriver'],
  other: ['@storybook/angular', 'storybook', 'nx', '@nx/angular', '@nrwl/angular', '@angular-architects/module-federation', '@angular-architects/native-federation', '@module-federation/enhanced', 'single-spa-angular', '@angular/elements'],
};
const BUCKETS = ['S', 'M', 'L', 'XL'];

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function printHelp() {
  console.log(
    [
      'ng-inventory ' + VERSION + ': static inventory of an Angular codebase',
      '',
      'Usage: node ng-inventory.js [path] [options]',
      '       node ng-inventory.js --merge <summary.json> <summary.json> ... [--out <dir>]',
      '',
      '  path           Repo, app or library folder to scan (default: current directory)',
      '  --merge        Combine summary.json files from several runs into one portfolio table',
      '  --out <dir>    Output folder (default: ./ng-inventory-report)',
      '  --xl <n>       LOC threshold (class + template) for the XL bucket (default: 400)',
      '  --include <a,b> Folders to count as application code on top of the project folders',
      '  --all          Count every .ts file under the path, not only the project folders and what they import',
      '  --anonymize    Replace file paths, class names, selectors and project names with ids',
      '  --semicolon    Write CSV files with ; as the separator (Excel with German or other European settings)',
      '  --ts <path>    Path to a typescript package (default: resolved from the scanned project)',
      '  --quiet        Do not print the summary to the console',
      '  -h, --help     Show this help',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const o = { root: null, out: null, xl: SIZE.L, anonymize: false, ts: null, quiet: false, merge: null, sep: ',', include: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--merge') {
      o.merge = [];
      while (i + 1 < argv.length && argv[i + 1].charAt(0) !== '-') o.merge.push(argv[++i]);
    } else if (a === '--out') o.out = argv[++i];
    else if (a === '--xl') o.xl = parseInt(argv[++i], 10);
    else if (a === '--anonymize') o.anonymize = true;
    else if (a === '--semicolon') o.sep = ';';
    else if (a === '--all') o.all = true;
    else if (a === '--include') o.include = o.include.concat(String(argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--ts') o.ts = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else if (a.charAt(0) === '-') {
      console.error('Unknown option: ' + a + '\n');
      printHelp();
      process.exit(2);
    } else if (!o.root) o.root = a;
    else {
      console.error('Unexpected argument: ' + a);
      process.exit(2);
    }
  }
  if (!(o.xl > 0)) {
    console.error('--xl expects a positive number');
    process.exit(2);
  }
  o.root = path.resolve(o.root || '.');
  o.out = path.resolve(o.out || 'ng-inventory-report');
  if (!fs.existsSync(o.root) || !fs.statSync(o.root).isDirectory()) {
    console.error('Not a directory: ' + o.root);
    process.exit(2);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.merge) {
  mergeReports(opts.merge, opts.out);
  process.exit(0);
}
const ROOT = opts.root;
SIZE.L = opts.xl;
SIZE.M = Math.min(SIZE.M, SIZE.L);
SIZE.S = Math.min(SIZE.S, SIZE.M);

function loadTypeScript() {
  const tried = [];
  const tryLoad = (p) => {
    try {
      const m = require(p);
      if (m && typeof m.createSourceFile === 'function') return m;
      tried.push(p + ' (found, but it has no compiler API)');
    } catch (e) {
      tried.push(p);
    }
    return null;
  };
  if (opts.ts) {
    const m = tryLoad(path.resolve(opts.ts));
    if (m) return m;
  }
  for (const base of [ROOT, process.cwd(), __dirname]) {
    let resolved;
    try {
      resolved = require.resolve('typescript', { paths: [base] });
    } catch (e) {
      continue;
    }
    const m = tryLoad(resolved);
    if (m) {
      if (opts.ts) process.stderr.write('Note: --ts ' + opts.ts + ' is not usable, using TypeScript ' + m.version + ' from ' + resolved + '\n');
      return m;
    }
  }
  console.error(
    [
      'Cannot load the "typescript" package with its compiler API.',
      'Run the script against a project whose dependencies are installed (npm ci),',
      'or point it at any TypeScript 4.x-6.x package: --ts /path/to/node_modules/typescript',
      '(TypeScript 7 no longer ships this API; in an empty folder run: npm i typescript@5 and pass that copy with --ts).',
      tried.length ? 'Tried: ' + tried.join(', ') : '',
    ].join('\n')
  );
  process.exit(1);
}

const ts = loadTypeScript();
const SK = ts.SyntaxKind;
const JSDOC_FIRST = SK.FirstJSDocNode || Infinity;
const JSDOC_LAST = SK.LastJSDocNode || -1;

/* ------------------------------------------------------------------ *
 * --merge: one row per application from several summary.json files
 * ------------------------------------------------------------------ */
function mergeReports(files, outDir) {
  if (!files.length) {
    console.error('--merge expects one or more summary.json files');
    process.exit(2);
  }
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const share = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const SIZING = ['componentsS', 'componentsM', 'componentsL', 'componentsXL', 'services', 'guardsInterceptorsResolvers', 'directives', 'pipes', 'stateSlices', 'effectsClasses', 'customFormControls', 'angularBoundPackages', 'screens', 'testbedCases', 'e2eCases', 'graphqlCallSites'];
  const rows = [];
  const used = new Set();
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.error('Cannot read ' + f + ': ' + e.message);
      process.exit(2);
    }
    if (!s || s.tool !== 'ng-inventory' || !s.sizing) {
      console.error('Not a summary.json written by this version of ng-inventory: ' + f);
      process.exit(2);
    }
    const abs = path.resolve(f);
    let app = s.target && s.target !== '(anonymized)' ? s.target : path.basename(abs) === 'summary.json' ? path.basename(path.dirname(abs)) : path.basename(abs, '.json');
    for (let n = 2; used.has(app); n++) app = app.replace(/ \(\d+\)$/, '') + ' (' + n + ')';
    used.add(app);
    const row = {
      app: app, angular: s.workspace.angularInstalled || s.workspace.angularDeclared || '', tsLoc: s.files.ts.loc, templateLoc: s.components.loc.template,
      angularBoundLoc: s.portability.angularBound.loc, selfContainedLoc: s.portability.frameworkFreeSelfContained.loc,
      components: s.components.count, routes: s.routing.routes, unitCases: s.tests.unit.cases,
    };
    for (const k of SIZING) row[k] = s.sizing[k] || 0;
    rows.push(row);
  }
  const total = { app: 'TOTAL', angular: '' };
  for (const k of Object.keys(rows[0])) if (k !== 'app' && k !== 'angular') total[k] = rows.reduce((a, r) => a + r[k], 0);
  const all = rows.concat(rows.length > 1 ? [total] : []);
  for (const r of all) {
    r.angularBoundPct = share(r.angularBoundLoc, r.tsLoc);
    r.selfContainedPct = share(r.selfContainedLoc, r.tsLoc);
  }
  const cols = ['app', 'angular', 'tsLoc', 'templateLoc', 'angularBoundPct', 'selfContainedPct', 'components'].concat(SIZING.slice(0, 4), ['routes', 'unitCases'], SIZING.slice(4));
  const head = ['App', 'Angular', 'TS LOC', 'Template LOC', 'Angular-bound %', 'Self-contained %', 'Components', 'S', 'M', 'L', 'XL', 'Routes', 'Unit cases', 'Services', 'Guards, interceptors, resolvers', 'Directives', 'Pipes', 'State slices', 'Effects classes', 'Custom form controls', 'Angular-bound packages', 'Screens', 'TestBed cases', 'E2E cases', 'GraphQL call sites'];
  const md = '# Angular portfolio inventory\n\n' + mdTable(head, all.map((r) => cols.map((c) => (typeof r[c] === 'number' ? num(r[c]) : r[c])))) + '\n\nAngular-bound packages are counted per application, so the total counts a shared package once per application that uses it.\n';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'portfolio.md'), md);
  fs.writeFileSync(path.join(outDir, 'portfolio.csv'), csv(all, cols));
  console.log(md);
  console.log('Written to ' + outDir);
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const toPosix = (p) => p.split(path.sep).join('/');
const relOf = (abs) => toPosix(path.relative(ROOT, abs));
const bump = (obj, key, n) => {
  obj[key] = (obj[key] || 0) + (n === undefined ? 1 : n);
};
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return '';
  }
}
function nonBlank(text) {
  if (!text) return 0;
  let n = 0;
  for (const l of text.split(/\r?\n/)) if (l.trim()) n++;
  return n;
}
function readJsonLoose(abs) {
  const text = readText(abs);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    try {
      const r = ts.parseConfigFileTextToJson(abs, text);
      return r.config || null;
    } catch (e2) {
      return null;
    }
  }
}
function findUp(start, name) {
  let d = start;
  for (;;) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Workspace context: package.json, node_modules, tsconfig paths
 * ------------------------------------------------------------------ */
const pkgJsonPath = findUp(ROOT, 'package.json');
const pkgJson = (pkgJsonPath && readJsonLoose(pkgJsonPath)) || {};
const declaredDeps = Object.assign({}, pkgJson.peerDependencies, pkgJson.devDependencies, pkgJson.dependencies);

const nodeModulesDirs = [];
for (let d = ROOT; ; ) {
  const nm = path.join(d, 'node_modules');
  if (fs.existsSync(nm)) nodeModulesDirs.push(nm);
  const up = path.dirname(d);
  if (up === d) break;
  d = up;
}

const installedCache = new Map();
function installedPkg(name) {
  if (installedCache.has(name)) return installedCache.get(name);
  let res = null;
  for (const nm of nodeModulesDirs) {
    const p = path.join(nm, name, 'package.json');
    if (fs.existsSync(p)) {
      res = readJsonLoose(p);
      break;
    }
  }
  installedCache.set(name, res);
  return res;
}

const boundCache = new Map();
/** True when a package cannot be used outside Angular (peer-depends on @angular/core, or is named like it). */
function isAngularBound(pkg) {
  if (boundCache.has(pkg)) return boundCache.get(pkg);
  let res = false;
  if (/^@angular\//.test(pkg)) res = true;
  else {
    const pj = installedPkg(pkg);
    if (pj) {
      const d = Object.assign({}, pj.peerDependencies, pj.dependencies);
      res = Object.keys(d).some((k) => k === '@angular/core' || k === '@angular/common');
    }
    if (!res && ANGULAR_NAME_RE.test(pkg)) res = true;
  }
  boundCache.set(pkg, res);
  return res;
}

const ALIAS_TARGETS = new Map(); // alias pattern -> absolute target patterns
function loadPathAliases() {
  const aliases = [];
  const dirs = new Set([ROOT]);
  if (pkgJsonPath) dirs.add(path.dirname(pkgJsonPath));
  for (const dir of dirs) {
    for (const name of ['tsconfig.base.json', 'tsconfig.json', 'tsconfig.app.json']) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const j = readJsonLoose(p);
      const co = j && j.compilerOptions;
      if (!co || !co.paths) continue;
      const baseDir = path.resolve(dir, co.baseUrl || '.');
      for (const k of Object.keys(co.paths)) {
        if (k === '*' || ALIAS_TARGETS.has(k)) continue;
        const targets = Array.isArray(co.paths[k]) ? co.paths[k] : [];
        ALIAS_TARGETS.set(k, targets.map((t) => path.resolve(baseDir, t)));
        aliases.push(k);
      }
    }
  }
  return aliases;
}
const ALIASES = loadPathAliases();
function matchAlias(spec) {
  for (const a of ALIASES) {
    const star = a.indexOf('*');
    if (star === -1) {
      if (spec === a) return a;
    } else if (spec.length >= a.length - 1 && spec.startsWith(a.slice(0, star)) && spec.endsWith(a.slice(star + 1))) return a;
  }
  return null;
}

const localBareCache = new Map();
/** Bare specifiers that are really local folders resolved through baseUrl, e.g. 'src/app/core'. */
function isLocalBare(spec) {
  const seg = spec.split('/')[0];
  if (localBareCache.has(seg)) return localBareCache.get(seg);
  let res = false;
  if (seg.charAt(0) !== '@' && !declaredDeps[seg] && !installedPkg(seg)) {
    res = isDir(path.join(ROOT, seg)) || isDir(path.join(ROOT, 'src', seg));
  }
  localBareCache.set(seg, res);
  return res;
}
function pkgName(spec) {
  const parts = spec.split('/');
  return spec.charAt(0) === '@' ? parts.slice(0, 2).join('/') : parts[0];
}

/* ------------------------------------------------------------------ *
 * Projects (angular.json / workspace.json / Nx project.json), all optional
 * ------------------------------------------------------------------ */
function normDir(p) {
  p = toPosix(p || '').replace(/^\.\//, '').replace(/\/+$/, '');
  return p === '.' ? '' : p;
}
function newProj(name, type, root, sourceRoot) {
  return {
    name: name, type: type, root: root, sourceRoot: sourceRoot || '',
    tsFiles: 0, tsLoc: 0, angularLoc: 0, rxjsLoc: 0, freeLoc: 0,
    components: 0, buckets: { S: 0, M: 0, L: 0, XL: 0 }, templateLoc: 0,
    directives: 0, pipes: 0, injectables: 0, modules: 0,
    routes: 0, screens: 0, specFiles: 0, specCases: 0, e2eFiles: 0, e2eCases: 0,
  };
}
const projects = [];
const rootProject = newProj('(root)', 'unknown', '');
function addProject(name, type, root, sourceRoot) {
  root = normDir(root);
  if (projects.some((p) => p.root === root)) return;
  if (/-e2e$/.test(name) || E2E_DIR_RE.test(root.split('/').pop())) type = 'e2e';
  projects.push(newProj(name, type || 'unknown', root, normDir(sourceRoot)));
}
for (const f of ['angular.json', 'workspace.json']) {
  const j = fs.existsSync(path.join(ROOT, f)) ? readJsonLoose(path.join(ROOT, f)) : null;
  if (!j || !j.projects) continue;
  for (const name of Object.keys(j.projects)) {
    const v = j.projects[name];
    if (typeof v === 'string') addProject(name, 'unknown', v);
    else if (v) addProject(name, v.projectType, v.root, v.sourceRoot);
  }
}
function projectOf(rel) {
  let best = null;
  for (const p of projects) {
    if (p.root === '' || rel === p.root || rel.startsWith(p.root + '/')) {
      if (!best || p.root.length > best.root.length) best = p;
    }
  }
  return best || rootProject;
}

/* ------------------------------------------------------------------ *
 * File discovery
 * ------------------------------------------------------------------ */
function classify(rel) {
  const segs = rel.toLowerCase().split('/');
  const base = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  if (base === 'project.json') return 'projectJson';
  if (/^(webpack|module-federation|federation)[.\-].*\.(js|cjs|mjs|ts)$/.test(base)) return 'mfConfig';
  if (base.endsWith('.feature')) return 'feature';
  if (/\.(graphql|gql)$/.test(base)) return 'graphql';
  if (base.endsWith('.d.ts')) return 'skip';
  if (/\.(cy|e2e-spec|e2e|pw)\.(ts|js)$/.test(base)) return 'e2e';
  if (dirs.some((s) => E2E_DIR_RE.test(s)) && /\.(ts|js)$/.test(base)) {
    if (TOOL_CONFIG_RE.test(base)) return 'skip';
    return /\.(spec|test)\.(ts|js)$/.test(base) ? 'e2e' : 'e2eSupport';
  }
  if (/\.(spec|test)\.ts$/.test(base)) return 'spec';
  if (/\.stories\.ts$/.test(base)) return 'story';
  if (base.endsWith('.ts')) {
    if (TOOL_CONFIG_RE.test(base)) return 'skip';
    if (
      /\.(mock|mocks|stub|stubs|fixture|fixtures|fake|fakes)\.ts$/.test(base) ||
      /^(test|test-setup|setup-jest|jest\.setup|setup-tests)\.ts$/.test(base) ||
      dirs.some((s) => s === '__mocks__' || s === 'mocks' || s === 'testing' || s === '__tests__' || s === 'test-utils')
    )
      return 'testSupport';
    return 'ts';
  }
  if (base.endsWith('.html')) return 'html';
  if (/\.(scss|sass|css|less|styl)$/.test(base)) return 'style';
  return 'skip';
}

const found = { ts: [], spec: [], story: [], testSupport: [], e2e: [], e2eSupport: [], feature: [], graphql: [], html: [], style: [], mfConfig: [], projectJson: [] };
(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.charAt(0) === '.' || SKIP_DIRS.has(e.name) || full === opts.out) continue;
      walk(full);
    } else if (e.isFile()) {
      let kind = classify(relOf(full));
      // environment.test.ts and the like are not tests: a .test.ts file has to contain a test
      if (kind === 'spec' && /\.test\.ts$/i.test(e.name) && !/\b(?:describe|it|test)\s*[.(]/.test(readText(full))) kind = 'ts';
      // a file in an e2e folder that holds tests is a test, whatever it is called
      else if (kind === 'e2eSupport' && TEST_CASE_RE.test(readText(full))) kind = 'e2e';
      TEST_CASE_RE.lastIndex = 0;
      if (kind !== 'skip') found[kind].push(full);
    }
  }
})(ROOT);

const tsFileSet = new Set(found.ts);
function resolveTsFile(base) {
  const b = base.replace(/\.(js|mjs)$/, '');
  for (const c of [b, b + '.ts', path.join(b, 'index.ts')]) if (tsFileSet.has(c)) return c;
  return null;
}
/** Resolves an import specifier to a scanned source file; null for packages and anything not found. */
function resolveSpec(spec, fromAbs) {
  if (spec.charAt(0) === '.') return resolveTsFile(path.resolve(path.dirname(fromAbs), spec));
  if (spec.charAt(0) === '/') return null;
  const alias = matchAlias(spec);
  if (alias) {
    const star = alias.indexOf('*');
    const captured = star === -1 ? '' : spec.slice(star, spec.length - (alias.length - star - 1));
    for (const t of ALIAS_TARGETS.get(alias) || []) {
      const r = resolveTsFile(star === -1 ? t : t.replace('*', () => captured));
      if (r) return r;
    }
    return null;
  }
  if (isLocalBare(spec)) return resolveTsFile(path.join(ROOT, spec)) || resolveTsFile(path.join(ROOT, 'src', spec));
  return null;
}

for (const abs of found.projectJson) {
  const j = readJsonLoose(abs) || {};
  const dir = toPosix(path.dirname(relOf(abs)));
  const root = dir === '.' ? '' : dir;
  addProject(j.name || (root ? path.posix.basename(root) : path.basename(ROOT)), j.projectType, root, j.sourceRoot);
}

/* ------------------------------------------------------------------ *
 * Scope: what counts as application code
 * ------------------------------------------------------------------ *
 * When angular.json or project.json files say where the projects live, application
 * code is what sits in those folders plus every file they import (a shared library
 * in a sibling folder or a git submodule, for instance). Mock servers, scripts and
 * tooling next to the app are left out and listed in the report.
 * --include adds folders by hand, --all counts every .ts file as before.
 */
function importSpecifiers(text) {
  try {
    return ts.preProcessFile(text, true, false).importedFiles.map((f) => f.fileName);
  } catch (e) {
    const out = [];
    const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  }
}
const scope = { mode: 'everything', roots: [], importedFromOutside: 0, leftOut: [] };
{
  const roots = projects.filter((p) => p.type !== 'e2e').map((p) => p.root || p.sourceRoot);
  if (!opts.all && roots.length && roots.every((r) => r !== '')) {
    scope.mode = 'project-folders';
    scope.roots = Array.from(new Set(roots.concat(opts.include.map(normDir).filter(Boolean)))).sort();
    const under = (abs) => {
      const rel = relOf(abs);
      return scope.roots.some((r) => rel === r || rel.startsWith(r + '/'));
    };
    const inScope = new Set();
    const queue = [];
    for (const abs of found.ts) {
      if (!under(abs)) continue;
      inScope.add(abs);
      queue.push(abs);
    }
    while (queue.length) {
      const abs = queue.pop();
      for (const spec of importSpecifiers(readText(abs))) {
        const dep = resolveSpec(spec, abs);
        if (!dep || inScope.has(dep)) continue;
        inScope.add(dep);
        queue.push(dep);
        scope.importedFromOutside++;
      }
    }
    const dirs = new Set();
    for (const abs of inScope) dirs.add(path.dirname(abs));
    const near = (abs) => under(abs) || dirs.has(path.dirname(abs));
    const left = {};
    for (const abs of found.ts) {
      if (inScope.has(abs)) continue;
      const rel = relOf(abs);
      const top = rel.indexOf('/') === -1 ? '(files in the scanned folder itself)' : rel.split('/')[0];
      const o = left[top] || (left[top] = { folder: top, files: 0, lines: 0 });
      o.files++;
      o.lines += nonBlank(readText(abs));
    }
    scope.leftOut = Object.keys(left)
      .map((k) => left[k])
      .sort((a, b) => b.lines - a.lines);
    found.ts = found.ts.filter((f) => inScope.has(f));
    for (const k of ['spec', 'story', 'testSupport', 'html', 'style']) found[k] = found[k].filter(near);
  }
}

/* ------------------------------------------------------------------ *
 * AST helpers
 * ------------------------------------------------------------------ */
function decoratorsOf(node) {
  if (typeof ts.getDecorators === 'function') {
    if (typeof ts.canHaveDecorators === 'function' && !ts.canHaveDecorators(node)) return [];
    return ts.getDecorators(node) || [];
  }
  return node.decorators || [];
}
function decoratorName(d) {
  let e = d.expression;
  if (ts.isCallExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}
function decoratorArg(d) {
  const e = d.expression;
  return ts.isCallExpression(e) && e.arguments.length ? e.arguments[0] : undefined;
}
function propName(p) {
  const n = p.name;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return undefined;
}
function strValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return undefined;
}
function arrayLen(node) {
  return node && ts.isArrayLiteralExpression(node) ? node.elements.length : 0;
}
function typeName(typeNode, sf) {
  return ts.isTypeReferenceNode(typeNode) ? typeNode.typeName.getText(sf) : typeNode.getText(sf);
}
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line;
function locInRange(lines, a, b) {
  let n = 0;
  for (const l of lines) if (l >= a && l <= b) n++;
  return n;
}
function roughCodeLines(text) {
  const lines = new Set();
  text.split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (t && !/^(\/\/|\/\*|\*)/.test(t)) lines.add(i);
  });
  return lines;
}
/** Line numbers that hold at least one token: blank lines and comments are not counted. */
function codeLines(sf) {
  const lines = new Set();
  const text = sf.text;
  const starts = sf.getLineStarts();
  const blank = (i) => text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length).trim() === '';
  const visit = (node) => {
    if (node.kind >= JSDOC_FIRST && node.kind <= JSDOC_LAST) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      if (node.kind === SK.EndOfFileToken || node.kind === SK.SyntaxList) return;
      const a = lineOf(sf, node.getStart(sf));
      const b = lineOf(sf, node.getEnd());
      if (a === b) lines.add(a);
      else for (let i = a; i <= b; i++) if (!blank(i)) lines.add(i);
      return;
    }
    for (const k of kids) visit(k);
  };
  try {
    visit(sf);
  } catch (e) {
    return roughCodeLines(text);
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Aggregation state
 * ------------------------------------------------------------------ */
const agg = {
  ts: { files: 0, loc: 0 },
  generated: { files: 0, loc: 0 },
  port: { angular: { files: 0, loc: 0 }, rxjs: { files: 0, loc: 0 }, free: { files: 0, loc: 0 } },
  imports: { angular: {}, external: {}, workspace: {} },
  routing: { routes: 0, screens: 0, lazyModules: 0, lazyComponents: 0, redirects: 0, guarded: 0, withResolvers: 0, withChildren: 0, parametrized: 0, wildcard: 0, functional: {} },
  state: { ngrx: {}, ngxsStates: 0, ngxsActions: 0, ngxsSelectors: 0, componentStores: 0, subjects: 0, storeDispatches: 0 },
  forms: { controls: 0, groups: 0, validatorRefs: 0, valueAccessors: 0, customValidators: 0, templateBindings: 0, ngModel: 0 },
  mf: { configs: 0, exposes: 0, remotes: 0, loadRemoteModule: 0, createCustomElement: 0, customElementsSchema: 0 },
  i18n: { translatePipe: 0, i18nAttrs: 0, localizeCalls: 0, translateServiceInjections: 0 },
  gql: { documents: 0, operations: 0 },
  tpl: { pipes: {}, tagPrefixes: {}, attrPrefixes: {}, ctrlFlow: 0, newFlow: 0, interpolations: 0, propBindings: 0, eventBindings: 0, twoWay: 0, ngContent: 0, ngTemplate: 0, templateOutlet: 0, componentOutlet: 0, routerOutlet: 0 },
  templates: { externalFiles: 0, externalLoc: 0, inlineCount: 0, inlineLoc: 0, inlineTsLines: 0, missing: 0 },
  tokens: {},
  misc: { dynamicImports: 0, parseErrors: 0 },
};
const components = [];
const classes = [];
const routedNames = new Set();
const routedFiles = new Set();
const referencedHtml = new Set();
const fileRecs = new Map(); // absolute path -> { port, loc, deps }
const GENERATED_RE = /@generated|auto-?generated|autogenerated|do not (?:edit|modify)|generated by|openapi generator|swagger-codegen|ng-openapi-gen/i;

/* ------------------------------------------------------------------ *
 * Template analysis (regex based, approximate by design)
 * ------------------------------------------------------------------ */
function analyzeTemplate(tpl) {
  const c = (re) => {
    const m = tpl.match(re);
    return m ? m.length : 0;
  };
  const newFlow = c(/@(?:if|for|switch|defer)\s*[({]/g);
  const t = {
    loc: nonBlank(tpl),
    ctrlFlow: c(/\*ng(?:If|For|SwitchCase|SwitchDefault)\b/g) + c(/\[ngSwitch\]/g) + newFlow,
    newFlow: newFlow,
    interpolations: c(/\{\{/g),
    propBindings: c(/\[[\w.\-%]+\]\s*=/g),
    eventBindings: c(/\([\w.\-:]+\)\s*=/g),
    twoWay: c(/\[\([\w.\-]+\)\]\s*=/g),
    ngContent: c(/<ng-content\b/g),
    ngTemplate: c(/<ng-template\b/g),
    templateOutlet: c(/ngTemplateOutlet/g),
    componentOutlet: c(/ngComponentOutlet/g),
    routerOutlet: c(/<router-outlet\b/g),
    formBindings: c(/\bformControlName\b|\bformGroupName\b|\bformArrayName\b|\[formControl\]|\[formGroup\]/g),
    ngModel: c(/\bngModel\b/g),
    i18nAttrs: c(/\si18n(?:-[\w\-]+)?(?=[\s=>])/g),
    pipes: {}, pipeCount: 0, tags: {}, tagPrefixes: {}, attrPrefixes: {},
  };
  let m;
  const pipeRe = /(?<![|])\|(?![|])\s*([A-Za-z_]\w*)/g;
  while ((m = pipeRe.exec(tpl))) {
    bump(t.pipes, m[1]);
    t.pipeCount++;
  }
  const tagRe = /<([a-z][a-z0-9]*)-[a-z0-9\-]+/g;
  while ((m = tagRe.exec(tpl))) {
    const tag = m[0].slice(1);
    if (tag === 'ng-content' || tag === 'ng-template' || tag === 'ng-container' || tag === 'router-outlet') continue;
    bump(t.tags, tag);
    bump(t.tagPrefixes, m[1]);
  }
  const attrRe = /[\s\[(*](mat|cdk|nz|ngb|kendo|igx|tui|clr|nb|dx|p)(?=[A-Z])[A-Za-z0-9]+/g;
  while ((m = attrRe.exec(tpl))) bump(t.attrPrefixes, m[1]);
  const dashAttrRe = /\s(mat|cdk|nz|nb|clr|tui)-[a-z][a-z0-9\-]*(?=[\s=>\/])/g;
  while ((m = dashAttrRe.exec(tpl))) bump(t.attrPrefixes, m[1]);
  return t;
}

/* ------------------------------------------------------------------ *
 * Class analysis
 * ------------------------------------------------------------------ */
function isFormNew(n) {
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && FORM_NEW_RE.test(n.expression.text);
}
function fbMethod(n, sf) {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return null;
  const name = n.expression.name.text;
  if (name !== 'group' && name !== 'control' && name !== 'array' && name !== 'record') return null;
  const recv = n.expression.expression.getText(sf).replace(/^this\./, '').replace(/\.nonNullable$/, '').replace(/[_#]/g, '');
  return /(fb|formbuilder|builder)$/i.test(recv) ? name : null;
}
function countGroupProps(arg, sf) {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return 0;
  let n = 0;
  for (const p of arg.properties) if (ts.isPropertyAssignment(p) && !isFormNew(p.initializer) && !fbMethod(p.initializer, sf)) n++;
  return n;
}

function analyzeClass(cls, sf, lines) {
  const a = lineOf(sf, cls.getStart(sf));
  const b = lineOf(sf, cls.getEnd());
  const ci = {
    name: cls.name ? cls.name.text : '(anonymous)', startLine: a, endLine: b, loc: locInRange(lines, a, b),
    ctorParams: 0, injectCalls: 0, injected: new Set(), inputs: 0, outputs: 0, queries: 0, hostListeners: 0, hostBindings: 0,
    methods: 0, hooks: 0, implementsList: [], extendsName: '', subscribes: 0, rxPipes: 0, manualCd: 0, dynamicCreate: 0,
    dispatches: 0, navigations: 0, httpCalls: 0, gqlCalls: 0, subjects: 0, signals: 0, effects: 0, createEffect: 0,
    formControls: 0, formGroups: 0, validatorRefs: 0, ngxsActions: 0, ngxsSelectors: 0, deps: 0,
  };
  for (const h of cls.heritageClauses || []) {
    for (const t of h.types) {
      const n = t.expression.getText(sf);
      if (h.token === SK.ImplementsKeyword) ci.implementsList.push(n);
      else ci.extendsName = n;
    }
  }
  for (const m of cls.members) {
    for (const d of decoratorsOf(m)) {
      const n = decoratorName(d);
      if (n === 'Input') ci.inputs++;
      else if (n === 'Output') ci.outputs++;
      else if (QUERY_DECORATORS.has(n)) ci.queries++;
      else if (n === 'HostListener') ci.hostListeners++;
      else if (n === 'HostBinding') ci.hostBindings++;
      else if (n === 'Effect') ci.createEffect++;
      else if (n === 'Action') ci.ngxsActions++;
      else if (n === 'Selector') ci.ngxsSelectors++;
    }
    if (ts.isConstructorDeclaration(m)) {
      ci.ctorParams += m.parameters.length;
      for (const p of m.parameters) {
        if (p.type) ci.injected.add(typeName(p.type, sf));
        for (const d of decoratorsOf(p)) {
          if (decoratorName(d) !== 'Inject') continue;
          const arg = decoratorArg(d);
          if (arg) ci.injected.add(arg.getText(sf));
        }
      }
    } else if (ts.isMethodDeclaration(m)) {
      ci.methods++;
      if (m.name && LIFECYCLE.has(m.name.getText(sf))) ci.hooks++;
    } else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
      ci.methods++;
    } else if (ts.isPropertyDeclaration(m) && m.initializer) {
      const init = m.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ci.methods++;
      else if (ts.isCallExpression(init)) {
        const callee = init.expression.getText(sf);
        if (INPUT_FNS.has(callee)) ci.inputs++;
        else if (MODEL_FNS.has(callee)) {
          ci.inputs++;
          ci.outputs++;
        } else if (OUTPUT_FNS.has(callee)) ci.outputs++;
        else if (QUERY_FNS.has(callee)) ci.queries++;
      }
    }
  }
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        const t = callee.text;
        if (t === 'inject') {
          ci.injectCalls++;
          if (n.arguments[0]) ci.injected.add(n.arguments[0].getText(sf));
        } else if (SIGNAL_FNS.has(t)) ci.signals++;
        else if (t === 'effect') ci.effects++;
        else if (t === 'createEffect') ci.createEffect++;
      } else if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (name === 'subscribe') ci.subscribes++;
        else if (name === 'pipe') ci.rxPipes++;
        else if (name === 'detectChanges' || name === 'markForCheck') ci.manualCd++;
        else if (name === 'createComponent' || name === 'createEmbeddedView') ci.dynamicCreate++;
        else if (name === 'dispatch') ci.dispatches++;
        else if (name === 'navigate' || name === 'navigateByUrl') ci.navigations++;
        else if (name === 'watchQuery') ci.gqlCalls++;
        else if ((name === 'query' || name === 'mutate') && /apollo/i.test(callee.expression.getText(sf))) ci.gqlCalls++;
        else if ((name === 'watch' || name === 'fetch' || name === 'mutate') && /gql$/i.test(callee.expression.getText(sf))) ci.gqlCalls++;
        else if (HTTP_VERBS.has(name) && /http/i.test(callee.expression.getText(sf))) ci.httpCalls++;
        else {
          const fb = fbMethod(n, sf);
          if (fb === 'control') ci.formControls++;
          else if (fb === 'group' || fb === 'record') {
            ci.formGroups++;
            ci.formControls += countGroupProps(n.arguments[0], sf);
          } else if (fb === 'array') ci.formGroups++;
        }
      }
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      const t = n.expression.text;
      const fm = FORM_NEW_RE.exec(t);
      if (fm) {
        if (fm[2] === 'Control') ci.formControls++;
        else {
          ci.formGroups++;
          if (fm[2] !== 'Array') ci.formControls += countGroupProps(n.arguments && n.arguments[0], sf);
        }
      } else if (SUBJECT_RE.test(t)) ci.subjects++;
    } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Validators') {
      ci.validatorRefs++;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(cls, visit);
  ci.deps = ci.ctorParams + ci.injectCalls;
  return ci;
}

function bucketOf(c) {
  const total = c.classLoc + c.tplLoc;
  const idx = total <= SIZE.S ? 0 : total <= SIZE.M ? 1 : total <= SIZE.L ? 2 : 3;
  const reasons = [];
  if (c.deps >= COUPLING.deps) reasons.push('deps');
  if (c.subscribes >= COUPLING.subscribes) reasons.push('rx');
  if (Math.max(c.formControls, c.tplFormBindings + c.ngModel) >= COUPLING.formControls) reasons.push('forms');
  if (c.queries >= COUPLING.queries) reasons.push('queries');
  if (c.cva) reasons.push('cva');
  if (c.dynamic) reasons.push('dynamic');
  if (c.directDom) reasons.push('dom');
  if (c.inheritance) reasons.push('inherit');
  if (c.ngContent + c.templateOutlet >= COUPLING.projection) reasons.push('projection');
  if (c.inputs + c.outputs >= COUPLING.api) reasons.push('api');
  const up = reasons.length >= BUMP.two ? 2 : reasons.length >= BUMP.one ? 1 : 0;
  return { sizeBucket: BUCKETS[idx], bucket: BUCKETS[Math.min(3, idx + up)], points: reasons.length, reasons: reasons.join('+') };
}

function injectableKind(ci, relLower, isNgxsState) {
  const impl = ci.implementsList;
  if (isNgxsState) return 'store';
  if (impl.some((i) => GUARD_IFACES.has(i)) || /\.guard\.ts$/.test(relLower)) return 'guard';
  if (impl.indexOf('HttpInterceptor') !== -1 || /\.interceptor\.ts$/.test(relLower)) return 'interceptor';
  if (impl.indexOf('Resolve') !== -1 || /\.resolver\.ts$/.test(relLower)) return 'resolver';
  if (ci.createEffect > 0 || /\.effects\.ts$/.test(relLower)) return 'effects';
  if (/^ComponentStore/.test(ci.extendsName) || /\.(store|facade)\.ts$/.test(relLower)) return 'store';
  return 'service';
}

/* ------------------------------------------------------------------ *
 * File-level analysis
 * ------------------------------------------------------------------ */
function recordRoute(obj, sf, proj, abs) {
  const keys = new Map();
  for (const p of obj.properties) {
    const k = propName(p);
    if (k) keys.set(k, p);
  }
  if (!keys.has('path') && !keys.has('matcher')) return;
  if (!STRONG_ROUTE_KEYS.some((k) => keys.has(k))) return;
  const r = agg.routing;
  r.routes++;
  proj.routes++;
  const pp = keys.get('path');
  const pv = pp && ts.isPropertyAssignment(pp) ? strValue(pp.initializer) : undefined;
  if (pv === '**') r.wildcard++;
  if (pv && pv.indexOf(':') !== -1) r.parametrized++;
  if (keys.has('redirectTo')) r.redirects++;
  if (keys.has('component') || keys.has('loadComponent')) {
    r.screens++;
    proj.screens++;
  }
  if (keys.has('loadChildren')) r.lazyModules++;
  if (keys.has('loadComponent')) r.lazyComponents++;
  if (GUARD_KEYS.some((k) => keys.has(k))) r.guarded++;
  if (keys.has('resolve')) r.withResolvers++;
  if (keys.has('children')) r.withChildren++;
  const comp = keys.get('component');
  if (comp && ts.isPropertyAssignment(comp) && ts.isIdentifier(comp.initializer)) routedNames.add(comp.initializer.text);
  const lc = keys.get('loadComponent');
  if (lc && ts.isPropertyAssignment(lc)) {
    const text = lc.initializer.getText(sf);
    const m = /\.\s*([A-Za-z_$][\w$]*)\s*\)?\s*$/.exec(text);
    if (m) routedNames.add(m[1]);
    else {
      // default export: import('./x.component') with no .then(m => m.X)
      const im = /import\(\s*['"]([^'"]+)['"]\s*\)/.exec(text);
      const file = im && resolveSpec(im[1], abs);
      if (file) routedFiles.add(file);
    }
  }
}

function walkFile(sf, importsRouter, proj, abs) {
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (c.kind === SK.ImportKeyword) agg.misc.dynamicImports++;
      else if (ts.isIdentifier(c)) {
        const t = c.text;
        if (NGRX_CALLS.has(t)) bump(agg.state.ngrx, t);
        else if (t === 'loadRemoteModule') agg.mf.loadRemoteModule++;
        else if (t === 'createCustomElement') agg.mf.createCustomElement++;
      }
    } else if (ts.isObjectLiteralExpression(n)) {
      if (importsRouter) recordRoute(n, sf, proj, abs);
    } else if (ts.isVariableDeclaration(n) && n.type) {
      const t = n.type.getText(sf).split('<')[0].trim();
      if (FN_TYPES.has(t)) bump(agg.routing.functional, t);
    } else if (ts.isTaggedTemplateExpression(n)) {
      const tag = n.tag.getText(sf);
      if (tag === '$localize') agg.i18n.localizeCalls++;
      else if (tag === 'gql' || tag === 'graphql') {
        agg.gql.documents++;
        agg.gql.operations += Math.max(1, (n.template.getText(sf).match(/(?:^|[\s`}])(?:query|mutation|subscription|fragment)\b/g) || []).length);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function analyzeTs(abs) {
  const rel = relOf(abs);
  const relLower = rel.toLowerCase();
  const proj = projectOf(rel);
  const text = readText(abs);
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = codeLines(sf);
  const loc = lines.size;

  // --- generated code (API clients and the like) is regenerated, not migrated: count it apart
  const head = /^\s*(?:\/\/[^\n]*(?:\n|$)\s*|\/\*[\s\S]*?\*\/\s*)+/.exec(text);
  if ((head && GENERATED_RE.test(head[0])) || GENERATED_PATH_RE.test(rel) || CODEGEN_SIGNATURE_RE.test(text.slice(0, 4000))) {
    agg.generated.files++;
    agg.generated.loc += loc;
    return;
  }

  // --- imports
  let bound = false;
  let rx = false;
  let importsRouter = false;
  const seen = new Set();
  const localDeps = [];
  const importedFrom = new Map(); // local name -> module it was imported from
  for (const st of sf.statements) {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const named = ts.isImportDeclaration(st) && st.importClause && st.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) importedFrom.set(el.name.text, spec);
    const local = resolveSpec(spec, abs);
    if (local) localDeps.push(local);
    if (spec.charAt(0) === '.' || spec.charAt(0) === '/') continue;
    const alias = matchAlias(spec);
    if (alias) {
      if (!seen.has('a:' + alias)) {
        seen.add('a:' + alias);
        bump(agg.imports.workspace, alias);
      }
      continue;
    }
    if (isLocalBare(spec)) continue;
    const pkg = pkgName(spec);
    if (spec === '@angular/router') importsRouter = true;
    if (pkg === 'rxjs') rx = true;
    if (isAngularBound(pkg)) bound = true;
    if (/^@angular\//.test(spec) && !seen.has('e:' + spec)) {
      seen.add('e:' + spec);
      bump(agg.imports.angular, spec);
    }
    if (!seen.has('p:' + pkg)) {
      seen.add('p:' + pkg);
      bump(agg.imports.external, pkg);
    }
  }
  if (/\bCUSTOM_ELEMENTS_SCHEMA\b/.test(text)) agg.mf.customElementsSchema++;

  // --- classes
  const found = [];
  (function find(n) {
    if (ts.isClassDeclaration(n)) found.push(n);
    ts.forEachChild(n, find);
  })(sf);

  for (const cls of found) {
    let kind = null;
    let meta;
    let isNgxsState = false;
    for (const d of decoratorsOf(cls)) {
      const n = decoratorName(d);
      if (KIND_RANK[n] === undefined) continue;
      // same decorator names exist elsewhere (NestJS @Injectable, Stencil @Component): trust the import
      const from = importedFrom.get(n);
      if (n === 'State' ? from !== '@ngxs/store' : from !== undefined && !/^@angular\//.test(from)) continue;
      if (n === 'State') isNgxsState = true;
      if (kind === null || KIND_RANK[n] < KIND_RANK[kind]) {
        kind = n;
        meta = decoratorArg(d);
      }
    }
    if (!kind) continue;
    bound = true;
    const ci = analyzeClass(cls, sf, lines);
    const obj = meta && ts.isObjectLiteralExpression(meta) ? meta : null;
    const get = (k) => {
      if (!obj) return undefined;
      for (const p of obj.properties) if (ts.isPropertyAssignment(p) && propName(p) === k) return p.initializer;
      return undefined;
    };
    const has = (list) => list.some((t) => ci.injected.has(t));
    for (const t of ci.injected) if (FRAMEWORK_TOKENS.has(t)) bump(agg.tokens, t);
    if (ci.injected.has('TranslateService') || ci.injected.has('TranslocoService')) agg.i18n.translateServiceInjections++;
    agg.forms.controls += ci.formControls;
    agg.forms.groups += ci.formGroups;
    agg.forms.validatorRefs += ci.validatorRefs;
    agg.state.subjects += ci.subjects;
    agg.state.ngxsActions += ci.ngxsActions;
    agg.state.ngxsSelectors += ci.ngxsSelectors;
    if (ci.injected.has('Store')) agg.state.storeDispatches += ci.dispatches;
    const providersText = ['providers', 'viewProviders'].map((k) => (get(k) ? get(k).getText(sf) : '')).join(' ');
    const cva = ci.implementsList.indexOf('ControlValueAccessor') !== -1 || /NG_VALUE_ACCESSOR/.test(providersText);
    const validator = ci.implementsList.indexOf('Validator') !== -1 || ci.implementsList.indexOf('AsyncValidator') !== -1 || /NG_(ASYNC_)?VALIDATORS/.test(providersText);
    if (cva) agg.forms.valueAccessors++;
    if (validator) agg.forms.customValidators++;

    if (kind === 'Component') {
      let tplText = '';
      let inlineTemplate = false;
      let inlineLines = 0;
      const tplNode = get('template');
      const tplUrl = strValue(get('templateUrl'));
      if (tplNode) {
        inlineTemplate = true;
        tplText = strValue(tplNode) || '';
        inlineLines += locInRange(lines, lineOf(sf, tplNode.getStart(sf)), lineOf(sf, tplNode.getEnd()));
      } else if (tplUrl) {
        const p = path.resolve(path.dirname(abs), tplUrl);
        if (fs.existsSync(p)) {
          tplText = readText(p);
          referencedHtml.add(p);
        } else agg.templates.missing++;
      }
      let styleLoc = 0;
      const stylesNode = get('styles');
      if (stylesNode) {
        inlineLines += locInRange(lines, lineOf(sf, stylesNode.getStart(sf)), lineOf(sf, stylesNode.getEnd()));
        const parts = ts.isArrayLiteralExpression(stylesNode) ? stylesNode.elements.map(strValue) : [strValue(stylesNode)];
        for (const s of parts) styleLoc += nonBlank(s || '');
      }
      const urls = [];
      const su = get('styleUrls');
      if (su && ts.isArrayLiteralExpression(su)) for (const e of su.elements) if (strValue(e)) urls.push(strValue(e));
      if (strValue(get('styleUrl'))) urls.push(strValue(get('styleUrl')));
      for (const u of urls) {
        const p = path.resolve(path.dirname(abs), u);
        if (fs.existsSync(p)) styleLoc += nonBlank(readText(p));
      }
      const t = analyzeTemplate(tplText);
      const standaloneNode = get('standalone');
      const hostNode = get('host');
      const encText = get('encapsulation') ? get('encapsulation').getText(sf) : '';
      const c = {
        project: proj.name, file: rel, name: ci.name, selector: strValue(get('selector')) || '',
        standalone: !standaloneNode ? 'default' : standaloneNode.kind === SK.TrueKeyword ? 'true' : standaloneNode.kind === SK.FalseKeyword ? 'false' : 'default',
        onPush: /OnPush/.test(get('changeDetection') ? get('changeDetection').getText(sf) : ''),
        inlineTemplate: inlineTemplate,
        classLoc: Math.max(0, ci.loc - inlineLines), tplLoc: t.loc, styleLoc: styleLoc,
        deps: ci.deps,
        inputs: ci.inputs + arrayLen(get('inputs')), outputs: ci.outputs + arrayLen(get('outputs')), queries: ci.queries,
        hostBindings: ci.hostListeners + ci.hostBindings + (hostNode && ts.isObjectLiteralExpression(hostNode) ? hostNode.properties.length : 0),
        methods: ci.methods, hooks: ci.hooks, subscribes: ci.subscribes, rxPipes: ci.rxPipes, signals: ci.signals, effects: ci.effects,
        manualCd: ci.manualCd, dispatches: ci.dispatches, navigations: ci.navigations, httpCalls: ci.httpCalls, gqlCalls: ci.gqlCalls,
        formControls: ci.formControls, tplFormBindings: t.formBindings, ngModel: t.ngModel,
        ctrlFlow: t.ctrlFlow, bindings: t.propBindings + t.eventBindings + t.twoWay, interpolations: t.interpolations,
        childTags: Object.keys(t.tags).length, ngContent: t.ngContent, ngTemplate: t.ngTemplate, templateOutlet: t.templateOutlet, tplPipes: t.pipeCount,
        cva: cva, validator: validator,
        dynamic: has(DYNAMIC_TOKENS) || ci.dynamicCreate > 0 || t.componentOutlet > 0,
        directDom: has(DOM_TOKENS), inheritance: !!ci.extendsName,
        animations: !!get('animations'), ownProviders: arrayLen(get('providers')) + arrayLen(get('viewProviders')) > 0,
        encapsulationOff: /None/.test(encText), shadowDom: /ShadowDom/.test(encText),
        routed: false, specCases: -1, abs: abs,
      };
      Object.assign(c, bucketOf(c));
      c.totalLoc = c.classLoc + c.tplLoc;
      components.push(c);
      proj.components++;
      proj.buckets[c.bucket]++;
      proj.templateLoc += t.loc;
      agg.templates.inlineTsLines += Math.min(inlineLines, ci.loc);
      if (inlineTemplate) {
        agg.templates.inlineCount++;
        agg.templates.inlineLoc += t.loc;
      } else if (tplText) {
        agg.templates.externalFiles++;
        agg.templates.externalLoc += t.loc;
      }
      // app-wide template totals
      const T = agg.tpl;
      for (const k of ['ctrlFlow', 'newFlow', 'interpolations', 'propBindings', 'eventBindings', 'twoWay', 'ngContent', 'ngTemplate', 'templateOutlet', 'componentOutlet', 'routerOutlet']) T[k] += t[k];
      for (const k of Object.keys(t.pipes)) bump(T.pipes, k, t.pipes[k]);
      for (const k of Object.keys(t.tagPrefixes)) bump(T.tagPrefixes, k, t.tagPrefixes[k]);
      for (const k of Object.keys(t.attrPrefixes)) bump(T.attrPrefixes, k, t.attrPrefixes[k]);
      agg.forms.templateBindings += t.formBindings;
      agg.forms.ngModel += t.ngModel;
      agg.i18n.i18nAttrs += t.i18nAttrs;
      agg.i18n.translatePipe += (t.pipes.translate || 0) + (t.pipes.transloco || 0);
    } else {
      const rec = {
        project: proj.name, file: rel, kind: '', name: ci.name, loc: ci.loc, deps: ci.deps, methods: ci.methods,
        subscribes: ci.subscribes, rxPipes: ci.rxPipes, httpCalls: ci.httpCalls, gqlCalls: ci.gqlCalls, subjects: ci.subjects, signals: ci.signals,
        dispatches: ci.dispatches, inputs: ci.inputs, outputs: ci.outputs, hostListeners: ci.hostListeners,
        detail: '', specCases: -1,
      };
      if (kind === 'Directive') {
        rec.kind = 'directive';
        rec.detail = ci.injected.has('TemplateRef') ? 'structural' : strValue(get('selector')) ? '' : 'abstract-base';
        proj.directives++;
      } else if (kind === 'Pipe') {
        rec.kind = 'pipe';
        const pure = get('pure');
        rec.detail = pure && pure.kind === SK.FalseKeyword ? 'impure' : '';
        proj.pipes++;
      } else if (kind === 'NgModule') {
        rec.kind = 'module';
        rec.detail = 'declarations=' + arrayLen(get('declarations')) + ' imports=' + arrayLen(get('imports')) + ' providers=' + arrayLen(get('providers')) + ' exports=' + arrayLen(get('exports'));
        proj.modules++;
      } else {
        rec.kind = injectableKind(ci, relLower, isNgxsState);
        const prov = get('providedIn');
        rec.detail = prov ? 'providedIn=' + (strValue(prov) || prov.getText(sf)) : '';
        if (isNgxsState) agg.state.ngxsStates++;
        if (/^ComponentStore/.test(ci.extendsName)) agg.state.componentStores++;
        proj.injectables++;
      }
      classes.push(rec);
    }
  }

  walkFile(sf, importsRouter, proj, abs);

  const port = bound ? 'angular' : rx ? 'rxjs' : 'free';
  fileRecs.set(abs, { port: port, loc: loc, deps: localDeps });
  agg.ts.files++;
  agg.ts.loc += loc;
  agg.port[port].files++;
  agg.port[port].loc += loc;
  proj.tsFiles++;
  proj.tsLoc += loc;
  proj[port + 'Loc'] += loc;
}

/* ------------------------------------------------------------------ *
 * Run: app code
 * ------------------------------------------------------------------ */
const started = Date.now();
found.ts.forEach((abs, i) => {
  if (!opts.quiet && i > 0 && i % 500 === 0) process.stderr.write('  parsed ' + i + ' / ' + found.ts.length + ' files\n');
  try {
    analyzeTs(abs);
  } catch (e) {
    agg.misc.parseErrors++;
    const loc = roughCodeLines(readText(abs)).size;
    agg.ts.files++;
    agg.ts.loc += loc;
    agg.port.angular.files++;
    agg.port.angular.loc += loc;
  }
});
for (const c of components) c.routed = routedNames.has(c.name) || routedFiles.has(c.abs);

// Framework-free files with no local import chain (type imports included) that leads to Angular-bound code
const selfContained = { files: 0, loc: 0 };
{
  const importers = new Map();
  for (const [f, r] of fileRecs) {
    for (const d of r.deps) {
      if (!importers.has(d)) importers.set(d, []);
      importers.get(d).push(f);
    }
  }
  const tainted = new Set();
  const queue = [];
  for (const [f, r] of fileRecs) {
    if (r.port === 'angular') {
      tainted.add(f);
      queue.push(f);
    }
  }
  while (queue.length) {
    for (const i of importers.get(queue.pop()) || []) {
      if (tainted.has(i)) continue;
      tainted.add(i);
      queue.push(i);
    }
  }
  for (const [f, r] of fileRecs) {
    if (r.port !== 'free' || tainted.has(f)) continue;
    selfContained.files++;
    selfContained.loc += r.loc;
  }
}

/* ------------------------------------------------------------------ *
 * Run: tests
 * ------------------------------------------------------------------ */
const unit = {
  files: 0, loc: 0, cases: 0,
  testbed: { files: 0, cases: 0, loc: 0 }, angularNoTestbed: { files: 0, cases: 0, loc: 0 }, pure: { files: 0, cases: 0, loc: 0 },
};
const specCasesByFile = new Map();
for (const abs of found.spec) {
  const text = readText(abs);
  const rel = relOf(abs);
  const loc = nonBlank(text);
  const cases = (text.match(TEST_CASE_RE) || []).length;
  let cat = 'pure';
  if (TESTBED_RE.test(text)) cat = 'testbed';
  else {
    const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (spec.charAt(0) === '.' || matchAlias(spec) || isLocalBare(spec)) continue;
      if (isAngularBound(pkgName(spec))) {
        cat = 'angularNoTestbed';
        break;
      }
    }
  }
  unit.files++;
  unit.loc += loc;
  unit.cases += cases;
  unit[cat].files++;
  unit[cat].cases += cases;
  unit[cat].loc += loc;
  specCasesByFile.set(rel.replace(/\.(spec|test)\.ts$/, '.ts'), cases);
  const p = projectOf(rel);
  p.specFiles++;
  p.specCases += cases;
}
for (const c of components) c.specCases = specCasesByFile.has(c.file) ? specCasesByFile.get(c.file) : -1;
for (const c of classes) c.specCases = specCasesByFile.has(c.file) ? specCasesByFile.get(c.file) : -1;

const e2e = { files: 0, loc: 0, cases: 0, byFramework: {}, featureFiles: 0, scenarios: 0, supportFiles: found.e2eSupport.length };
for (const abs of found.e2e) {
  const text = readText(abs);
  const cases = (text.match(TEST_CASE_RE) || []).length;
  let fw = 'other';
  if (/\bcy\.\w+\(/.test(text) || /\.cy\.(ts|js)$/i.test(abs)) fw = 'cypress';
  else if (/@playwright\/test|\bpage\.(?:goto|locator|getBy\w+)\(/.test(text)) fw = 'playwright';
  else if (/from\s+['"]protractor['"]|\belement\(\s*by\./.test(text)) fw = 'protractor';
  e2e.files++;
  e2e.loc += nonBlank(text);
  e2e.cases += cases;
  if (!e2e.byFramework[fw]) e2e.byFramework[fw] = { files: 0, cases: 0 };
  e2e.byFramework[fw].files++;
  e2e.byFramework[fw].cases += cases;
  const p = projectOf(relOf(abs));
  p.e2eFiles++;
  p.e2eCases += cases;
}
{
  // tests written through page objects name no framework: attribute them when only one e2e tool is installed
  const tools = ['cypress', 'playwright', 'protractor', 'webdriverio', 'testcafe'].filter(
    (n) => declaredDeps[n] || (n === 'playwright' && declaredDeps['@playwright/test']) || (n === 'webdriverio' && declaredDeps['@wdio/cli'])
  );
  const other = e2e.byFramework.other;
  if (other && tools.length === 1) {
    const t = e2e.byFramework[tools[0]] || (e2e.byFramework[tools[0]] = { files: 0, cases: 0 });
    t.files += other.files;
    t.cases += other.cases;
    delete e2e.byFramework.other;
  }
}
for (const abs of found.feature) {
  const text = readText(abs);
  e2e.featureFiles++;
  e2e.scenarios += (text.match(/^\s*(?:Scenario|Scenario Outline|Scenario Template|Example):/gm) || []).length;
}

const coverage = [];
const lcovFiles = [];
(function findCoverage(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) findCoverage(full, depth + 1);
    else if (e.isFile() && e.name === 'coverage-summary.json') {
      const j = readJsonLoose(full);
      const t = j && j.total;
      if (t && t.lines) coverage.push({ path: relOf(full), lines: t.lines.pct, statements: t.statements && t.statements.pct, branches: t.branches && t.branches.pct, functions: t.functions && t.functions.pct });
    } else if (e.isFile() && e.name === 'lcov.info') lcovFiles.push(full);
  }
})(path.join(ROOT, 'coverage'), 0);
if (!coverage.length) {
  // no json-summary reporter: fall back to the totals in lcov.info
  for (const f of lcovFiles) {
    const t = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
    const re = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)/gm;
    const text = readText(f);
    let m;
    while ((m = re.exec(text))) t[m[1]] += parseInt(m[2], 10);
    if (!t.LF) continue;
    const p = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    coverage.push({ path: relOf(f), lines: p(t.LH, t.LF), statements: null, branches: p(t.BRH, t.BRF), functions: p(t.FNH, t.FNF) });
  }
}

const graphql = { files: 0, operations: { query: 0, mutation: 0, subscription: 0, fragment: 0 }, schemaDefinitions: 0, documentsInTs: agg.gql.documents, operationsInTs: agg.gql.operations, callSites: 0 };
const seenGraphql = new Set();
for (const abs of found.graphql) {
  const text = readText(abs);
  // the same schema is often copied into mock servers: count identical files once
  const digest = require('crypto').createHash('sha1').update(text).digest('hex');
  if (seenGraphql.has(digest)) continue;
  seenGraphql.add(digest);
  graphql.files++;
  const re = /^\s*(query|mutation|subscription|fragment)\b/gm;
  let m;
  while ((m = re.exec(text))) graphql.operations[m[1]]++;
  graphql.schemaDefinitions += (text.match(/^\s*(?:extend\s+)?(?:type|input|enum|interface|union|scalar)\s+\w+/gm) || []).length;
}
graphql.callSites = sum(components, (c) => c.gqlCalls) + sum(classes, (c) => c.gqlCalls);

/* ------------------------------------------------------------------ *
 * Run: the rest (styles, loose html, stories, microfrontend configs)
 * ------------------------------------------------------------------ */
const styles = { files: found.style.length, loc: sum(found.style, (f) => nonBlank(readText(f))) };
const otherHtmlFiles = found.html.filter((f) => !referencedHtml.has(f));
const otherHtml = { files: otherHtmlFiles.length, loc: sum(otherHtmlFiles, (f) => nonBlank(readText(f))) };
const stories = { files: found.story.length, loc: sum(found.story, (f) => nonBlank(readText(f))) };
const testSupport = { files: found.testSupport.length, loc: sum(found.testSupport, (f) => nonBlank(readText(f))) };
for (const abs of found.mfConfig) {
  const text = readText(abs);
  if (!/ModuleFederation|withNativeFederation|module-federation|native-federation/.test(text)) continue;
  agg.mf.configs++;
  for (const key of ['exposes', 'remotes']) {
    const m = new RegExp(key + '\\s*:\\s*\\{([\\s\\S]*?)\\}').exec(text);
    if (m) agg.mf[key] += (m[1].match(/(?:^|[,{\s])(?:(['"])[^'"\n]+\1|[A-Za-z_$][\w$]*)\s*:(?!\/)/g) || []).length;
    else {
      const arr = new RegExp(key + '\\s*:\\s*\\[([\\s\\S]*?)\\]').exec(text);
      if (arr) agg.mf[key] += (arr[1].match(/['"][^'"]+['"]/g) || []).length;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */
const anon = opts.anonymize;
const idMaps = {};
function anonId(group, value) {
  if (!anon) return value;
  const m = idMaps[group] || (idMaps[group] = new Map());
  if (!m.has(value)) m.set(value, group + '-' + (m.size + 1));
  return m.get(value);
}
/** Class name as written, or a stable id when --anonymize is set. */
function displayName(group, c) {
  return anon ? anonId(group, c.file + '#' + c.name) : c.name;
}

const angularDeclared = declaredDeps['@angular/core'] || null;
const angularInstalled = (installedPkg('@angular/core') || {}).version || null;
const angularMajor = (() => {
  const m = /(\d+)\./.exec(angularInstalled || angularDeclared || '');
  return m ? parseInt(m[1], 10) : null;
})();
const standaloneByDefault = angularMajor !== null && angularMajor >= 19;

components.sort((a, b) => b.totalLoc - a.totalLoc || (a.file < b.file ? -1 : 1));
classes.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : b.loc - a.loc));

const allProjects = projects.concat(rootProject.tsFiles || rootProject.specFiles || rootProject.e2eFiles ? [rootProject] : []);
const countKind = (k) => classes.filter((c) => c.kind === k).length;
const locKind = (k) => sum(classes.filter((c) => c.kind === k), (c) => c.loc);
const injectableKinds = ['service', 'guard', 'interceptor', 'resolver', 'effects', 'store'];
const flagCount = (k) => components.filter((c) => c[k]).length;
const reasonCounts = {};
for (const c of components) for (const r of c.reasons ? c.reasons.split('+') : []) bump(reasonCounts, r);
const topN = (obj, n) =>
  Object.keys(obj)
    .map((k) => ({ name: k, count: obj[k] }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, n);

const byBucket = {};
const bySizeOnly = {};
for (const b of BUCKETS) {
  const list = components.filter((c) => c.bucket === b);
  byBucket[b] = { count: list.length, classLoc: sum(list, (c) => c.classLoc), templateLoc: sum(list, (c) => c.tplLoc), withSpec: list.filter((c) => c.specCases >= 0).length };
  bySizeOnly[b] = components.filter((c) => c.sizeBucket === b).length;
}

const depsAngularBound = Object.keys(declaredDeps)
  .filter((d) => isAngularBound(d))
  .sort()
  .map((d) => ({ name: d, version: declaredDeps[d] }));
const tooling = {};
for (const g of Object.keys(TOOLING)) tooling[g] = TOOLING[g].filter((d) => declaredDeps[d]).map((d) => ({ name: d, version: declaredDeps[d] }));

const externalImports = topN(agg.imports.external, 1000).map((e) => ({ name: e.name, files: e.count, angularBound: isAngularBound(e.name) }));
const componentClassLoc = sum(components, (c) => c.classLoc);
const decoratedLoc = componentClassLoc + sum(classes, (c) => c.loc);

const summary = {
  tool: 'ng-inventory',
  version: VERSION,
  generatedAt: new Date().toISOString(),
  target: anon ? '(anonymized)' : path.basename(ROOT),
  environment: { node: process.version, typescript: ts.version, nodeModulesFound: nodeModulesDirs.length > 0, durationMs: 0 },
  workspace: {
    angularDeclared: angularDeclared,
    angularInstalled: angularInstalled,
    rxjs: declaredDeps.rxjs || null,
    nx: fs.existsSync(path.join(ROOT, 'nx.json')),
    pathAliases: ALIASES.length,
    projects: allProjects.map((p) => ({ name: anonId('project', p.name), type: p.type })),
  },
  scope: {
    mode: scope.mode,
    folders: scope.roots.map((r) => anonId('folder', r)),
    filesImportedFromOutside: scope.importedFromOutside,
    leftOut: scope.leftOut.map((o) => ({ folder: anonId('folder', o.folder), files: o.files, lines: o.lines })),
  },
  files: {
    ts: agg.ts,
    generatedTs: agg.generated,
    templates: agg.templates,
    otherHtml: otherHtml,
    styles: styles,
    stories: stories,
    testSupport: testSupport,
    parseErrors: agg.misc.parseErrors,
  },
  tsLocByRole: {
    componentClasses: componentClassLoc,
    directives: locKind('directive'),
    pipes: locKind('pipe'),
    modules: locKind('module'),
    injectables: sum(injectableKinds, locKind),
    inlineTemplatesAndStyles: agg.templates.inlineTsLines,
    everythingElse: Math.max(0, agg.ts.loc - decoratedLoc - agg.templates.inlineTsLines),
  },
  portability: {
    angularBound: agg.port.angular,
    rxjsOnly: agg.port.rxjs,
    frameworkFree: agg.port.free,
    frameworkFreeSelfContained: selfContained,
    angularBoundPct: pct(agg.port.angular.loc, agg.ts.loc),
    rxjsOnlyPct: pct(agg.port.rxjs.loc, agg.ts.loc),
    frameworkFreePct: pct(agg.port.free.loc, agg.ts.loc),
    frameworkFreeSelfContainedPct: pct(selfContained.loc, agg.ts.loc),
  },
  components: {
    count: components.length,
    byBucket: byBucket,
    bySizeOnly: bySizeOnly,
    bumpReasons: reasonCounts,
    loc: { class: componentClassLoc, template: sum(components, (c) => c.tplLoc), styles: sum(components, (c) => c.styleLoc) },
    standalone: components.filter((c) => c.standalone === 'true' || (c.standalone === 'default' && standaloneByDefault)).length,
    onPush: flagCount('onPush'),
    inlineTemplate: flagCount('inlineTemplate'),
    routed: flagCount('routed'),
    withSpec: components.filter((c) => c.specCases >= 0).length,
    flags: {
      controlValueAccessor: flagCount('cva'), dynamicRendering: flagCount('dynamic'), directDom: flagCount('directDom'),
      inheritance: flagCount('inheritance'), animations: flagCount('animations'), ownProviders: flagCount('ownProviders'),
      encapsulationOff: flagCount('encapsulationOff'), shadowDom: flagCount('shadowDom'),
    },
    totals: {
      deps: sum(components, (c) => c.deps), inputs: sum(components, (c) => c.inputs), outputs: sum(components, (c) => c.outputs),
      queries: sum(components, (c) => c.queries), subscribes: sum(components, (c) => c.subscribes), signals: sum(components, (c) => c.signals),
      effects: sum(components, (c) => c.effects), manualChangeDetection: sum(components, (c) => c.manualCd), httpCalls: sum(components, (c) => c.httpCalls), graphqlCalls: sum(components, (c) => c.gqlCalls),
      storeDispatches: sum(components, (c) => c.dispatches), routerNavigations: sum(components, (c) => c.navigations), methods: sum(components, (c) => c.methods),
    },
    top: components.slice(0, 25).map((c) => ({
      name: displayName('component', c), bucket: c.bucket, totalLoc: c.totalLoc, classLoc: c.classLoc, templateLoc: c.tplLoc,
      deps: c.deps, subscribes: c.subscribes, formControls: c.formControls, reasons: c.reasons,
    })),
  },
  directives: { count: countKind('directive'), structural: classes.filter((c) => c.kind === 'directive' && c.detail === 'structural').length, loc: locKind('directive') },
  pipes: { count: countKind('pipe'), impure: classes.filter((c) => c.kind === 'pipe' && c.detail === 'impure').length, loc: locKind('pipe') },
  modules: { count: countKind('module'), loc: locKind('module') },
  injectables: (() => {
    const o = { count: 0, loc: 0, byKind: {}, httpCalls: 0, withSpec: 0 };
    for (const k of injectableKinds) {
      o.byKind[k] = { count: countKind(k), loc: locKind(k) };
      o.count += o.byKind[k].count;
      o.loc += o.byKind[k].loc;
    }
    const inj = classes.filter((c) => injectableKinds.indexOf(c.kind) !== -1);
    o.httpCalls = sum(inj, (c) => c.httpCalls);
    o.withSpec = inj.filter((c) => c.specCases >= 0).length;
    return o;
  })(),
  routing: agg.routing,
  forms: agg.forms,
  state: agg.state,
  templates: {
    controlFlowBlocks: agg.tpl.ctrlFlow, newControlFlowBlocks: agg.tpl.newFlow, interpolations: agg.tpl.interpolations,
    propertyBindings: agg.tpl.propBindings, eventBindings: agg.tpl.eventBindings, twoWayBindings: agg.tpl.twoWay,
    ngContent: agg.tpl.ngContent, ngTemplate: agg.tpl.ngTemplate, templateOutlets: agg.tpl.templateOutlet,
    componentOutlets: agg.tpl.componentOutlet, routerOutlets: agg.tpl.routerOutlet,
    pipes: topN(agg.tpl.pipes, 40), customTagPrefixes: topN(agg.tpl.tagPrefixes, 40), uiAttributePrefixes: topN(agg.tpl.attrPrefixes, 20),
  },
  i18n: agg.i18n,
  graphql: graphql,
  microfrontends: agg.mf,
  frameworkTokensInjected: topN(agg.tokens, 60),
  imports: {
    angularEntryPoints: topN(agg.imports.angular, 200).map((e) => ({ name: e.name, files: e.count })),
    external: externalImports,
    workspaceAliases: topN(agg.imports.workspace, 500).map((e) => ({ name: anonId('alias', e.name), files: e.count })),
    dynamicImports: agg.misc.dynamicImports,
  },
  dependencies: { declared: Object.keys(declaredDeps).length, angularBound: depsAngularBound, tooling: tooling },
  tests: { unit: unit, e2e: e2e, coverage: anon ? coverage.map((c) => Object.assign({}, c, { path: undefined })) : coverage },
  byProject: allProjects.map((p) => {
    const o = Object.assign({}, p, { name: anonId('project', p.name) });
    delete o.root;
    delete o.sourceRoot;
    return o;
  }),
  thresholds: { size: SIZE, coupling: COUPLING, bump: BUMP },
};
{
  const k = summary.injectables.byKind;
  const fn = agg.routing.functional;
  summary.sizing = {
    componentsS: byBucket.S.count, componentsM: byBucket.M.count, componentsL: byBucket.L.count, componentsXL: byBucket.XL.count,
    services: k.service.count,
    guardsInterceptorsResolvers: k.guard.count + k.interceptor.count + k.resolver.count + Object.keys(fn).reduce((a, x) => a + fn[x], 0),
    directives: summary.directives.count, pipes: summary.pipes.count,
    stateSlices: (agg.state.ngrx.createReducer || 0) + (agg.state.ngrx.signalStore || 0) + k.store.count,
    effectsClasses: k.effects.count,
    customFormControls: agg.forms.valueAccessors,
    angularBoundPackages: externalImports.filter((e) => e.angularBound && !CORE_ANGULAR_RE.test(e.name)).length,
    screens: agg.routing.screens,
    testbedCases: unit.testbed.cases,
    e2eCases: e2e.cases + e2e.scenarios,
    graphqlCallSites: graphql.callSites,
  };
}
summary.environment.durationMs = Date.now() - started;

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */
function csv(rows, cols) {
  const esc = (v) => {
    if (v === true) return '1';
    if (v === false) return '0';
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(opts.sep)].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(opts.sep))).join('\n') + '\n';
}
const outComponents = components.map((c) =>
  Object.assign({}, c, {
    project: anonId('project', c.project),
    name: displayName('component', c),
    file: anonId('file', c.file),
    selector: anon ? '' : c.selector,
    specCases: c.specCases < 0 ? '' : c.specCases,
  })
);
const outClasses = classes.map((c) =>
  Object.assign({}, c, {
    project: anonId('project', c.project),
    name: displayName(c.kind, c),
    file: anonId('file', c.file),
    specCases: c.specCases < 0 ? '' : c.specCases,
  })
);
const COMPONENT_COLS = ['project', 'file', 'name', 'selector', 'bucket', 'sizeBucket', 'points', 'reasons', 'routed', 'standalone', 'onPush', 'inlineTemplate', 'totalLoc', 'classLoc', 'tplLoc', 'styleLoc', 'deps', 'inputs', 'outputs', 'queries', 'hostBindings', 'methods', 'hooks', 'subscribes', 'rxPipes', 'signals', 'effects', 'manualCd', 'dispatches', 'navigations', 'httpCalls', 'gqlCalls', 'formControls', 'tplFormBindings', 'ngModel', 'ctrlFlow', 'bindings', 'interpolations', 'childTags', 'ngContent', 'ngTemplate', 'templateOutlet', 'tplPipes', 'cva', 'validator', 'dynamic', 'directDom', 'inheritance', 'animations', 'ownProviders', 'specCases'];
const CLASS_COLS = ['project', 'file', 'kind', 'name', 'loc', 'deps', 'methods', 'subscribes', 'rxPipes', 'httpCalls', 'gqlCalls', 'subjects', 'signals', 'dispatches', 'inputs', 'outputs', 'hostListeners', 'detail', 'specCases'];

function mdTable(headers, rows) {
  const out = ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |'];
  for (const r of rows) out.push('| ' + r.join(' | ') + ' |');
  return out.join('\n');
}

function buildMarkdown(s) {
  const L = [];
  const h = (t) => L.push('', '## ' + t, '');
  const c = s.components;
  L.push('# Angular inventory: ' + s.target);
  L.push('');
  L.push('Generated ' + s.generatedAt.slice(0, 10) + ' by ng-inventory ' + s.version + ' (TypeScript ' + s.environment.typescript + ', Node ' + s.environment.node + ').');
  L.push('Angular: ' + (s.workspace.angularInstalled || s.workspace.angularDeclared || 'unknown') + (s.workspace.nx ? ', Nx workspace' : '') + ', projects: ' + s.workspace.projects.length + '.');
  if (!s.environment.nodeModulesFound) L.push('', '> node_modules was not found: Angular-bound packages were detected by name only.');
  if (s.files.parseErrors) L.push('', '> ' + s.files.parseErrors + ' file(s) could not be analysed and were counted by lines only.');
  if (s.files.templates.missing) L.push('', '> ' + s.files.templates.missing + ' templateUrl reference(s) point to files that were not found; those templates count as 0 LOC.');

  h('Code volume');
  L.push(
    mdTable(
      ['What', 'Files', 'LOC'],
      [
        ['TypeScript (app code, no tests)', fmt(s.files.ts.files), fmt(s.files.ts.loc)],
        ['Generated TypeScript (regenerated, not migrated; excluded from everything below)', fmt(s.files.generatedTs.files), fmt(s.files.generatedTs.loc)],
        ['Templates, external .html', fmt(s.files.templates.externalFiles), fmt(s.files.templates.externalLoc)],
        ['Templates, inline', fmt(s.files.templates.inlineCount), fmt(s.files.templates.inlineLoc)],
        ['Styles', fmt(s.files.styles.files), fmt(s.files.styles.loc)],
        ['Other .html (not a component template)', fmt(s.files.otherHtml.files), fmt(s.files.otherHtml.loc)],
        ['Storybook stories', fmt(s.files.stories.files), fmt(s.files.stories.loc)],
        ['Mocks and test helpers', fmt(s.files.testSupport.files), fmt(s.files.testSupport.loc)],
      ]
    )
  );
  L.push('');
  L.push(
    mdTable(
      ['TypeScript LOC by role', 'LOC', 'Share'],
      [
        ['Component classes', s.tsLocByRole.componentClasses],
        ['Services, guards, interceptors, resolvers, effects, stores', s.tsLocByRole.injectables],
        ['Directives', s.tsLocByRole.directives],
        ['Pipes', s.tsLocByRole.pipes],
        ['NgModules', s.tsLocByRole.modules],
        ['Inline templates and styles inside .ts files', s.tsLocByRole.inlineTemplatesAndStyles],
        ['Everything else (models, utils, routes, store functions, config)', s.tsLocByRole.everythingElse],
      ].map((r) => [r[0], fmt(r[1]), pct(r[1], s.files.ts.loc) + '%'])
    )
  );

  if (s.scope.mode === 'project-folders') {
    L.push('');
    L.push('Application code = the project folders (' + s.scope.folders.map((f) => '`' + f + '`').join(', ') + ')' + (s.scope.filesImportedFromOutside ? ' plus ' + fmt(s.scope.filesImportedFromOutside) + ' file(s) outside them that this code imports' : '') + '.');
    if (s.scope.leftOut.length) {
      L.push('TypeScript that sits next to the application and is not imported by it was left out (mock servers, scripts, unused library code). Count a folder with `--include <folder>`, or everything with `--all`:');
      L.push('');
      L.push(mdTable(['Left out', 'Files', 'Lines'], s.scope.leftOut.map((o) => ['`' + o.folder + '`', fmt(o.files), fmt(o.lines)])));
    }
  } else {
    L.push('');
    L.push('Application code = every .ts file under the scanned folder.');
  }

  h('Portability of TypeScript code');
  L.push(
    mdTable(
      ['Class', 'Files', 'LOC', 'Share of LOC'],
      [
        ['Angular-bound (imports an Angular-only package or declares an Angular class)', fmt(s.portability.angularBound.files), fmt(s.portability.angularBound.loc), s.portability.angularBoundPct + '%'],
        ['RxJS only (runs anywhere, but is not idiomatic React)', fmt(s.portability.rxjsOnly.files), fmt(s.portability.rxjsOnly.loc), s.portability.rxjsOnlyPct + '%'],
        ['Framework-free (no Angular-only or RxJS import)', fmt(s.portability.frameworkFree.files), fmt(s.portability.frameworkFree.loc), s.portability.frameworkFreePct + '%'],
        ['... of which self-contained (moves as is)', fmt(s.portability.frameworkFreeSelfContained.files), fmt(s.portability.frameworkFreeSelfContained.loc), s.portability.frameworkFreeSelfContainedPct + '%'],
      ]
    )
  );

  h('Components: ' + fmt(c.count));
  L.push(
    mdTable(
      ['Bucket', 'Components', 'Share', 'Class LOC', 'Template LOC', 'With a spec file', 'By size alone'],
      BUCKETS.map((b) => [b, fmt(c.byBucket[b].count), pct(c.byBucket[b].count, c.count) + '%', fmt(c.byBucket[b].classLoc), fmt(c.byBucket[b].templateLoc), fmt(c.byBucket[b].withSpec), fmt(c.bySizeOnly[b])])
    )
  );
  L.push('');
  L.push('Size bucket = class LOC + template LOC: S up to ' + s.thresholds.size.S + ', M up to ' + s.thresholds.size.M + ', L up to ' + s.thresholds.size.L + ', XL above. A component moves up one bucket with ' + s.thresholds.bump.one + '+ coupling points and two buckets with ' + s.thresholds.bump.two + '+.');
  const reasonLabels = {
    deps: 'injected dependencies >= ' + s.thresholds.coupling.deps, rx: '.subscribe() calls >= ' + s.thresholds.coupling.subscribes,
    forms: 'form controls or bindings >= ' + s.thresholds.coupling.formControls, queries: 'view/content queries >= ' + s.thresholds.coupling.queries,
    cva: 'ControlValueAccessor', dynamic: 'dynamic rendering (ViewContainerRef, createComponent, ngComponentOutlet)',
    dom: 'direct DOM access (ElementRef, Renderer2, NgZone)', inherit: 'extends a base class',
    projection: 'content projection slots >= ' + s.thresholds.coupling.projection, api: 'inputs + outputs >= ' + s.thresholds.coupling.api,
  };
  L.push('');
  L.push(mdTable(['Coupling point', 'Components'], Object.keys(reasonLabels).map((k) => [reasonLabels[k], fmt(c.bumpReasons[k] || 0)])));
  L.push('');
  L.push(
    mdTable(
      ['Component facts', 'Count'],
      [
        ['Routed (used as a screen in a route)', c.routed], ['Standalone', c.standalone], ['OnPush change detection', c.onPush], ['Inline template', c.inlineTemplate],
        ['With a sibling spec file', c.withSpec], ['Own providers', c.flags.ownProviders], ['Animations', c.flags.animations], ['ViewEncapsulation.None', c.flags.encapsulationOff],
        ['Injected dependencies, total', c.totals.deps], ['Inputs / outputs, total', fmt(c.totals.inputs) + ' / ' + fmt(c.totals.outputs)], ['.subscribe() calls', c.totals.subscribes],
        ['signal()/computed() calls', c.totals.signals], ['Manual change detection calls', c.totals.manualChangeDetection],
        ['HTTP calls made directly from components', c.totals.httpCalls], ['GraphQL calls made directly from components', c.totals.graphqlCalls],
        ['Store dispatches from components', c.totals.storeDispatches],
      ].map((r) => [r[0], typeof r[1] === 'number' ? fmt(r[1]) : r[1]])
    )
  );
  if (c.top.length) {
    L.push('', '### Largest components (estimate these one by one)', '');
    L.push(mdTable(['#', 'Component', 'Bucket', 'LOC', 'Class', 'Template', 'Deps', 'Subscribes', 'Form controls', 'Coupling'], c.top.map((t, i) => [i + 1, t.name, t.bucket, fmt(t.totalLoc), fmt(t.classLoc), fmt(t.templateLoc), t.deps, t.subscribes, t.formControls, t.reasons || '-'])));
  }

  h('Other Angular building blocks');
  const ik = s.injectables.byKind;
  L.push(
    mdTable(
      ['Kind', 'Count', 'LOC'],
      [
        ['Services', ik.service.count, ik.service.loc], ['Guards (classes)', ik.guard.count, ik.guard.loc], ['Interceptors (classes)', ik.interceptor.count, ik.interceptor.loc],
        ['Resolvers (classes)', ik.resolver.count, ik.resolver.loc], ['NgRx effects classes', ik.effects.count, ik.effects.loc], ['Stores and facades', ik.store.count, ik.store.loc],
        ['Directives (structural: ' + s.directives.structural + ')', s.directives.count, s.directives.loc], ['Pipes (impure: ' + s.pipes.impure + ')', s.pipes.count, s.pipes.loc],
        ['NgModules', s.modules.count, s.modules.loc],
      ].map((r) => [r[0], fmt(r[1]), fmt(r[2])])
    )
  );
  L.push('');
  L.push('HTTP calls in injectables: ' + fmt(s.injectables.httpCalls) + '. Injectables with a sibling spec file: ' + fmt(s.injectables.withSpec) + ' of ' + fmt(s.injectables.count) + '.');
  const fn = s.routing.functional;
  if (Object.keys(fn).length) L.push('Functional guards, resolvers and interceptors: ' + Object.keys(fn).map((k) => k + ' ' + fn[k]).join(', ') + '.');

  h('Routing');
  const r = s.routing;
  L.push(
    mdTable(
      ['Metric', 'Count'],
      [
        ['Route definitions', r.routes], ['Screens (routes that render a component)', r.screens], ['Lazy route groups (loadChildren)', r.lazyModules],
        ['Lazy components (loadComponent)', r.lazyComponents], ['Guarded routes', r.guarded], ['Routes with resolvers', r.withResolvers],
        ['Routes with parameters', r.parametrized], ['Redirects', r.redirects], ['Routes with children', r.withChildren],
      ].map((x) => [x[0], fmt(x[1])])
    )
  );

  h('Forms');
  const f = s.forms;
  L.push(
    mdTable(
      ['Metric', 'Count'],
      [
        ['Reactive form controls (in code)', f.controls], ['Form groups and arrays', f.groups], ['Reactive bindings in templates', f.templateBindings],
        ['ngModel usages', f.ngModel], ['Validators.* references', f.validatorRefs], ['Custom form controls (ControlValueAccessor)', f.valueAccessors],
        ['Custom validator classes', f.customValidators],
      ].map((x) => [x[0], fmt(x[1])])
    )
  );

  h('State management');
  const st = s.state;
  const ngrxKeys = Object.keys(st.ngrx).sort();
  L.push(ngrxKeys.length ? 'NgRx calls: ' + ngrxKeys.map((k) => k + ' ' + st.ngrx[k]).join(', ') + '.' : 'No NgRx creator calls found.');
  L.push('Store dispatches from classes that inject Store: ' + fmt(st.storeDispatches) + '. Subjects created (state kept in services): ' + fmt(st.subjects) + '. ComponentStore classes: ' + st.componentStores + '. NGXS: ' + st.ngxsStates + ' states, ' + st.ngxsActions + ' actions, ' + st.ngxsSelectors + ' selectors.');

  const g = s.graphql;
  if (g.files || g.documentsInTs || g.callSites) {
    h('GraphQL');
    L.push(
      mdTable(
        ['Metric', 'Count'],
        [
          ['Call sites in components and services (watchQuery, query, mutate, generated *GQL services)', fmt(g.callSites)],
          ['gql documents inside .ts files', fmt(g.documentsInTs)],
          ['Operations and fragments in those documents', fmt(g.operationsInTs)],
          ['.graphql / .gql files', fmt(g.files)],
          ['Queries / mutations / subscriptions / fragments in those files', [g.operations.query, g.operations.mutation, g.operations.subscription, g.operations.fragment].map(fmt).join(' / ')],
          ['Schema definitions in those files (types, inputs, enums ...)', fmt(g.schemaDefinitions)],
        ]
      )
    );
    L.push('');
    L.push('Documents and schema are framework-neutral and carry over as they are; the call sites are what gets rewritten.');
  }

  h('Templates');
  const t = s.templates;
  L.push(
    mdTable(
      ['Metric', 'Count'],
      [
        ['Control-flow blocks (*ngIf, *ngFor, @if, @for, ...)', t.controlFlowBlocks], ['of which new syntax (@if, @for, ...)', t.newControlFlowBlocks],
        ['Interpolations', t.interpolations], ['Property bindings', t.propertyBindings], ['Event bindings', t.eventBindings], ['Two-way bindings', t.twoWayBindings],
        ['<ng-content> slots', t.ngContent], ['<ng-template> blocks', t.ngTemplate], ['Template outlets', t.templateOutlets], ['Component outlets', t.componentOutlets],
      ].map((x) => [x[0], fmt(x[1])])
    )
  );
  if (t.customTagPrefixes.length) {
    L.push('', 'Custom element tags by prefix (shows which component libraries the templates lean on):', '');
    L.push(mdTable(['Tag prefix', 'Usages'], t.customTagPrefixes.slice(0, 15).map((x) => ['`<' + x.name + '-...>`', fmt(x.count)])));
  }
  if (t.uiAttributePrefixes.length) L.push('', 'UI-library attribute directives by prefix: ' + t.uiAttributePrefixes.map((x) => x.name + ' ' + fmt(x.count)).join(', ') + '.');
  if (t.pipes.length) L.push('', 'Pipes used in templates: ' + t.pipes.slice(0, 20).map((x) => x.name + ' ' + fmt(x.count)).join(', ') + '.');
  L.push('', 'i18n: translate pipe ' + fmt(s.i18n.translatePipe) + ', i18n attributes ' + fmt(s.i18n.i18nAttrs) + ', $localize ' + fmt(s.i18n.localizeCalls) + ', classes injecting a translation service ' + fmt(s.i18n.translateServiceInjections) + '.');

  h('Dependencies tied to Angular');
  const bound = s.imports.external.filter((e) => e.angularBound && !CORE_ANGULAR_RE.test(e.name));
  const free = s.imports.external.filter((e) => !e.angularBound);
  L.push('Declared in package.json: ' + s.dependencies.angularBound.length + ' Angular-bound packages out of ' + s.dependencies.declared + '.');
  if (bound.length) {
    L.push('', 'Angular-bound packages imported in app code, framework core aside (each needs a React counterpart):', '');
    L.push(mdTable(['Package', 'Importing files'], bound.slice(0, 40).map((e) => ['`' + e.name + '`', fmt(e.files)])));
  }
  if (s.imports.angularEntryPoints.length) {
    L.push('', 'Angular entry points:', '');
    L.push(mdTable(['Entry point', 'Importing files'], s.imports.angularEntryPoints.slice(0, 40).map((e) => ['`' + e.name + '`', fmt(e.files)])));
  }
  if (free.length) L.push('', 'Framework-neutral packages (keep working): ' + free.slice(0, 30).map((e) => '`' + e.name + '` ' + e.files).join(', ') + '.');
  if (s.imports.workspaceAliases.length) {
    L.push('', 'Internal libraries imported through tsconfig path aliases:', '');
    L.push(mdTable(['Alias', 'Importing files'], s.imports.workspaceAliases.slice(0, 40).map((e) => ['`' + e.name + '`', fmt(e.files)])));
  }
  if (s.frameworkTokensInjected.length) L.push('', 'Framework services injected (number of classes): ' + s.frameworkTokensInjected.slice(0, 25).map((x) => x.name + ' ' + x.count).join(', ') + '.');

  h('Tests');
  const u = s.tests.unit;
  L.push(
    mdTable(
      ['Unit test files', 'Files', 'Test cases', 'LOC', 'What happens in a migration'],
      [
        ['Use TestBed, Spectator or similar', fmt(u.testbed.files), fmt(u.testbed.cases), fmt(u.testbed.loc), 'rewrite'],
        ['Import Angular but no TestBed', fmt(u.angularNoTestbed.files), fmt(u.angularNoTestbed.cases), fmt(u.angularNoTestbed.loc), 'adapt'],
        ['Framework-free', fmt(u.pure.files), fmt(u.pure.cases), fmt(u.pure.loc), 'keep'],
        ['Total', fmt(u.files), fmt(u.cases), fmt(u.loc), ''],
      ]
    )
  );
  const e = s.tests.e2e;
  L.push('');
  L.push('End-to-end: ' + fmt(e.files) + ' files, ' + fmt(e.cases) + ' test cases' + (Object.keys(e.byFramework).length ? ' (' + Object.keys(e.byFramework).map((k) => k + ': ' + e.byFramework[k].cases).join(', ') + ')' : '') + '; ' + fmt(e.featureFiles) + ' .feature files with ' + fmt(e.scenarios) + ' scenarios.');
  L.push('Components with a sibling spec file: ' + fmt(c.withSpec) + ' of ' + fmt(c.count) + ' (' + pct(c.withSpec, c.count) + '%).');
  const cvPct = (x) => (x === null || x === undefined ? 'n/a' : x + '%');
  for (const cv of s.tests.coverage) L.push('Coverage report' + (cv.path ? ' `' + cv.path + '`' : '') + ': lines ' + cvPct(cv.lines) + ', branches ' + cvPct(cv.branches) + ', functions ' + cvPct(cv.functions) + '.');
  const tl = s.dependencies.tooling;
  const names = (a) => (a.length ? a.map((x) => x.name).join(', ') : 'none found');
  L.push('Tooling in package.json: unit: ' + names(tl.unit) + '; e2e: ' + names(tl.e2e) + '; other: ' + names(tl.other) + '.');

  h('Microfrontends and web components');
  const mf = s.microfrontends;
  L.push('Module Federation configs: ' + mf.configs + ' (exposes ' + mf.exposes + ', remotes ' + mf.remotes + '). loadRemoteModule() calls: ' + mf.loadRemoteModule + '. createCustomElement() calls: ' + mf.createCustomElement + '. Files using CUSTOM_ELEMENTS_SCHEMA: ' + mf.customElementsSchema + '. Dynamic import() calls: ' + s.imports.dynamicImports + '.');

  if (s.byProject.length > 1) {
    h('By project');
    L.push(
      mdTable(
        ['Project', 'Type', 'TS LOC', 'Angular-bound', 'Components', 'S', 'M', 'L', 'XL', 'Template LOC', 'Injectables', 'Routes', 'Screens', 'Unit cases', 'E2E cases'],
        s.byProject.map((p) => [p.name, p.type, fmt(p.tsLoc), pct(p.angularLoc, p.tsLoc) + '%', fmt(p.components), p.buckets.S, p.buckets.M, p.buckets.L, p.buckets.XL, fmt(p.templateLoc), fmt(p.injectables), fmt(p.routes), fmt(p.screens), fmt(p.specCases), fmt(p.e2eCases)])
      )
    );
  }

  h('Sizing sheet');
  L.push('Counts come from this report. Fill in the hours per unit from a pilot migration and multiply.');
  L.push('');
  const z = s.sizing;
  L.push(
    mdTable(
      ['Unit', 'Count', 'Hours per unit', 'Total'],
      [
        ['Component, bucket S', z.componentsS], ['Component, bucket M', z.componentsM], ['Component, bucket L', z.componentsL],
        ['Component, bucket XL (estimate one by one)', z.componentsXL], ['Service', z.services],
        ['Guard, interceptor, resolver (class or function)', z.guardsInterceptorsResolvers], ['Directive', z.directives], ['Pipe', z.pipes],
        ['State slice (reducer or store class)', z.stateSlices], ['Effects class', z.effectsClasses],
        ['Custom form control (ControlValueAccessor)', z.customFormControls], ['Angular-bound package to replace', z.angularBoundPackages],
        ['GraphQL call site to rewire (the documents carry over as they are)', z.graphqlCallSites],
        ['Screen to verify end to end', z.screens], ['TestBed-based test case to rewrite', z.testbedCases], ['E2E test case or scenario to re-run and fix', z.e2eCases],
      ].map((x) => [x[0], fmt(x[1]), '', ''])
    )
  );
  L.push('');
  L.push('Not in this sheet, because it does not scale with code: target architecture, app shell, auth, HTTP layer, design system, CI, team ramp-up and release overhead.');

  h('How to read this');
  L.push('- LOC means lines holding code: blank lines and comments are not counted in TypeScript, blank lines are not counted in templates and styles.');
  L.push('- Buckets are a heuristic. Every raw number is in components.csv, so the buckets can be recomputed with other thresholds (top of the script, or --xl).');
  L.push('- Template numbers come from regular expressions and are approximate.');
  L.push('- "Framework-free" looks at the direct imports of a file. "Self-contained" also requires that no chain of local imports (type imports included) leads to Angular-bound code, so it is the conservative figure.');
  L.push('- A file counts as generated when its leading comment says so (auto-generated, do not edit, OpenAPI Generator and similar), when it sits in a `generated` folder or is named `*.generated.ts`, or when it looks like graphql-codegen output.');
  L.push('- End-to-end tests are found in folders named like e2e, e2e-playwright, app-e2e, cypress or playwright, wherever they are.');
  L.push('- Every .ts file under the scanned folder is counted. Backend TypeScript in the same repo shows up as framework-free code, so scan the frontend folders or read the per-project table.');
  L.push('- Route, guard and store numbers are syntactic matches, so unusual code styles can be under-counted.');
  L.push('- Tests are counted by `it(...)` / `test(...)` calls; a parameterised test counts once.');
  return L.join('\n') + '\n';
}

fs.mkdirSync(opts.out, { recursive: true });
fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(opts.out, 'summary.md'), buildMarkdown(summary));
fs.writeFileSync(path.join(opts.out, 'components.csv'), csv(outComponents, COMPONENT_COLS));
fs.writeFileSync(path.join(opts.out, 'classes.csv'), csv(outClasses, CLASS_COLS));

if (!opts.quiet) {
  const c = summary.components;
  const ik = summary.injectables.byKind;
  const u = summary.tests.unit;
  console.log(
    [
      'ng-inventory ' + VERSION + ': ' + summary.target,
      'Angular ' + (summary.workspace.angularInstalled || summary.workspace.angularDeclared || 'unknown') + ', TypeScript ' + ts.version + ', projects: ' + summary.workspace.projects.length,
      'TypeScript: ' + fmt(agg.ts.files) + ' files, ' + fmt(agg.ts.loc) + ' LOC; templates: ' + fmt(c.loc.template) + ' LOC; styles: ' + fmt(styles.loc) + ' LOC',
      'Components: ' + fmt(c.count) + ' (S ' + c.byBucket.S.count + ', M ' + c.byBucket.M.count + ', L ' + c.byBucket.L.count + ', XL ' + c.byBucket.XL.count + ')',
      'Services ' + ik.service.count + ', guards ' + ik.guard.count + ', interceptors ' + ik.interceptor.count + ', resolvers ' + ik.resolver.count + ', effects ' + ik.effects.count + ', stores ' + ik.store.count + ', directives ' + summary.directives.count + ', pipes ' + summary.pipes.count + ', modules ' + summary.modules.count,
      'Routes: ' + agg.routing.routes + ' (screens ' + agg.routing.screens + ', lazy ' + (agg.routing.lazyModules + agg.routing.lazyComponents) + ', guarded ' + agg.routing.guarded + ')',
      'TypeScript LOC: Angular-bound ' + summary.portability.angularBoundPct + '%, RxJS only ' + summary.portability.rxjsOnlyPct + '%, framework-free ' + summary.portability.frameworkFreePct + '% (self-contained ' + summary.portability.frameworkFreeSelfContainedPct + '%)',
      agg.generated.files ? 'Generated TypeScript left out: ' + fmt(agg.generated.files) + ' files, ' + fmt(agg.generated.loc) + ' LOC' : '',
      scope.mode === 'project-folders'
        ? 'Counted as application code: ' + scope.roots.join(', ') + (scope.importedFromOutside ? ' + ' + fmt(scope.importedFromOutside) + ' imported file(s) outside these folders' : '')
        : 'Counted as application code: every .ts file under the scanned folder',
      scope.leftOut.length
        ? 'Left out (not imported by the app; add with --include <folder>, or use --all): ' + scope.leftOut.slice(0, 8).map((o) => o.folder + ' ' + fmt(o.files) + ' files').join(', ') + (scope.leftOut.length > 8 ? ', ...' : '')
        : '',
      'Unit tests: ' + fmt(u.files) + ' files, ' + fmt(u.cases) + ' cases (TestBed-based ' + pct(u.testbed.cases, u.cases) + '%); e2e: ' + fmt(e2e.files) + ' files, ' + fmt(e2e.cases) + ' cases, ' + fmt(e2e.scenarios) + ' scenarios',
      agg.misc.parseErrors ? 'Files that could not be analysed: ' + agg.misc.parseErrors : '',
      'Report written to ' + opts.out + ' in ' + (summary.environment.durationMs / 1000).toFixed(1) + 's',
    ]
      .filter(Boolean)
      .join('\n')
  );
}
