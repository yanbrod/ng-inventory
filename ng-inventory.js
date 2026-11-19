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
 * Tests
 *   Unit tests: coverage reports found in `coverage` folders (lcov.info,
 *   coverage-final.json, coverage-summary.json or the Istanbul HTML report) are
 *   read per file and matched to components and services. Nothing is run: the
 *   report has to exist already (ng test --code-coverage, jest --coverage).
 *   End-to-end tests (Cypress, Playwright, Protractor, Gherkin) are read as
 *   text: test titles, the URLs they open or assert, the test ids and selectors
 *   they use. That is matched against the routes and templates of the app.
 *   Test ids are the usual attributes (data-testid, data-cy, data-test ...) plus
 *   any attribute of the project's own that the tests select by. Element ids,
 *   names and form control names count as well.
 *   It is a static trace, so it shows less than a real run does; a coverage
 *   report from an instrumented e2e run can be added with --e2e-coverage.
 *
 * Usage
 *   node ng-inventory.js [path] [--out <dir>] [--xl <n>] [--include <a,b>] [--all]
 *                        [--coverage <path>] [--e2e-coverage <path>]
 *                        [--anonymize] [--semicolon] [--ts <path>] [--quiet]
 *   node ng-inventory.js --merge <summary.json> <summary.json> ... [--out <dir>]
 *
 * Output (./ng-inventory-report by default)
 *   summary.md          human-readable report, ends with a sizing sheet
 *   summary.json        the same numbers, machine-readable (the file to send back)
 *   components.csv      one row per component: raw metrics, bucket, reasons,
 *                       unit coverage and e2e trace
 *   classes.csv         one row per service, guard, interceptor, resolver,
 *                       directive, pipe and module
 *   test-gaps.md        what the tests cover and what they miss
 *   functional-spec.md  what the application does, in the words of its e2e
 *                       tests (not written with --anonymize)
 *   routes.csv          every route with its full path and its e2e trace
 *   e2e-tests.csv       every e2e test: suite, title, status, steps, checks
 *   operations.csv      named GraphQL operations and whether e2e code names them
 *
 *   --merge writes portfolio.md and portfolio.csv: one row per application
 *   plus a total, built from the summary.json files of several runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '1.2.0';

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
const UNIT_OK_PCT = 50; // line coverage from unit tests at or above this counts as "has unit tests" in the gap tables
const SHARED_MAX = 3; // an e2e trace that points at more candidates than this (components with the same test id, hosts of the same child) is ignored

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
const COVERAGE_DIR_RE = /^coverage([-_.]|$)|[-_.]coverage$/i;
const TEST_ID_ATTRS = 'data-test[\\w-]*|data-qa[\\w-]*|data-cy|data-e2e[\\w-]*|data-automation[\\w-]*|data-hook|data-pw|data-aid|data-sel'; // data-testid, data-test-id, data-testing-id, data-qa, data-cy, ...
let TEST_ID_RE; // a test id in a template: data-testid="x", [attr.data-testid]="'x'"
let TEST_ID_SEL_END_RE; // a test id that the test code puts together: `[data-cy="${entity}DetailsHeading"]`, getByTestId(`row-${kind}`)
/** The e2e code may select by an attribute of its own (automation-id, e2e-id ...): those names are added before the templates are read. */
function setTestIdAttrs(extra) {
  const names = TEST_ID_ATTRS + extra.map((a) => '|' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  TEST_ID_RE = new RegExp('(?:^|[\\s"\'])(' + names + ')\\s*=\\s*(["\'])([^"\'{}]+)\\2|\\[attr\\.(' + names + ')\\]\\s*=\\s*"\\s*\'([^\'"{}]+)\'\\s*"', 'gi');
  TEST_ID_SEL_END_RE = new RegExp('(?:' + names + ')\\s*[~|^$*]?=\\s*["\']?$', 'i');
}
setTestIdAttrs([]);
// other handles a test can take hold of: an element id, a form control name, a name attribute
const HOOK_RE = /(?:^|[\s"'])(id|name|formControlName)\s*=\s*(["'])([^"'{}\s]+)\2/g;
const HOOK_KIND = { id: 'id', name: 'name', formcontrolname: 'fc' };
const TEXT_LOOKUP_RE = /^(getBy|getAllBy|findBy|findAllBy|queryBy|queryAllBy)(Role|Text|Label|LabelText|Placeholder|PlaceholderText|Title|AltText|DisplayValue)$/;
const TEST_ID_HELPER_RE = /test_?id|by_?cy|data_?cy|by_?qa|data_?qa|data_?test|by_?sel|get_?sel|by_?data|automation_?id|by_?e2e|by_?hook/i;
const E2E_SUITE_RE = /^(describe|context|suite|fdescribe|xdescribe|test\.describe)(\.(only|skip|fixme|serial|parallel))*$/;
const E2E_TEST_RE = /^(it|test|specify|fit|xit|xspecify)(\.(only|skip|fixme|fail|failing|concurrent|slow|todo))*$/;
const STEP_DEF_RE = /^(Given|When|Then|And|But|defineStep)$/;
const E2E_ACTIONS = new Set(['click', 'dblclick', 'rightclick', 'type', 'clear', 'check', 'uncheck', 'select', 'selectOption', 'selectFile', 'setInputFiles', 'fill', 'press', 'pressSequentially', 'hover', 'tap', 'dragTo', 'drag', 'trigger', 'focus', 'blur', 'submit', 'sendKeys', 'dispatchEvent', 'scrollIntoView', 'scrollTo']);
const E2E_CHECKS = new Set(['should', 'contains', 'waitForURL', 'waitForSelector', 'waitFor', 'waitForResponse', 'waitForRequest']);

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
      '  --coverage <p> Unit-test coverage report to read (lcov.info, coverage-final.json, coverage-summary.json',
      '                 or a folder with one); coverage folders inside the path are found without it',
      '  --e2e-coverage <p> The same for a coverage report produced by an instrumented end-to-end run',
      '  --anonymize    Replace file paths, class names, selectors and project names with ids; test titles,',
      '                 URLs and operation names are left out',
      '  --semicolon    Write CSV files with ; as the separator (Excel with German or other European settings)',
      '  --ts <path>    Path to a typescript package (default: resolved from the scanned project)',
      '  --quiet        Do not print the summary to the console',
      '  -h, --help     Show this help',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const o = { root: null, out: null, xl: SIZE.L, anonymize: false, ts: null, quiet: false, merge: null, sep: ',', include: [], all: false, coverage: [], e2eCoverage: [] };
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
    else if (a === '--coverage') o.coverage = o.coverage.concat(String(argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--e2e-coverage') o.e2eCoverage = o.e2eCoverage.concat(String(argv[++i] || '').split(',').filter(Boolean));
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
    // test safety net (reports written by version 1.2 or later)
    const tg = s.testGaps;
    const uc = tg && tg.unitCoverage.reportFound ? tg.unitCoverage : null;
    row.unitLinesHit = uc ? uc.lines.hit : 0;
    row.unitLinesAll = uc ? uc.lines.found + uc.absentFromReport.estimatedLines : 0;
    row.screensTraced = tg ? tg.e2e.screens.total - tg.e2e.screens.noTrace - (tg.e2e.screens.undecided || 0) : 0;
    row.screensListed = tg ? tg.e2e.screens.total : 0;
    row.componentsNoTests = tg ? ['S', 'M', 'L', 'XL'].reduce((a, b) => a + tg.matrix[b].neither, 0) : 0;
    row.largeNoTests = tg ? tg.matrix.L.neither + tg.matrix.XL.neither : 0;
    row.noTestAnalysis = tg ? 0 : 1;
    row.noCoverageReport = uc ? 0 : 1;
    rows.push(row);
  }
  const total = { app: 'TOTAL', angular: '' };
  for (const k of Object.keys(rows[0])) if (k !== 'app' && k !== 'angular') total[k] = rows.reduce((a, r) => a + r[k], 0);
  // a summary from before 1.2 says nothing about tests: leave its cells empty instead of showing a zero
  const older = rows.filter((r) => r.noTestAnalysis).map((r) => r.app);
  for (const r of rows) if (r.noTestAnalysis) r.componentsNoTests = r.largeNoTests = '';
  if (older.length === rows.length) total.componentsNoTests = total.largeNoTests = '';
  const all = rows.concat(rows.length > 1 ? [total] : []);
  for (const r of all) {
    r.angularBoundPct = share(r.angularBoundLoc, r.tsLoc);
    r.selfContainedPct = share(r.selfContainedLoc, r.tsLoc);
    // a total over the applications that happen to have a report would pass for the coverage of all of them
    r.unitLinePct = r.unitLinesAll && !(r === total && total.noCoverageReport) ? share(r.unitLinesHit, r.unitLinesAll) : '';
    r.screensTracedPct = r.screensListed ? share(r.screensTraced, r.screensListed) : '';
  }
  const cols = ['app', 'angular', 'tsLoc', 'templateLoc', 'angularBoundPct', 'selfContainedPct', 'components'].concat(SIZING.slice(0, 4), ['routes', 'unitCases'], SIZING.slice(4), ['unitLinePct', 'screensTracedPct', 'componentsNoTests', 'largeNoTests']);
  const head = ['App', 'Angular', 'TS LOC', 'Template LOC', 'Angular-bound %', 'Self-contained %', 'Components', 'S', 'M', 'L', 'XL', 'Routes', 'Unit cases', 'Services', 'Guards, interceptors, resolvers', 'Directives', 'Pipes', 'State slices', 'Effects classes', 'Custom form controls', 'Angular-bound packages', 'Screens', 'TestBed cases', 'E2E cases', 'GraphQL call sites', 'Unit line coverage % (all app code)', 'Screens with e2e trace %', 'Components with no tests', 'of which L and XL'];
  const md =
    '# Angular portfolio inventory\n\n' +
    mdTable(head, all.map((r) => cols.map((c) => (typeof r[c] === 'number' ? num(r[c]) : r[c])))) +
    '\n\nAngular-bound packages are counted per application, so the total counts a shared package once per application that uses it.\n' +
    'Unit line coverage is empty where no coverage report was found, and in the total unless every application has one; it counts application files that the report leaves out as uncovered. The e2e trace is static, see test-gaps.md of each application.\n' +
    (older.length ? 'No test analysis for ' + older.join(', ') + ': the summary was written by a version before 1.2, so the last four columns are empty there and the totals leave it out. Run the current script on it again.\n' : '');
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
const topN = (obj, n) =>
  Object.keys(obj)
    .map((k) => ({ name: k, count: obj[k] }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, n);
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
const depsOf = (j) => Object.assign({}, j.peerDependencies, j.devDependencies, j.dependencies);
// One app of a monorepo has a thin package.json of its own; the dependencies sit in the one at the repository root.
// Those above are read up to the folder that holds .git, and not at all when no such folder is found.
const outerDeps = {};
if (pkgJsonPath) {
  const outer = [];
  let d = path.dirname(pkgJsonPath);
  let atRepoRoot = fs.existsSync(path.join(d, '.git'));
  for (let i = 0; i < 8 && !atRepoRoot && path.dirname(d) !== d; i++) {
    d = path.dirname(d);
    const j = fs.existsSync(path.join(d, 'package.json')) ? readJsonLoose(path.join(d, 'package.json')) : null;
    if (j) outer.unshift(j);
    atRepoRoot = fs.existsSync(path.join(d, '.git'));
  }
  if (atRepoRoot) for (const j of outer) Object.assign(outerDeps, depsOf(j));
}
const declaredDeps = Object.assign({}, outerDeps, depsOf(pkgJson));

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
const coverageDirs = []; // folders that hold coverage reports: not walked for code, read later
/** A folder called "coverage" is a report folder only when a report is in it; otherwise it is ordinary source. */
function holdsCoverageReport(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && /^(lcov\.info|coverage-final\.json|coverage-summary\.json|clover\.xml|cobertura-coverage\.xml|index\.html)$/.test(e.name)) return true;
    if (e.isDirectory() && e.name === 'lcov-report') return true;
  }
  if (depth < 2) for (const e of entries) if (e.isDirectory() && holdsCoverageReport(path.join(dir, e.name), depth + 1)) return true;
  return false;
}
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
      if (COVERAGE_DIR_RE.test(e.name) && full !== opts.out && holdsCoverageReport(full, 0)) {
        coverageDirs.push(full);
        continue;
      }
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
  // sourceRoot is written from the workspace root, and that may sit above the scanned folder (one app of a monorepo):
  // "apps/web/src" in apps/web/project.json is the folder src next to it
  let src = normDir(j.sourceRoot);
  if (src && !isDir(path.join(ROOT, src))) {
    const here = toPosix(path.dirname(abs)).split('/');
    const segs = src.split('/');
    let fixed = '';
    for (let k = segs.length - 1; k >= 1 && !fixed; k--) {
      const rest = segs.slice(k).join('/');
      if (segs.slice(0, k).join('/') === here.slice(-k).join('/') && isDir(path.join(path.dirname(abs), rest))) fixed = (root ? root + '/' : '') + rest;
    }
    src = fixed;
  }
  addProject(j.name || (root ? path.posix.basename(root) : path.basename(ROOT)), j.projectType, root, src);
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
let inAppFolders = (_abs) => true;
{
  // a project folder that is not there (a stale entry, or paths written from a workspace root above the scanned folder) cannot
  // define the scope: with none left, every file counts
  const roots = projects
    .filter((p) => p.type !== 'e2e')
    .map((p) => p.root || p.sourceRoot)
    .filter((r) => r === '' || isDir(path.join(ROOT, r)));
  if (!opts.all && roots.length && roots.every((r) => r !== '')) {
    scope.mode = 'project-folders';
    scope.roots = Array.from(new Set(roots.concat(opts.include.map(normDir).filter(Boolean)))).sort();
    const under = (abs) => {
      const rel = relOf(abs);
      return scope.roots.some((r) => rel === r || rel.startsWith(r + '/'));
    };
    inAppFolders = under;
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
function isStr(node) {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}
function isExprWrapper(node) {
  return (
    ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) ||
    (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(node))
  );
}
/** `x as T`, `(x)`, `x!`, `x satisfies T` -> x */
function unwrapExpr(node) {
  while (node && isExprWrapper(node)) node = node.expression;
  return node;
}
/** a.b.c or this.a.b as text; null for anything that is not a plain dotted name */
function dottedName(expr) {
  const parts = [];
  let e = expr;
  while (ts.isPropertyAccessExpression(e)) {
    parts.unshift(e.name.text);
    e = e.expression;
  }
  if (ts.isIdentifier(e)) parts.unshift(e.text);
  else if (e.kind === SK.ThisKeyword) parts.unshift('this');
  else return null;
  return parts.join('.');
}
function lastFunctionArg(args) {
  for (let i = args.length - 1; i >= 0; i--) if (ts.isArrowFunction(args[i]) || ts.isFunctionExpression(args[i])) return args[i];
  return null;
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
const fileRecs = new Map(); // absolute path -> { port, loc, deps, runtime }
const routeArrays = new Map(); // file -> Map(array name -> { file, key, nodes, spreads, refConsumed, lazyConsumed, registered })
const routerSetups = []; // { file, name }: provideRouter(routes), RouterModule.forRoot(routes), RouterModule.forChild(routes)
const bootstrapNames = new Set(); // root components: bootstrapApplication(X), @NgModule({ bootstrap: [X] })
const testIdAttrUse = {}; // test id attribute -> how often templates carry it
const staticRefs = new Map(); // 'PageModule.component' -> 'PageComponent': static class fields that hold a class, for `component: PageModule.component`
const routedExprs = new Set(); // route components written as `A.b`, resolved once every file is read
const ROUTER_SETUP_RE = /^(provideRouter|provideRoutes)$|(^|\.)RouterModule\.(forRoot|forChild)$/;
const fileImports = new Map(); // file with routes -> Map(local name -> { spec, name })
let routeAst = new Map(); // route object literal -> route node, for the file being read
const appConsts = new Map(); // 'Routes.Payments' -> 'payments': top-level string constants, for route paths written as constants
const gqlOps = new Map(); // 'query Payments' -> { type, name, file }
const gqlAnonymous = { count: 0 };
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
    pipes: {}, pipeCount: 0, tags: {}, tagPrefixes: {}, attrPrefixes: {}, testIds: [], testIdAttrs: {}, hooks: [],
  };
  let m;
  if (tpl.indexOf('=') !== -1) {
    const ids = new Set();
    TEST_ID_RE.lastIndex = 0;
    while ((m = TEST_ID_RE.exec(tpl))) {
      const id = (m[3] || m[5] || '').trim();
      if (!id) continue;
      ids.add(id);
      bump(t.testIdAttrs, (m[1] || m[4]).toLowerCase());
    }
    t.testIds = Array.from(ids);
    const hooks = new Set();
    HOOK_RE.lastIndex = 0;
    while ((m = HOOK_RE.exec(tpl))) hooks.add(HOOK_KIND[m[1].toLowerCase()] + '=' + m[3]);
    t.hooks = Array.from(hooks);
  }
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
    refs: new Set(), // capitalised identifiers used in the class: other components it opens, creates or lists
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
    } else if (ts.isIdentifier(n)) {
      const first = n.text.charCodeAt(0);
      if (first >= 65 && first <= 90) ci.refs.add(n.text);
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
  else if (comp && ts.isPropertyAssignment(comp) && dottedName(unwrapExpr(comp.initializer))) routedExprs.add(dottedName(unwrapExpr(comp.initializer)));
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

  // --- the route tree is kept, so that full paths can be put together once every file is read
  const init = (k) => {
    const p = keys.get(k);
    return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
  };
  const IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/;
  const THEN_RE = /\.then\(\s*\(?\s*[\w$]+\s*\)?\s*=>\s*[\w$]+\s*\.\s*([A-Za-z_$][\w$]*)/;
  const pathInit = unwrapExpr(init('path'));
  const node = {
    file: abs, project: proj.name,
    path: isStr(pathInit) ? pathInit.text : '', pathExpr: pathInit && !isStr(pathInit) ? pathInit.getText(sf) : undefined,
    component: '', componentFile: null, lazyComponent: false, lazy: null, remote: false,
    isRedirect: keys.has('redirectTo'), redirectTo: isStr(unwrapExpr(init('redirectTo'))) ? unwrapExpr(init('redirectTo')).text : undefined,
    redirectExpr: init('redirectTo') && !isStr(unwrapExpr(init('redirectTo'))) ? unwrapExpr(init('redirectTo')).getText(sf) : undefined,
    guarded: GUARD_KEYS.some((k) => keys.has(k)), children: [], childRefs: [], segs: null, refArrays: [], lazyArrays: [],
    outlet: keys.has('outlet'), // a secondary outlet (a navbar, a side panel): shown next to a screen, not a screen itself
  };
  if (comp && ts.isPropertyAssignment(comp)) {
    // a class name, a static field that holds one (`PageModule.component`), or something only known at run time: a screen in any case
    const ce = unwrapExpr(comp.initializer);
    node.component = ts.isIdentifier(ce) ? ce.text : dottedName(ce) || '(set at run time)';
  }
  if (lc && ts.isPropertyAssignment(lc)) {
    const text = lc.initializer.getText(sf);
    const im = IMPORT_RE.exec(text);
    const m = THEN_RE.exec(text);
    node.lazyComponent = true;
    node.component = m ? m[1] : '';
    node.componentFile = im ? resolveSpec(im[1], abs) : null;
  }
  const lz = unwrapExpr(init('loadChildren'));
  if (lz) {
    const text = lz.getText(sf);
    let spec = null;
    let name = 'default';
    if (isStr(lz)) {
      // Angular 7 and older: './feature/feature.module#FeatureModule'
      const parts = lz.text.split('#');
      spec = parts[0];
      name = parts[1] || 'default';
    } else {
      const im = IMPORT_RE.exec(text);
      const m = THEN_RE.exec(text);
      if (im) spec = im[1];
      if (m) name = m[1];
      const ref = /^(?:async\s*)?\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*$/.exec(text);
      if (!im && ref) node.childRefs.push(ref[1]);
    }
    node.remote = /loadRemoteModule|loadRemote\s*\(|remoteEntry/.test(text);
    node.lazy = { spec: spec, name: name, file: spec ? resolveSpec(spec, abs) : null };
  }
  const ch = unwrapExpr(init('children'));
  if (ch) {
    if (ts.isIdentifier(ch)) node.childRefs.push(ch.text);
    else if (ts.isArrayLiteralExpression(ch)) for (const el of ch.elements) if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) node.childRefs.push(el.expression.text);
  }
  routeAst.set(obj, node);
  const arr = obj.parent && ts.isArrayLiteralExpression(obj.parent) ? obj.parent : null;
  let holder = arr ? arr.parent : null;
  while (holder && isExprWrapper(holder)) holder = holder.parent;
  const parentNode = holder && ts.isPropertyAssignment(holder) && propName(holder) === 'children' ? routeAst.get(holder.parent) : null;
  if (parentNode) parentNode.children.push(node);
  else routeArrayOf(arr, holder, obj, abs, sf).nodes.push(node);
}

/** The array a top-level route sits in, by the name it can be referred to (variable, `default`, or its position). */
function routeArrayOf(arr, holder, obj, abs, sf) {
  let key = '@' + (arr || obj).pos;
  if (arr && holder) {
    if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) key = holder.name.text;
    else if (ts.isExportAssignment(holder)) key = 'default';
    else if (ts.isPropertyDeclaration(holder) && holder.name) key = holder.name.getText(sf);
  }
  let byKey = routeArrays.get(abs);
  if (!byKey) routeArrays.set(abs, (byKey = new Map()));
  let rec = byKey.get(key);
  if (!rec) {
    // an array written straight into provideRouter([...]) or RouterModule.forRoot([...]) is in use by definition
    const inline = !!holder && ts.isCallExpression(holder) && ROUTER_SETUP_RE.test(dottedName(holder.expression) || '');
    rec = { file: abs, key: key, nodes: [], spreads: [], refConsumed: false, lazyConsumed: false, registered: inline };
    if (arr) for (const el of arr.elements) if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) rec.spreads.push(el.expression.text);
    byKey.set(key, rec);
  }
  return rec;
}

/** Top-level string constants (const, enum, static field, one object level deep): route paths are often written with them. */
function collectAppConsts(sf) {
  const add = (k, v) => {
    if (v.length > 200) return;
    const prev = appConsts.get(k);
    if (prev === undefined) appConsts.set(k, v);
    else if (prev !== v) appConsts.set(k, null);
  };
  const fromObject = (prefix, o, depth) => {
    for (const p of o.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = propName(p);
      const v = unwrapExpr(p.initializer);
      if (!k || !v) continue;
      if (isStr(v)) add(prefix + '.' + k, v.text);
      else if (ts.isObjectLiteralExpression(v) && depth < 2) fromObject(prefix + '.' + k, v, depth + 1);
    }
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const v = unwrapExpr(d.initializer);
        if (!v || !ts.isIdentifier(d.name)) continue;
        if (isStr(v)) add(d.name.text, v.text);
        else if (ts.isObjectLiteralExpression(v)) fromObject(d.name.text, v, 0);
      }
    } else if (ts.isEnumDeclaration(st)) {
      for (const m of st.members) if (isStr(m.initializer) && propName(m)) add(st.name.text + '.' + propName(m), m.initializer.text);
    } else if (ts.isClassDeclaration(st) && st.name) {
      for (const m of st.members) {
        if (!ts.isPropertyDeclaration(m) || !propName(m)) continue;
        const v = unwrapExpr(m.initializer);
        if (isStr(v)) add(st.name.text + '.' + propName(m), v.text);
      }
    }
  }
}

/** 'Routes.Payments' or `${BASE}/list` -> the string it stands for, when every part is a known constant. */
function resolveConstText(text) {
  const t = String(text).trim().replace(/^this\./, '');
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t)) {
    const v = appConsts.get(t);
    return typeof v === 'string' ? v : undefined;
  }
  if (t.charAt(0) === '`' && t.charAt(t.length - 1) === '`') {
    let ok = true;
    const s = t.slice(1, -1).replace(/\$\{([^}]+)\}/g, (_all, inner) => {
      const v = resolveConstText(inner);
      if (v === undefined) ok = false;
      return v || '';
    });
    return ok ? s : undefined;
  }
  return undefined;
}

function hasRuntimeCode(sf) {
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isImportEqualsDeclaration(st) || st.kind === SK.EmptyStatement) continue;
    if (st.modifiers && st.modifiers.some((m) => m.kind === SK.DeclareKeyword)) continue;
    return true;
  }
  return false;
}

function collectGqlOps(text, abs) {
  const re = /(?:^|[\s`}])(query|mutation|subscription)\b\s*([A-Za-z_]\w*)?\s*[({@]/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) gqlAnonymous.count++;
    else if (!gqlOps.has(m[1] + ' ' + m[2])) gqlOps.set(m[1] + ' ' + m[2], { type: m[1], name: m[2], file: abs });
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
        else if (t === 'bootstrapApplication' && n.arguments.length && ts.isIdentifier(n.arguments[0])) bootstrapNames.add(n.arguments[0].text);
      }
      if (importsRouter && n.arguments.length && (ts.isIdentifier(c) || ts.isPropertyAccessExpression(c)) && ROUTER_SETUP_RE.test(dottedName(c) || '')) {
        const arg = unwrapExpr(n.arguments[0]);
        if (ts.isIdentifier(arg)) routerSetups.push({ file: abs, name: arg.text });
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
        collectGqlOps(n.template.getText(sf), abs);
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
  const bindings = new Map(); // local name -> { spec, name of the export }
  for (const st of sf.statements) {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const named = ts.isImportDeclaration(st) && st.importClause && st.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        importedFrom.set(el.name.text, spec);
        bindings.set(el.name.text, { spec: spec, name: (el.propertyName || el.name).text });
      }
    }
    if (ts.isImportDeclaration(st) && st.importClause && st.importClause.name) bindings.set(st.importClause.name.text, { spec: spec, name: 'default' });
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
    if (cls.name) {
      for (const m of cls.members) {
        if (!ts.isPropertyDeclaration(m) || !propName(m) || !(m.modifiers || []).some((x) => x.kind === SK.StaticKeyword)) continue;
        const v = unwrapExpr(m.initializer);
        if (!v || !ts.isIdentifier(v)) continue;
        const key = cls.name.text + '.' + propName(m);
        staticRefs.set(key, staticRefs.has(key) && staticRefs.get(key) !== v.text ? null : v.text);
      }
    }
    let kind = null;
    let meta;
    let isNgxsState = false;
    let viaService = false;
    for (const d of decoratorsOf(cls)) {
      let n = decoratorName(d);
      const from = importedFrom.get(n);
      // Angular 22.1: @Service() stands for @Injectable({ providedIn: 'root' }). Other libraries have a @Service too, so the import decides.
      const ngService = n === 'Service' && from === '@angular/core';
      if (ngService) n = 'Injectable';
      if (KIND_RANK[n] === undefined) continue;
      // same decorator names exist elsewhere (NestJS @Injectable, Stencil @Component): trust the import
      if (n === 'State' ? from !== '@ngxs/store' : from !== undefined && !/^@angular\//.test(from)) continue;
      if (n === 'State') isNgxsState = true;
      if (kind === null || KIND_RANK[n] < KIND_RANK[kind]) {
        kind = n;
        meta = decoratorArg(d);
        viaService = ngService;
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
        // kept for the test analysis, not written to the CSV as they are
        tagList: Object.keys(t.tags), testIdList: t.testIds, hookList: t.hooks, refs: ci.refs,
      };
      Object.assign(c, bucketOf(c));
      c.totalLoc = c.classLoc + c.tplLoc;
      components.push(c);
      for (const a of Object.keys(t.testIdAttrs)) bump(testIdAttrUse, a, t.testIdAttrs[a]);
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
        detail: '', specCases: -1, abs: abs,
        refs: ci.refs, // kept for the test analysis: a service or directive that names a component may open or create it
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
        const boot = get('bootstrap');
        if (boot && ts.isArrayLiteralExpression(boot)) for (const el of boot.elements) if (ts.isIdentifier(el)) bootstrapNames.add(el.text);
        proj.modules++;
      } else {
        rec.kind = injectableKind(ci, relLower, isNgxsState);
        const prov = get('providedIn');
        const auto = get('autoProvided');
        if (viaService) rec.detail = auto && auto.kind === SK.FalseKeyword ? 'autoProvided=false' : 'providedIn=root';
        else rec.detail = prov ? 'providedIn=' + (strValue(prov) || prov.getText(sf)) : '';
        if (isNgxsState) agg.state.ngxsStates++;
        if (/^ComponentStore/.test(ci.extendsName)) agg.state.componentStores++;
        proj.injectables++;
      }
      classes.push(rec);
    }
  }

  routeAst = new Map();
  walkFile(sf, importsRouter, proj, abs);
  routeAst = new Map();
  if (importsRouter) fileImports.set(abs, bindings);
  collectAppConsts(sf);

  const port = bound ? 'angular' : rx ? 'rxjs' : 'free';
  fileRecs.set(abs, { port: port, loc: loc, deps: localDeps, runtime: hasRuntimeCode(sf) });
  agg.ts.files++;
  agg.ts.loc += loc;
  agg.port[port].files++;
  agg.port[port].loc += loc;
  proj.tsFiles++;
  proj.tsLoc += loc;
  proj[port + 'Loc'] += loc;
}

/* ------------------------------------------------------------------ *
 * Before the templates are read: which attributes does the e2e code select by?
 * A project may have a test id attribute of its own (automation-id, e2e-id, data-anything). One that the tests use
 * with three different values or more is taken as a test id attribute, next to the usual names.
 * ------------------------------------------------------------------ */
const extraTestIdAttrs = [];
{
  const use = new Map();
  const known = new RegExp('^(?:' + TEST_ID_ATTRS + ')$', 'i');
  const re = /\[\s*([A-Za-z][\w-]*)\s*[~|^$*]?=\s*\\?["']?([\w .:-]+)/g;
  for (const abs of found.e2e.concat(found.e2eSupport)) {
    const text = readText(abs);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const a = m[1].toLowerCase();
      if (known.test(a) || !/^data-|test|e2e|qa|automation|(^|-)cy(-|$)/.test(a)) continue;
      if (/^data-(bs-|mat-|cdk-|toggle$|target$|dismiss$|placement$|parent$|ride$|slide)/.test(a)) continue; // UI library plumbing
      if (!use.has(a)) use.set(a, new Set());
      use.get(a).add(m[2].trim());
    }
  }
  for (const [a, values] of use) if (values.size >= 3) extraTestIdAttrs.push(a);
  extraTestIdAttrs.sort();
  if (extraTestIdAttrs.length) setTestIdAttrs(extraTestIdAttrs);
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
for (const x of routedExprs) if (staticRefs.get(x)) routedNames.add(staticRefs.get(x));
for (const c of components) c.routed = routedNames.has(c.name) || routedFiles.has(c.abs);

/* ------------------------------------------------------------------ *
 * Route tree: full paths, with lazy modules and route files mounted where they are loaded
 * ------------------------------------------------------------------ */
const routeList = []; // { segs, path, node, parent, e2e, comps }
const routeNotes = { unresolvedPaths: 0, unresolvedLazy: 0, remote: 0, unmounted: 0, truncated: false };
const compByName = new Map();
const compByFile = new Map();
for (const c of components) {
  if (!compByName.has(c.name)) compByName.set(c.name, []);
  compByName.get(c.name).push(c);
  if (!compByFile.has(c.abs)) compByFile.set(c.abs, []);
  compByFile.get(c.abs).push(c);
}
{
  const allArrays = [];
  for (const byKey of routeArrays.values()) for (const arr of byKey.values()) allArrays.push(arr);
  allArrays.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.key < b.key ? -1 : 1));
  const eachNode = (nodes, f) => {
    for (const n of nodes) {
      f(n);
      eachNode(n.children, f);
    }
  };
  // an array used by name: `children: adminRoutes`, `[...adminRoutes]`, `provideRouter(routes)`.
  // The name may come through an index.ts that re-exports it, so the files behind the import are searched too.
  const refTarget = (file, name) => {
    const own = routeArrays.get(file);
    if (own && own.has(name)) return own.get(name);
    const b = (fileImports.get(file) || new Map()).get(name);
    const dep = b ? resolveSpec(b.spec, file) : null;
    if (!dep) return null;
    const seen = new Set([dep]);
    let level = [dep];
    for (let depth = 0; depth < 4 && level.length; depth++) {
      const next = [];
      for (const f of level) {
        const arrs = routeArrays.get(f);
        if (arrs && arrs.has(b.name)) return arrs.get(b.name);
        if (arrs) continue; // a route file that does not have the name: do not wander off through its imports
        for (const d of (fileRecs.get(f) || { deps: [] }).deps) {
          if (seen.has(d)) continue;
          seen.add(d);
          next.push(d);
        }
      }
      level = next;
    }
    return null;
  };
  // the arrays a loadChildren import leads to: in the file itself, or in the routing file its module imports
  const STRUCTURAL = /(^|\/)index\.ts$|\.module\.ts$|rout/i;
  const lazyTargets = (lazy) => {
    const seen = new Set([lazy.file]);
    let level = [lazy.file];
    for (let depth = 0; depth < 4 && level.length; depth++) {
      const hits = [];
      for (const f of level) {
        const own = routeArrays.get(f);
        if (!own) continue;
        if (own.has(lazy.name)) return [own.get(lazy.name)];
        for (const a of own.values()) if (!a.refConsumed) hits.push(a);
      }
      if (hits.length) return hits;
      const next = [];
      for (const f of level) {
        const rec = fileRecs.get(f);
        if (!rec) continue;
        for (const d of rec.deps) {
          if (seen.has(d)) continue;
          seen.add(d);
          if (depth === 0 || STRUCTURAL.test(toPosix(d))) next.push(d);
        }
      }
      level = next;
    }
    return [];
  };
  for (const arr of allArrays) {
    for (const s of arr.spreads) {
      const t = refTarget(arr.file, s);
      if (t && t !== arr) t.refConsumed = true;
    }
    eachNode(arr.nodes, (n) => {
      n.refArrays = n.childRefs.map((r) => refTarget(n.file, r)).filter(Boolean);
      for (const t of n.refArrays) t.refConsumed = true;
      if (n.redirectTo === undefined && n.redirectExpr !== undefined) n.redirectTo = resolveConstText(n.redirectExpr);
      if (n.pathExpr === undefined) n.segs = n.path.split('/').filter(Boolean);
      else {
        const v = resolveConstText(n.pathExpr);
        if (v === undefined) routeNotes.unresolvedPaths++;
        n.segs = v === undefined ? ['{?}'] : v.split('/').filter(Boolean);
      }
    });
  }
  for (const arr of allArrays) {
    eachNode(arr.nodes, (n) => {
      if (!n.lazy) return;
      n.lazyArrays = n.lazy.file ? lazyTargets(n.lazy) : [];
      for (const t of n.lazyArrays) t.lazyConsumed = true;
      if (n.remote) routeNotes.remote++;
      else if (!n.lazyArrays.length && !n.refArrays.length) routeNotes.unresolvedLazy++;
    });
  }
  // arrays handed to the router are the entry points; an array nothing refers to is left out as dead code.
  // When a registration cannot be traced to its array, every free array is taken instead, to be on the safe side.
  let untraced = 0;
  for (const r of routerSetups) {
    const t = refTarget(r.file, r.name);
    if (t) t.registered = true;
    else untraced++;
  }
  const free = allArrays.filter((a) => !a.refConsumed && !a.lazyConsumed);
  let roots = free;
  if (!untraced && free.some((a) => a.registered)) {
    roots = free.filter((a) => a.registered);
    routeNotes.unmounted = sum(free.filter((a) => !a.registered), (a) => a.nodes.length);
  }
  if (!roots.length) roots = allArrays.filter((a) => !a.refConsumed);
  const stack = new Set();
  const expandNode = (n, prefix, parent) => {
    const segs = prefix.concat(n.segs);
    const entry = { segs: segs, path: '/' + segs.join('/'), node: n, parent: parent, e2e: '', comps: [] };
    routeList.push(entry);
    for (const c of n.children) expandNode(c, segs, entry);
    for (const t of n.refArrays) expandArray(t, segs, entry);
    for (const t of n.lazyArrays) expandArray(t, segs, entry);
  };
  const expandArray = (arr, prefix, parent) => {
    if (stack.has(arr)) return;
    if (routeList.length > 20000) {
      routeNotes.truncated = true;
      return;
    }
    stack.add(arr);
    for (const n of arr.nodes) expandNode(n, prefix, parent);
    for (const s of arr.spreads) {
      const t = refTarget(arr.file, s);
      if (t) expandArray(t, prefix, parent);
    }
    stack.delete(arr);
  };
  for (const r of roots) expandArray(r, [], null);

  for (const e of routeList) {
    const n = e.node;
    if (!n.component && !n.componentFile) continue;
    if (staticRefs.get(n.component)) n.component = staticRefs.get(n.component);
    let list = n.component ? compByName.get(n.component) || [] : [];
    if (n.componentFile) {
      const inFile = (compByFile.get(n.componentFile) || []).filter((c) => !n.component || c.name === n.component);
      if (inFile.length) list = inFile;
    } else if (list.length > 1) {
      // the same class name in several files: the import of the route file says which one
      const b = (fileImports.get(n.file) || new Map()).get(n.component);
      const dep = b ? resolveSpec(b.spec, n.file) : null;
      const exact = dep ? list.filter((c) => c.abs === dep) : [];
      if (exact.length) list = exact;
    }
    e.comps = list;
  }
}
const isScreen = (e) => !e.node.outlet && !!(e.node.component || e.node.componentFile || e.node.lazyComponent);

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

/* ------------------------------------------------------------------ *
 * End-to-end tests, read as text: titles, the URLs they open or assert, what they touch
 * ------------------------------------------------------------------ */
const e2e = { files: 0, loc: 0, cases: 0, byFramework: {}, featureFiles: 0, scenarios: 0, supportFiles: found.e2eSupport.length };
const e2eStatic = { tests: [], navs: [], literals: new Set(), affixes: new Map(), hooks: new Set(), lookups: { testIdCalls: 0, textCalls: 0 }, stubs: 0, stepDefs: 0, consts: new Map(), features: [], parseErrors: 0 };
// tests written through page objects name no framework: the folder, its other files and package.json do
const E2E_TOOL_DEPS = {
  cypress: ['cypress'], playwright: ['playwright', '@playwright/test', 'playwright-core'], protractor: ['protractor'],
  webdriverio: ['webdriverio', '@wdio/cli'], testcafe: ['testcafe'],
};
const E2E_TOOL_DIR_RE = /(^|[-_.])(cypress|playwright|protractor|wdio|webdriverio|testcafe)([-_.]|$)/i;
function onlyE2eTool(deps) {
  const tools = Object.keys(E2E_TOOL_DEPS).filter((n) => E2E_TOOL_DEPS[n].some((d) => deps[d]));
  return tools.length === 1 ? tools[0] : null;
}
const singleE2eTool = onlyE2eTool(declaredDeps);
const nestedToolCache = new Map();
/** The one e2e tool of the closest package.json between a test file and the scanned root (`e2e/package.json`). */
function nestedE2eTool(dir) {
  if (dir === ROOT || dir.length <= ROOT.length || path.dirname(dir) === dir) return null;
  if (nestedToolCache.has(dir)) return nestedToolCache.get(dir);
  const pj = path.join(dir, 'package.json');
  const json = fs.existsSync(pj) ? readJsonLoose(pj) : null;
  const tool = json ? onlyE2eTool(depsOf(json)) : nestedE2eTool(path.dirname(dir));
  nestedToolCache.set(dir, tool);
  return tool;
}
/** The folder that holds a suite of e2e tests: the path up to the first `e2e`, `cypress`, `e2e-playwright` ... segment. */
function e2eHomeOf(rel) {
  const segs = rel.split('/');
  for (let i = 0; i < segs.length - 1; i++) if (E2E_DIR_RE.test(segs[i])) return segs.slice(0, i + 1).join('/');
  return segs.slice(0, -1).join('/');
}
function e2eFrameworkOf(text, abs) {
  if (/\bcy\.\w+\(/.test(text) || /\.cy\.(ts|js|cjs|mjs)$/i.test(abs)) return 'cypress';
  if (/@playwright\/test|\bpage\.(?:goto|locator|getBy\w+)\(/.test(text)) return 'playwright';
  if (/from\s+['"]protractor['"]|\belement\(\s*by\./.test(text)) return 'protractor';
  if (/from\s+['"](?:@wdio\/globals|webdriverio)['"]|\bbrowser\.url\(/.test(text)) return 'webdriverio';
  if (/from\s+['"]testcafe['"]/.test(text)) return 'testcafe';
  const m = relOf(abs).split('/').slice(0, -1).map((seg) => E2E_TOOL_DIR_RE.exec(seg)).filter(Boolean)[0];
  if (m) return m[2].toLowerCase() === 'wdio' ? 'webdriverio' : m[2].toLowerCase();
  return 'other';
}
const cleanTitle = (s) => String(s).replace(/\s+/g, ' ').trim();
function titleOf(arg, sf) {
  if (!arg) return '';
  if (isStr(arg)) return cleanTitle(arg.text);
  const t = cleanTitle(arg.getText(sf));
  if (ts.isTemplateExpression(arg)) return t.slice(1, -1);
  return t.length > 140 ? t.slice(0, 137) + '...' : t;
}
/** URL-like string constants of the e2e code: `const LOGIN = '/login'`, `urls.login`, `Paths.Login`, `LoginPage.url`. */
function collectE2eConsts(sf, fileConsts) {
  const pathLike = (s) => s.length < 300 && /^(\/|#\/|https?:\/\/)/.test(s);
  const add = (k, v) => {
    for (const m of [fileConsts, e2eStatic.consts]) {
      const prev = m.get(k);
      if (prev === undefined) m.set(k, v);
      else if (prev !== v) m.set(k, null);
    }
  };
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const v = unwrapExpr(n.initializer);
      if (isStr(v) && pathLike(v.text)) add(n.name.text, v.text);
    } else if (ts.isPropertyAssignment(n)) {
      const v = unwrapExpr(n.initializer);
      const k = propName(n);
      if (k && isStr(v) && pathLike(v.text)) {
        let owner = n.parent.parent;
        while (owner && isExprWrapper(owner)) owner = owner.parent;
        if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) add(owner.name.text + '.' + k, v.text);
        else if (owner && ts.isPropertyDeclaration(owner) && propName(owner)) add(propName(owner) + '.' + k, v.text);
      }
    } else if (ts.isEnumMember(n)) {
      if (isStr(n.initializer) && pathLike(n.initializer.text) && propName(n)) add(n.parent.name.text + '.' + propName(n), n.initializer.text);
    } else if (ts.isPropertyDeclaration(n) && ts.isClassLike(n.parent) && n.parent.name) {
      const v = unwrapExpr(n.initializer);
      if (propName(n) && isStr(v) && pathLike(v.text)) add(n.parent.name.text + '.' + propName(n), v.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
/** /\/payments\/\d+$/ -> { url: '/payments/*', partial: true } */
function regexToUrl(literal) {
  let src = literal.slice(1, literal.lastIndexOf('/'));
  const start = src.charAt(0) === '^';
  const end = /(^|[^\\])\$$/.test(src);
  src = src.replace(/^\^/, '').replace(/\$$/, '');
  src = src
    .replace(/\\\//g, '/')
    .replace(/\\[dwsDWS][+*?]*|\[[^\]]*\][+*?]*|\((?:[^()]|\([^()]*\))*\)[+*?]*|\.[+*]\??/g, '*')
    .replace(/\\(.)/g, '$1')
    .replace(/[?+]+$/, '');
  return { url: src, partial: !(start && end) };
}
function analyzeE2eFile(p) {
  const sf = p.sf;
  const rel = p.rel;
  const fw = p.framework;
  const suites = [];
  let cur = null;
  let count = 0;
  // what a skipped test does never happens: its URLs, ids and selectors must not count as a trace
  const dead = () => (cur ? cur.status === 'skipped' || cur.status === 'pending' : suites.some((s) => s.skipped));
  const lit = (s) => {
    if (s && s.length < 400 && !dead()) e2eStatic.literals.add(s);
  };
  const constOf = (x) => {
    if (ts.isPropertyAccessExpression(x) && x.expression.kind === SK.ThisKeyword) {
      // this.url -> a field of the class the call sits in
      for (let c = x.parent; c; c = c.parent) {
        if (!ts.isClassLike(c)) continue;
        for (const m of c.members) {
          if (!ts.isPropertyDeclaration(m) || propName(m) !== x.name.text) continue;
          const v = unwrapExpr(m.initializer);
          if (isStr(v)) return v.text;
        }
        break;
      }
    }
    let name = dottedName(x);
    if (!name) return undefined;
    name = name.replace(/^this\./, '');
    const parts = name.split('.');
    const keys = parts.length > 2 ? [name, parts.slice(-2).join('.')] : [name];
    for (const k of keys) {
      for (const m of [p.consts, e2eStatic.consts]) if (typeof m.get(k) === 'string') return m.get(k);
      // constants of the application itself (route enums), but not bare lower-case names: those are local variables
      if ((k.indexOf('.') !== -1 || /^[A-Z][A-Z0-9_]*$/.test(k)) && typeof appConsts.get(k) === 'string') return appConsts.get(k);
    }
    return undefined;
  };
  const urlOf = (x) => {
    x = unwrapExpr(x);
    if (!x) return '*';
    if (isStr(x)) return x.text;
    if (ts.isTemplateExpression(x)) {
      let s = x.head.text;
      for (const sp of x.templateSpans) {
        const v = constOf(unwrapExpr(sp.expression));
        s += (v === undefined ? '*' : v) + sp.literal.text;
      }
      return s;
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === SK.PlusToken) return urlOf(x.left) + urlOf(x.right);
    if (ts.isObjectLiteralExpression(x)) {
      for (const pr of x.properties) if (ts.isPropertyAssignment(pr) && propName(pr) === 'url') return urlOf(pr.initializer);
      return '*';
    }
    if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
      const v = constOf(x);
      return v === undefined ? '*' : v;
    }
    return '*';
  };
  const nav = (kind, arg, partial) => {
    const a = unwrapExpr(arg);
    if (!a) return;
    let url;
    if (ts.isRegularExpressionLiteral(a)) {
      const r = regexToUrl(a.text);
      url = r.url;
      partial = r.partial;
    } else url = urlOf(a);
    if (cur && kind === 'visit') cur.visits.push(url);
    if (!dead()) e2eStatic.navs.push({ kind: kind, raw: url, partial: !!partial, file: rel });
  };
  const chainHas = (expr, names) => {
    for (let e = expr; e; ) {
      if (ts.isCallExpression(e)) {
        if (ts.isPropertyAccessExpression(e.expression) && names.indexOf(e.expression.name.text) !== -1) return true;
        e = e.expression;
      } else if (ts.isPropertyAccessExpression(e)) e = e.expression;
      else break;
    }
    return false;
  };
  const isUrlExpect = (recv) => {
    let e = recv;
    while (e && ts.isPropertyAccessExpression(e)) e = e.expression;
    if (!e || !ts.isCallExpression(e) || !e.arguments.length) return false;
    const callee = dottedName(e.expression);
    return !!callee && /^expect(\.soft)?$/.test(callee) && /getCurrentUrl|\.url\(\)|location\.(href|pathname|hash)|currentUrl/i.test(e.arguments[0].getText(sf));
  };
  const isPlus = (x) => !!x && ts.isBinaryExpression(x) && x.operatorToken.kind === SK.PlusToken;
  // the fixed pieces of a string that is put together at run time; one gap per variable part
  const chunksOf = (x) => {
    const chunks = [''];
    (function walk(y) {
      y = unwrapExpr(y);
      if (isPlus(y)) {
        walk(y.left);
        walk(y.right);
      } else if (y && isStr(y)) chunks[chunks.length - 1] += y.text;
      else if (y && ts.isTemplateExpression(y)) {
        chunks[chunks.length - 1] += y.head.text;
        for (const sp of y.templateSpans) chunks.push(sp.literal.text);
      } else chunks.push('');
    })(x);
    return chunks;
  };
  // `[data-cy="${entity}DetailsHeading"]` -> ids that end in "DetailsHeading"; the other half is a literal at the call site
  const composed = (n) => {
    if (dead()) return;
    const chunks = chunksOf(n);
    const par = n.parent;
    const callee = par && ts.isCallExpression(par) && par.arguments.indexOf(n) !== -1 ? dottedName(par.expression) : undefined;
    const helper = !!callee && TEST_ID_HELPER_RE.test(callee.split('.').pop());
    for (let i = 1; i < chunks.length; i++) {
      const left = chunks[i - 1];
      const right = chunks[i];
      const a = /[\w-]*$/.exec(left)[0];
      const b = /^[\w-]*/.exec(right)[0];
      if (!a && !b) continue; // the whole id is a variable: its value is a literal somewhere else
      if ((a === left && i > 1) || (b === right && i < chunks.length - 1)) continue; // the id runs on into another variable part
      const before = left.slice(0, left.length - a.length);
      const wholeArg = helper && before === '' && b === right;
      if (wholeArg || TEST_ID_SEL_END_RE.test(before)) e2eStatic.affixes.set(a + '\u0000' + b, { a: a, b: b });
    }
  };
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) lit(n.text);
    else if (ts.isTemplateExpression(n)) {
      lit(n.head.text);
      for (const s of n.templateSpans) lit(s.literal.text);
      if (!isPlus(n.parent)) composed(n);
    } else if (ts.isRegularExpressionLiteral(n)) lit(n.text);
    else if (isPlus(n) && !isPlus(n.parent)) composed(n);
    else if (ts.isCallExpression(n) && call(n)) return;
    ts.forEachChild(n, visit);
  };
  // returns true when the call was a suite or a test and its arguments have been walked already
  const call = (n) => {
    let callee = n.expression;
    let each = false;
    if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'each') {
      each = true; // it.each(table)('title', fn)
      callee = callee.expression.expression;
    } else if (ts.isTaggedTemplateExpression(callee) && ts.isPropertyAccessExpression(callee.tag) && callee.tag.name.text === 'each') {
      each = true; // it.each`table`('title', fn)
      callee = callee.tag.expression;
    }
    const name = dottedName(callee);
    const args = n.arguments;
    if (name) {
      const fn = lastFunctionArg(args);
      const literalTitle = args.length > 0 && args[0] !== fn && (isStr(args[0]) || ts.isTemplateExpression(args[0]) || (ts.isBinaryExpression(args[0]) && args[0].operatorToken.kind === SK.PlusToken));
      if (E2E_SUITE_RE.test(name) && fn && args.length <= 3) {
        suites.push({ title: args[0] === fn ? '' : titleOf(args[0], sf), skipped: /\.(skip|fixme)\b|^xdescribe/.test(name), only: /\.only\b|^fdescribe/.test(name) });
        for (const a of args) visit(a);
        suites.pop();
        return true;
      }
      if (!cur && E2E_TEST_RE.test(name) && args.length > 0 && (literalTitle || (fn && args[0] !== fn))) {
        const skipped = /^x(it|specify)\b|\.(skip|fixme)\b/.test(name) || suites.some((s) => s.skipped);
        const only = /^fit\b|\.only\b/.test(name) || suites.some((s) => s.only);
        const pending = /\.todo\b/.test(name) || args.length === 1;
        const t = {
          file: rel, framework: fw, suite: suites.map((s) => s.title).filter(Boolean), title: titleOf(args[0], sf),
          status: skipped ? 'skipped' : pending ? 'pending' : only ? 'only' : 'active',
          each: each, steps: [], actions: 0, checks: 0, calls: 0, visits: [],
        };
        e2eStatic.tests.push(t);
        count++;
        cur = t;
        for (const a of args) visit(a);
        cur = null;
        return true;
      }
      if (name === 'test.step' && cur && args.length) cur.steps.push(titleOf(args[0], sf));
      else if (STEP_DEF_RE.test(name) && args.length >= 2 && fn) e2eStatic.stepDefs++;
      else if (cur && /^(expect|assert)(\.|$)/.test(name)) cur.checks++;
    }
    if (cur) cur.calls++;
    if (!ts.isPropertyAccessExpression(n.expression)) return false;
    const pn = n.expression.name.text;
    const recv = n.expression.expression;
    if (cur) {
      if (E2E_ACTIONS.has(pn)) cur.actions++;
      else if (E2E_CHECKS.has(pn)) cur.checks++;
    }
    if (!args.length) return false;
    if (!dead()) {
      // how the tests find their elements: through a test id helper, or by what the user sees (text, role, label)
      if (TEXT_LOOKUP_RE.test(pn) || (pn === 'contains' && fw === 'cypress')) e2eStatic.lookups.textCalls++;
      else if (TEST_ID_HELPER_RE.test(pn)) e2eStatic.lookups.testIdCalls++;
      // Protractor and Selenium: by.id('x'), By.name('x')
      const a0 = unwrapExpr(args[0]);
      if ((pn === 'id' || pn === 'name') && ts.isIdentifier(recv) && /^by$/i.test(recv.text) && a0 && isStr(a0)) e2eStatic.hooks.add(pn + '=' + a0.text);
    }
    if (pn === 'visit' || pn === 'goto' || ((pn === 'get' || pn === 'url') && ts.isIdentifier(recv) && recv.text === 'browser')) nav('visit', args[0], false);
    else if (pn === 'toHaveURL' || pn === 'waitForURL') nav('assert', args[0], false);
    else if (pn === 'should' && args.length >= 2 && isStr(args[0]) && chainHas(recv, ['url', 'location', 'hash'])) {
      if (/include|contain|eq|equal|match|string/.test(args[0].text)) nav('assert', args[1], !/^(eq|equal|eql)$/.test(args[0].text));
    } else if (/^(toContain|toEqual|toBe|toMatch|toStrictEqual)$/.test(pn) && isUrlExpect(recv)) nav('assert', args[0], pn === 'toContain' || pn === 'toMatch');
    else if ((pn === 'intercept' || (pn === 'route' && /^(cy|page|context|browserContext|this\.page|this\.context)$/.test(dottedName(recv) || ''))) && !dead()) e2eStatic.stubs++;
    return false;
  };
  visit(sf);
  return count;
}
function parseFeature(text, rel) {
  const f = { file: rel, name: '', tags: [], description: [], background: [], scenarios: [] };
  let cur = null;
  let tags = [];
  let rule = '';
  let section = 'head';
  let inDoc = false;
  let header = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^("""|```)/.test(line)) {
      inDoc = !inDoc;
      continue;
    }
    if (inDoc || !line || line.charAt(0) === '#') continue;
    if (line.charAt(0) === '@') {
      tags = tags.concat(line.split(/\s+/).filter((t) => t.charAt(0) === '@'));
      continue;
    }
    let m;
    if ((m = /^Feature:\s*(.*)$/.exec(line))) {
      f.name = m[1];
      f.tags = tags;
      tags = [];
      section = 'feature';
    } else if ((m = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(line))) {
      cur = { name: m[2], outline: /Outline|Template/.test(m[1]), tags: tags, rule: rule, steps: [], examples: 0 };
      tags = [];
      f.scenarios.push(cur);
      section = 'scenario';
    } else if (/^Background:/.test(line)) {
      cur = null;
      section = 'background';
    } else if ((m = /^Rule:\s*(.*)$/.exec(line))) {
      rule = m[1];
      cur = null;
      section = 'rule';
    } else if (/^(Examples|Scenarios):/.test(line)) {
      section = 'examples';
      header = true;
    } else if (line.charAt(0) === '|') {
      if (section === 'examples' && cur) {
        if (header) header = false;
        else cur.examples++;
      }
    } else if (/^(Given|When|Then|And|But|\*)\s/.test(line)) {
      if (section === 'background') f.background.push(line);
      else if (cur) cur.steps.push(line);
    } else if (section === 'feature') f.description.push(line);
  }
  return f;
}
{
  const parsed = [];
  const testFiles = new Set(found.e2e);
  for (const abs of found.e2e.concat(found.e2eSupport)) {
    const text = readText(abs);
    const p = { abs: abs, rel: relOf(abs), text: text, isTest: testFiles.has(abs), framework: e2eFrameworkOf(text, abs), consts: new Map(), sf: null };
    try {
      p.sf = ts.createSourceFile(p.rel, text, ts.ScriptTarget.Latest, true, /\.(js|cjs|mjs)$/i.test(abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
      collectE2eConsts(p.sf, p.consts);
    } catch (e) {
      p.sf = null;
    }
    parsed.push(p);
  }
  {
    // a spec that only calls page objects: take the tool its neighbours use, then the nearest package.json
    const byHome = new Map();
    for (const p of parsed) {
      if (p.framework === 'other') continue;
      const h = e2eHomeOf(p.rel);
      if (!byHome.has(h)) byHome.set(h, new Set());
      byHome.get(h).add(p.framework);
    }
    for (const p of parsed) {
      if (p.framework !== 'other') continue;
      const seen = byHome.get(e2eHomeOf(p.rel));
      p.framework = (seen && seen.size === 1 && Array.from(seen)[0]) || nestedE2eTool(path.dirname(p.abs)) || singleE2eTool || 'other';
    }
  }
  for (const p of parsed) {
    let cases = -1;
    if (p.sf) {
      try {
        cases = analyzeE2eFile(p);
      } catch (e) {
        cases = -1;
      }
    }
    p.sf = null;
    if (!p.isTest) continue;
    if (cases < 0) {
      // could not be read as code: fall back to counting test calls in the text
      e2eStatic.parseErrors++;
      cases = (p.text.match(TEST_CASE_RE) || []).length;
    }
    e2e.files++;
    e2e.loc += nonBlank(p.text);
    e2e.cases += cases;
    if (!e2e.byFramework[p.framework]) e2e.byFramework[p.framework] = { files: 0, cases: 0 };
    e2e.byFramework[p.framework].files++;
    e2e.byFramework[p.framework].cases += cases;
    const proj = projectOf(p.rel);
    proj.e2eFiles++;
    proj.e2eCases += cases;
  }
}
for (const abs of found.feature) {
  const text = readText(abs);
  e2e.featureFiles++;
  e2e.scenarios += (text.match(/^\s*(?:Scenario|Scenario Outline|Scenario Template|Example):/gm) || []).length;
  e2eStatic.features.push(parseFeature(text, relOf(abs)));
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

/* ------------------------------------------------------------------ *
 * Coverage reports, per file (unit tests, and an instrumented e2e run when there is one)
 * ------------------------------------------------------------------ */
function parseLcov(text) {
  const out = [];
  let cur = null;
  let da = 0;
  let daHit = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      cur = { path: line.slice(3).trim(), lf: -1, lh: -1, brf: 0, brh: 0, fnf: 0, fnh: 0 };
      da = 0;
      daHit = 0;
    } else if (!cur) continue;
    else if (line.startsWith('DA:')) {
      da++;
      if (parseInt(line.split(',')[1], 10) > 0) daHit++;
    } else if (line.startsWith('LF:')) cur.lf = parseInt(line.slice(3), 10) || 0;
    else if (line.startsWith('LH:')) cur.lh = parseInt(line.slice(3), 10) || 0;
    else if (line.startsWith('BRF:')) cur.brf = parseInt(line.slice(4), 10) || 0;
    else if (line.startsWith('BRH:')) cur.brh = parseInt(line.slice(4), 10) || 0;
    else if (line.startsWith('FNF:')) cur.fnf = parseInt(line.slice(4), 10) || 0;
    else if (line.startsWith('FNH:')) cur.fnh = parseInt(line.slice(4), 10) || 0;
    else if (line.startsWith('end_of_record')) {
      if (cur.lf < 0) cur.lf = da;
      if (cur.lh < 0) cur.lh = daHit;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}
/** coverage-summary.json (json-summary reporter) or coverage-final.json (json reporter) */
function parseCoverageJson(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;
  for (const k of Object.keys(j)) {
    const v = j[k];
    if (k === 'total' || !v || typeof v !== 'object') continue;
    if (v.lines && typeof v.lines.total === 'number') {
      const g = (x) => (x && typeof x.total === 'number' ? x : { total: 0, covered: 0 });
      out.push({ path: k, lf: v.lines.total, lh: v.lines.covered, brf: g(v.branches).total, brh: g(v.branches).covered, fnf: g(v.functions).total, fnh: g(v.functions).covered });
    } else if (v.statementMap && v.s) {
      // lines the way Istanbul counts them: a line is the start line of a statement, covered when any statement on it ran
      const lines = new Map();
      for (const id of Object.keys(v.statementMap)) {
        const st = v.statementMap[id];
        if (!st || !st.start || typeof st.start.line !== 'number') continue;
        lines.set(st.start.line, (lines.get(st.start.line) || false) || v.s[id] > 0);
      }
      let lh = 0;
      for (const hit of lines.values()) if (hit) lh++;
      const fn = Object.keys(v.f || {});
      let brf = 0;
      let brh = 0;
      for (const id of Object.keys(v.b || {})) {
        for (const n of v.b[id] || []) {
          brf++;
          if (n > 0) brh++;
        }
      }
      out.push({ path: v.path || k, lf: lines.size, lh: lh, brf: brf, brh: brh, fnf: fn.length, fnh: fn.filter((id) => v.f[id] > 0).length });
    }
  }
  return out;
}
/** One directory page of the Istanbul HTML report: the default Angular setup writes nothing else. */
function parseIstanbulHtml(file, baseDir) {
  const text = readText(file);
  const out = [];
  if (text.indexOf('coverage-summary') === -1) return out;
  const rowRe = /<td class="file[^"]*" data-value="([^"]*)">\s*<a href="([^"]*)">[\s\S]*?<\/tr>/g;
  let m;
  while ((m = rowRe.exec(text))) {
    if (/(^|\/)index\.html$/.test(m[2])) continue; // a folder row, its own page lists the files
    const abs = [];
    const re = /class="abs[^"]*">\s*(\d+)\/(\d+)\s*<\/td>/g;
    let a;
    while ((a = re.exec(m[0]))) abs.push([parseInt(a[1], 10), parseInt(a[2], 10)]);
    if (abs.length < 4) continue; // statements, branches, functions, lines
    const name = m[1].replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&quot;/g, '"');
    out.push({ path: path.join(path.relative(baseDir, path.dirname(file)), name), lf: abs[3][1], lh: abs[3][0], brf: abs[1][1], brh: abs[1][0], fnf: abs[2][1], fnh: abs[2][0] });
  }
  return out;
}
const coverageByFile = { unit: new Map(), e2e: new Map() }; // absolute path of an application file -> { lf, lh, brf, brh, fnf, fnh }
const coverageReports = []; // { path, format, kind, files, matched }
{
  // a report names files its own way (absolute path on the build machine, relative to a sub-project, ...): match by the end of the path
  const byBase = new Map();
  for (const f of fileRecs.keys()) {
    const b = path.basename(f);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push({ abs: f, segs: toPosix(f).split('/') });
  }
  const mapPath = (p) => {
    const segs = String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    const cands = byBase.get(segs[segs.length - 1]);
    if (!cands) return null;
    let best = null;
    let bestN = 0;
    let tie = false;
    for (const c of cands) {
      let n = 0;
      while (n < segs.length && n < c.segs.length && segs[segs.length - 1 - n] === c.segs[c.segs.length - 1 - n]) n++;
      if (n > bestN) {
        best = c;
        bestN = n;
        tie = false;
      } else if (n === bestN) tie = true;
    }
    if (!best || tie) return null;
    return bestN >= 2 || cands.length === 1 ? best.abs : null;
  };
  const kindOf = (file, forced) => forced || (relOf(file).split('/').some((s) => E2E_DIR_RE.test(s)) ? 'e2e' : 'unit');
  const seenFiles = new Set();
  const load = (file, format, kind, baseDir) => {
    if (seenFiles.has(file)) return;
    seenFiles.add(file);
    let entries = [];
    try {
      if (format === 'lcov') entries = parseLcov(readText(file));
      else if (format === 'json') entries = parseCoverageJson(readJsonLoose(file));
      else entries = parseIstanbulHtml(file, baseDir);
    } catch (e) {
      entries = [];
    }
    if (!entries.length) return;
    const into = coverageByFile[kind];
    let matched = 0;
    for (const en of entries) {
      const abs = mapPath(en.path);
      if (!abs) continue;
      matched++;
      const prev = into.get(abs);
      if (!prev || en.lh > prev.lh || (en.lh === prev.lh && en.lf > prev.lf)) into.set(abs, en);
    }
    let rep = coverageReports.find((r) => r.format === 'html' && format === 'html' && r.base === baseDir && r.kind === kind);
    if (!rep) coverageReports.push((rep = { path: relOf(format === 'html' ? baseDir : file), format: format, kind: kind, files: 0, matched: 0, base: baseDir }));
    rep.files += entries.length;
    rep.matched += matched;
  };
  const scanDir = (dir, forced) => {
    const data = [];
    const html = [];
    (function walkCov(d, depth) {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (depth < 12 && e.name !== 'node_modules') walkCov(full, depth + 1);
        } else if (e.name === 'lcov.info') data.push([full, 'lcov']);
        else if (e.name === 'coverage-final.json' || e.name === 'coverage-summary.json') data.push([full, 'json']);
        else if (e.name === 'index.html') html.push(full);
      }
    })(dir, 0);
    const kindsWithData = new Set();
    for (const d of data) {
      const kind = kindOf(d[0], forced);
      kindsWithData.add(kind);
      load(d[0], d[1], kind, dir);
    }
    // the HTML pages repeat what lcov and JSON say: read them only when nothing else is there
    for (const h of html) {
      const kind = kindOf(h, forced);
      if (!kindsWithData.has(kind)) load(h, 'html', kind, dir);
    }
  };
  const scanPath = (p, forced) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      process.stderr.write('Coverage path not found: ' + p + '\n');
      return;
    }
    if (st.isDirectory()) scanDir(p, forced);
    else if (/\.json$/i.test(p)) load(p, 'json', forced || 'unit', path.dirname(p));
    else if (/\.html?$/i.test(p)) scanDir(path.dirname(p), forced);
    else load(p, 'lcov', forced || 'unit', path.dirname(p));
  };
  for (const d of coverageDirs) scanPath(d, null);
  for (const p of opts.coverage) scanPath(path.resolve(p), 'unit');
  for (const p of opts.e2eCoverage) scanPath(path.resolve(p), 'e2e');
  for (const r of coverageReports) delete r.base;
}

const graphql = { files: 0, operations: { query: 0, mutation: 0, subscription: 0, fragment: 0 }, schemaDefinitions: 0, documentsInTs: agg.gql.documents, operationsInTs: agg.gql.operations, callSites: 0 };
const seenGraphql = new Set();
for (const abs of found.graphql) {
  const text = readText(abs);
  // the same schema is often copied into mock servers: count identical files once
  const digest = require('crypto').createHash('sha1').update(text).digest('hex');
  if (seenGraphql.has(digest)) continue;
  seenGraphql.add(digest);
  if (inAppFolders(abs)) collectGqlOps(text, abs);
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
 * Tests against the application: which screens and components leave a trace in the e2e code,
 * which files the unit tests cover, and where neither is the case
 * ------------------------------------------------------------------ */
const testGaps = {};
/** '/payments/42?tab=1', 'http://host/#/payments', `${base}/payments` -> ['payments', '42']; null when nothing of it is known */
function urlToSegs(raw) {
  let s = String(raw).trim();
  if (/^\*+$/.test(s)) return null; // built at run time: nothing to match
  s = s.replace(/^\*+(?=[\/#?]|$)/, '').replace(/^[a-z][a-z0-9+.\-]*:\/\/[^\/?#]*/i, '');
  const hash = s.indexOf('#/');
  if (hash !== -1) s = s.slice(hash + 1);
  s = s.replace(/[?#].*$/, '');
  return s.split('/').filter(Boolean).map((x) => (x.indexOf('*') !== -1 ? '*' : x));
}
{
  // --- URLs from the e2e code against the route tree
  const LEVEL = { '': 0, shared: 1, element: 2, ran: 3, asserted: 4, visited: 5 };
  // a parameter of the route takes any segment; a part of the URL that is unknown only fits a parameter
  const segFits = (r, u) => (r.charAt(0) === ':' ? 1 : r === u && u !== '*' ? 3 : 0);
  const matchExact = (segs) => {
    let best = -1;
    let hits = [];
    for (const e of routeList) {
      const rs = e.segs;
      if (rs.length !== segs.length || (rs.length && rs[rs.length - 1] === '**')) continue;
      let score = 0;
      let ok = true;
      for (let i = 0; i < rs.length && ok; i++) {
        const f = segFits(rs[i], segs[i]);
        if (!f) ok = false;
        score += f;
      }
      if (!ok) continue;
      if (score > best) {
        best = score;
        hits = [e];
      } else if (score === best) hits.push(e);
    }
    return hits;
  };
  // "URL includes /payments": the shortest routes that contain these segments in a row
  const matchPartial = (segs) => {
    if (!segs.length) return [];
    let hits = [];
    let len = Infinity;
    for (const e of routeList) {
      const rs = e.segs;
      let found = false;
      for (let at = 0; at + segs.length <= rs.length && !found; at++) {
        found = true;
        for (let i = 0; i < segs.length && found; i++) if (!segFits(rs[at + i], segs[i])) found = false;
      }
      if (!found) continue;
      if (rs.length < len) {
        len = rs.length;
        hits = [e];
      } else if (rs.length === len) hits.push(e);
    }
    return hits;
  };
  const credit = (e, level, depth) => {
    if (e.node.isRedirect && typeof e.node.redirectTo === 'string' && depth < 4) {
      const base = e.node.redirectTo.charAt(0) === '/' || !e.parent ? [] : e.parent.segs;
      for (const h of matchExact(base.concat(e.node.redirectTo.split('/').filter(Boolean)))) if (h !== e) credit(h, level, depth + 1);
    }
    // everything above a route is on screen with it
    for (let x = e; x; x = x.parent) if (LEVEL[level] > LEVEL[x.e2e]) x.e2e = level;
  };
  const nav = { resolved: 0, unresolved: 0, matched: 0, unmatched: {}, visits: 0, assertions: 0 };
  for (const n of e2eStatic.navs) {
    if (n.kind === 'visit') nav.visits++;
    else nav.assertions++;
    const segs = urlToSegs(n.raw);
    if (!segs || (segs.length && segs.every((s) => s === '*'))) {
      nav.unresolved++;
      continue;
    }
    nav.resolved++;
    if (!routeList.length) continue;
    let hits = n.partial ? matchPartial(segs) : matchExact(segs);
    // the application may be served under a base path: /tfc/payments
    if (!hits.length && !n.partial && segs.length > 1) hits = matchExact(segs.slice(1));
    if (!hits.length) {
      bump(nav.unmatched, '/' + segs.join('/'));
      continue;
    }
    nav.matched++;
    for (const h of hits) credit(h, n.kind === 'visit' ? 'visited' : 'asserted', 0);
  }

  // --- components: test ids and selectors named in the e2e code
  const blob = '\u0000' + Array.from(e2eStatic.literals).join('\u0000') + '\u0000';
  const idCache = new Map();
  const affixes = Array.from(e2eStatic.affixes.values());
  // 'literal': the id is written out in the test code. 'composed': a helper builds ids of this shape and the missing half is a literal in the tests.
  const idHow = (id) => {
    if (!idCache.has(id)) {
      let how = '';
      if (blob.indexOf('\u0000' + id + '\u0000') !== -1 || blob.indexOf('="' + id + '"') !== -1 || blob.indexOf("='" + id + "'") !== -1 || blob.indexOf('=' + id + ']') !== -1) how = 'literal';
      else if (affixes.some((x) => id.length > x.a.length + x.b.length && id.startsWith(x.a) && id.endsWith(x.b) && e2eStatic.literals.has(id.slice(x.a.length, id.length - x.b.length)))) how = 'composed';
      idCache.set(id, how);
    }
    return idCache.get(id);
  };
  const idInE2e = (id) => !!idHow(id);
  const elementSelectors = (sel) => {
    const out = [];
    for (const part of String(sel || '').split(',')) {
      const m = /^\s*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=$|[\s\[.:])/i.exec(part);
      if (m) out.push(m[1].toLowerCase());
    }
    return out;
  };
  const bySelector = new Map();
  for (const c of components) {
    c.sels = elementSelectors(c.selector);
    for (const s of c.sels) {
      if (!bySelector.has(s)) bySelector.set(s, []);
      bySelector.get(s).push(c);
    }
  }
  // ids, names and form control names that the tests select by: '#save', 'form#login', '[name="q"]', '[formcontrolname=amount]'
  const hooksInTests = e2eStatic.hooks;
  const lookups = { testId: 0, tag: 0, handle: 0, cssClass: 0, otherAttribute: 0, attributes: {} };
  {
    const testIdSel = new RegExp('\\[\\s*(?:' + TEST_ID_ATTRS + extraTestIdAttrs.map((a) => '|' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + ')\\s*[~|^$*]?[=\\]]', 'i');
    const idRe = /(?:^|[\s>+~,(]|\b[a-z][a-z0-9-]*)#([A-Za-z_][\w-]*)/g;
    const attrRe = /\[\s*([A-Za-z][\w-]*)\s*(?:[~|^$*]?=\s*["']?([^"'\]\s]*)["']?\s*)?\]/g;
    for (const lit of e2eStatic.literals) {
      if (lit.length > 300 || /^\s*[{<]/.test(lit)) continue; // JSON, markup
      const isUrl = lit.indexOf('://') !== -1 || lit.charAt(0) === '/';
      let m;
      let kinds = 0;
      if (lit.indexOf('#') !== -1 && !isUrl) {
        idRe.lastIndex = 0;
        while ((m = idRe.exec(lit))) {
          hooksInTests.add('id=' + m[1]);
          kinds |= 1;
        }
      }
      if (lit.indexOf('[') !== -1) {
        if (testIdSel.test(lit)) kinds |= 2;
        attrRe.lastIndex = 0;
        while ((m = attrRe.exec(lit))) {
          const a = m[1].toLowerCase();
          if (HOOK_KIND[a] && m[2]) hooksInTests.add(HOOK_KIND[a] + '=' + m[2]);
          if (HOOK_KIND[a]) kinds |= 1;
          else if (!testIdSel.test('[' + a + ']')) {
            kinds |= 4;
            bump(lookups.attributes, a);
          }
        }
      }
      if (!isUrl && lit.indexOf('/') === -1 && /(?:^|[\s>+~,(])\.[A-Za-z_][\w-]*/.test(lit)) kinds |= 8;
      const tag = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=$|[\s\[.:>#,])/.exec(lit);
      if (tag && bySelector.has(tag[1])) kinds |= 16; // a selector of one of the application's own components
      if (kinds & 1) lookups.handle++;
      if (kinds & 2) lookups.testId++;
      if (kinds & 4) lookups.otherAttribute++;
      if (kinds & 8) lookups.cssClass++;
      if (kinds & 16) lookups.tag++;
    }
  }
  const hasE2e = e2eStatic.literals.size > 0;
  const idOwners = new Map();
  for (const c of components) for (const id of c.testIdList) idOwners.set(id, (idOwners.get(id) || 0) + 1);
  const hookOwners = new Map();
  for (const c of components) for (const h of c.hookList) hookOwners.set(h, (hookOwners.get(h) || 0) + 1);
  for (const c of components) {
    c.testIds = c.testIdList.length;
    c.testIdsInE2e = hasE2e ? c.testIdList.filter((id) => idOwners.get(id) === 1 && idInE2e(id)).length : 0;
    c.sharedIdsInE2e = hasE2e ? c.testIdList.filter((id) => idOwners.get(id) > 1 && idOwners.get(id) <= SHARED_MAX && idInE2e(id)).length : 0;
    c.hooksInE2e = hasE2e ? c.hookList.filter((h) => hookOwners.get(h) === 1 && hooksInTests.has(h)).length : 0;
    c.sharedIdsInE2e += hasE2e ? c.hookList.filter((h) => hookOwners.get(h) > 1 && hookOwners.get(h) <= SHARED_MAX && hooksInTests.has(h)).length : 0;
    c.e2eRoute = '';
    // the root component is on screen whenever a test opens anything at all
    c.e2eRoot = bootstrapNames.has(c.name) && nav.visits > 0;
    c.e2eSelector = hasE2e && c.sels.some((s) => new RegExp('(^|[^\\w-])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w-])').test(blob));
    c.onScreen = false;
  }
  for (const e of routeList) for (const c of e.comps) if (LEVEL[e.e2e] > LEVEL[c.e2eRoute]) c.e2eRoute = e.e2e;

  // an instrumented e2e run, when a report of one was read: did code of the file run? A file that was only loaded has
  // lines that ran but no function that did, so functions decide wherever the report counts them.
  const linePct = (r) => (r && r.lf ? Math.round((r.lh / r.lf) * 100) : '');
  const e2eRep = coverageByFile.e2e.size > 0;
  let e2eHasFunctions = false;
  for (const r of coverageByFile.e2e.values()) if (r.fnf > 0) e2eHasFunctions = true;
  for (const x of components.concat(classes)) {
    const er = coverageByFile.e2e.get(x.abs);
    x.e2eLinePct = linePct(er);
    x.e2eRan = !!er && (e2eHasFunctions ? er.fnh > 0 : er.lh > 0);
  }

  // --- who can put a component on screen: its routes, and the components that use its tag or name it in their class
  const hostsOf = new Map();
  const routesOf = new Map();
  const link = (map, k, v) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(v);
  };
  for (const h of components) {
    for (const tag of h.tagList) for (const x of bySelector.get(tag) || []) if (x !== h) link(hostsOf, x, h);
    for (const r of h.refs) for (const x of compByName.get(r) || []) if (x !== h) link(hostsOf, x, h);
  }
  for (const e of routeList) for (const c of e.comps) link(routesOf, c, e);
  // a service, guard or directive that names a component may open or create it, and nothing here can follow that
  const namedElsewhere = new Set();
  for (const k of classes) if (k.kind !== 'module') for (const r of k.refs || []) for (const x of compByName.get(r) || []) namedElsewhere.add(x);

  // A component with marks of its own (a test id only it has, its selector, code that ran) was on screen in some test.
  // So was whatever alone can put it there: its routes, or, without a route, its one host. With two or three candidates
  // the trace cannot say which of them it was, and they get the weaker "shared" mark. With more than that (a widget
  // that sits on every other screen) it says next to nothing about any one of them, and is not passed on at all.
  const ownMark = (c) => (c.e2eRan ? 'ran' : c.testIdsInE2e || c.e2eSelector || c.hooksInE2e ? 'element' : '');
  const certain = (c) => !!(c.e2eRoute || c.e2eRoot || c.e2eHost || ownMark(c));
  const creditRoutes = (c, level) => {
    for (const e of routesOf.get(c) || []) for (let x = e; x; x = x.parent) if (LEVEL[level] > LEVEL[x.e2e]) x.e2e = level;
  };
  const up = components.filter(ownMark).map((c) => ({ c: c, level: ownMark(c) }));
  const undecided = components.filter((c) => c.sharedIdsInE2e);
  while (up.length) {
    const it = up.pop();
    const hosts = Array.from(hostsOf.get(it.c) || []);
    if (routesOf.has(it.c)) {
      creditRoutes(it.c, it.level);
      if (hosts.length <= SHARED_MAX) for (const h of hosts) undecided.push(h);
    } else if (hosts.length === 1 && !namedElsewhere.has(it.c)) {
      if (!certain(hosts[0])) {
        hosts[0].e2eHost = true;
        up.push({ c: hosts[0], level: it.level });
      }
    } else if (hosts.length <= SHARED_MAX) for (const h of hosts) undecided.push(h);
  }
  // a screen that is reached takes the routes above it along: their components hold the outlet it sits in
  for (const e of routeList) if (e.e2e === 'element' || e.e2e === 'ran') for (const c of e.comps) if (!certain(c)) c.e2eHost = true;
  const seenUndecided = new Set();
  while (undecided.length) {
    const c = undecided.pop();
    if (seenUndecided.has(c) || certain(c)) continue;
    seenUndecided.add(c);
    c.e2eShared = true;
    creditRoutes(c, 'shared');
    const hosts = hostsOf.get(c);
    if (hosts && hosts.size <= SHARED_MAX) for (const h of hosts) undecided.push(h);
  }
  // the same component under another path that the tests do reach: the component is covered, this path may not be
  for (const e of routeList) if (!e.e2e && e.comps.some(certain)) for (let x = e; x; x = x.parent) if (!x.e2e) x.e2e = 'shared';
  for (const e of routeList) if (e.e2e === 'shared') for (const c of e.comps) if (!certain(c)) c.e2eShared = true;

  // --- what a reached component puts on screen: tags in its template, components its class opens or creates
  const queue = components.filter(certain);
  const seen = new Set(queue);
  while (queue.length) {
    const c = queue.pop();
    const next = [];
    for (const tag of c.tagList) for (const k of bySelector.get(tag) || []) next.push(k);
    for (const r of c.refs) if (r !== c.name) for (const k of compByName.get(r) || []) next.push(k);
    for (const k of next) {
      if (seen.has(k)) continue;
      seen.add(k);
      k.onScreen = true;
      queue.push(k);
    }
  }
  const unitRep = coverageByFile.unit.size > 0;
  const unitOf = (x) => {
    const r = coverageByFile.unit.get(x.abs);
    if (!unitRep) return x.specCases > 0 ? 'spec' : 'none';
    if (!r) return 'absent';
    if (!r.lf) return 'n/a';
    const p = (r.lh / r.lf) * 100;
    return p >= UNIT_OK_PCT ? 'covered' : p > 0 ? 'partial' : 'zero';
  };
  for (const x of components.concat(classes)) {
    x.unitLinePct = linePct(coverageByFile.unit.get(x.abs));
    x.unit = unitOf(x);
    x.unitOk = x.unit === 'covered' || x.unit === 'spec';
  }
  for (const c of components) {
    const parts = [];
    if (c.e2eRan) parts.push('ran');
    if (c.e2eRoot) parts.push('root');
    if (c.e2eRoute) parts.push('route');
    if (c.testIdsInE2e) parts.push('testid');
    if (c.e2eSelector) parts.push('selector');
    if (c.hooksInE2e) parts.push('attr');
    if (c.e2eHost) parts.push('host');
    // weaker evidence, in this order: sits on a screen the tests reach; carries a test id the tests use, but shares it with
    // other components; is one of several that could have put a traced component on screen
    c.e2e = parts.join('+') || (c.onScreen ? 'screen' : c.sharedIdsInE2e ? 'shared-id' : c.e2eShared ? 'shared-host' : '');
    c.e2eLevel = parts.length ? 'direct' : c.onScreen || c.sharedIdsInE2e || c.e2eShared ? 'indirect' : 'none';
  }

  // --- numbers
  const screens = routeList.filter(isScreen);
  const tests = e2eStatic.tests;
  const words = tests.map((t) => t.title.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const opNames = Array.from(gqlOps.values());
  for (const o of opNames) o.inE2e = hasE2e && (blob.indexOf('\u0000' + o.name + '\u0000') !== -1 || blob.indexOf(o.type + ' ' + o.name) !== -1 || blob.indexOf('"' + o.name + '"') !== -1);
  const allIds = new Set();
  for (const c of components) for (const id of c.testIdList) allIds.add(id);

  // unit coverage: the report only lists files that a test loaded, so the files it leaves out have to be added back
  let lf = 0;
  let lh = 0;
  let locInReport = 0;
  let absentFiles = 0;
  let absentLoc = 0;
  let runtimeFiles = 0;
  let inReport = 0;
  const tot = { brf: 0, brh: 0, fnf: 0, fnh: 0 };
  for (const [f, r] of fileRecs) {
    const cv = coverageByFile.unit.get(f);
    if (r.runtime) runtimeFiles++;
    if (cv) {
      inReport++;
      lf += cv.lf;
      lh += cv.lh;
      locInReport += r.loc;
      for (const k of Object.keys(tot)) tot[k] += cv[k];
    } else if (r.runtime) {
      absentFiles++;
      absentLoc += r.loc;
    }
  }
  const estAbsent = locInReport ? Math.round((absentLoc * lf) / locInReport) : 0;
  const group = (list) => {
    const withCov = list.filter((x) => coverageByFile.unit.has(x.abs));
    const f = sum(withCov, (x) => coverageByFile.unit.get(x.abs).lf);
    const h = sum(withCov, (x) => coverageByFile.unit.get(x.abs).lh);
    return {
      count: list.length, inReport: withCov.length, linesFound: f, linesHit: h, linePct: f ? Math.round((h / f) * 100) : null,
      none: list.filter((x) => x.unit === 'absent' || x.unit === 'zero' || x.unit === 'none').length,
      partial: list.filter((x) => x.unit === 'partial').length,
      ok: list.filter((x) => x.unitOk).length,
    };
  };
  const byKind = {};
  for (const b of BUCKETS) byKind['components' + b] = group(components.filter((c) => c.bucket === b));
  byKind.services = group(classes.filter((c) => c.kind === 'service'));
  byKind.guardsInterceptorsResolvers = group(classes.filter((c) => c.kind === 'guard' || c.kind === 'interceptor' || c.kind === 'resolver'));
  byKind.effectsAndStores = group(classes.filter((c) => c.kind === 'effects' || c.kind === 'store'));
  byKind.directives = group(classes.filter((c) => c.kind === 'directive'));
  byKind.pipes = group(classes.filter((c) => c.kind === 'pipe'));
  const matrix = {};
  const e2eByBucket = {};
  for (const b of BUCKETS) {
    const list = components.filter((c) => c.bucket === b);
    const e2eAny = (c) => c.e2eLevel !== 'none';
    matrix[b] = {
      count: list.length,
      both: list.filter((c) => c.unitOk && e2eAny(c)).length,
      unitOnly: list.filter((c) => c.unitOk && !e2eAny(c)).length,
      e2eOnly: list.filter((c) => !c.unitOk && e2eAny(c)).length,
      neither: list.filter((c) => !c.unitOk && !e2eAny(c)).length,
      // part of e2eOnly: no unit tests, and the e2e trace is an indirect one only
      indirectOnly: list.filter((c) => !c.unitOk && c.e2eLevel === 'indirect').length,
    };
    e2eByBucket[b] = {
      count: list.length,
      direct: list.filter((c) => c.e2eLevel === 'direct').length,
      indirect: list.filter((c) => c.e2eLevel === 'indirect').length,
      none: list.filter((c) => c.e2eLevel === 'none').length,
    };
  }
  const noCheck = tests.filter((t) => (t.status === 'active' || t.status === 'only') && t.checks === 0);
  Object.assign(testGaps, {
    unitCoverage: {
      reportFound: unitRep,
      reports: coverageReports.filter((r) => r.kind === 'unit').length,
      formats: Array.from(new Set(coverageReports.filter((r) => r.kind === 'unit').map((r) => r.format))),
      applicationFilesWithCode: runtimeFiles,
      filesInReport: inReport,
      lines: { found: lf, hit: lh, pct: lf ? Math.round((lh / lf) * 1000) / 10 : null },
      branches: { found: tot.brf, hit: tot.brh, pct: tot.brf ? Math.round((tot.brh / tot.brf) * 1000) / 10 : null },
      functions: { found: tot.fnf, hit: tot.fnh, pct: tot.fnf ? Math.round((tot.fnh / tot.fnf) * 1000) / 10 : null },
      absentFromReport: { files: absentFiles, loc: absentLoc, estimatedLines: estAbsent },
      adjustedLinePct: lf + estAbsent ? Math.round((lh / (lf + estAbsent)) * 1000) / 10 : null,
      okThresholdPct: UNIT_OK_PCT,
      byKind: byKind,
    },
    e2e: {
      tests: {
        total: tests.length,
        active: tests.filter((t) => t.status === 'active').length,
        skipped: tests.filter((t) => t.status === 'skipped').length,
        pending: tests.filter((t) => t.status === 'pending').length,
        only: tests.filter((t) => t.status === 'only').length,
        parameterised: tests.filter((t) => t.each).length,
        withSteps: tests.filter((t) => t.steps.length).length,
        steps: sum(tests, (t) => t.steps.length),
        noExplicitCheck: noCheck.length,
        noCheckAndNoAction: noCheck.filter((t) => t.actions === 0).length,
      },
      titles: { medianWords: words.length ? words[Math.floor((words.length - 1) / 2)] : null, shorterThan3Words: words.filter((w) => w < 3).length },
      gherkin: { features: e2eStatic.features.length, scenarios: sum(e2eStatic.features, (f) => f.scenarios.length), steps: sum(e2eStatic.features, (f) => sum(f.scenarios, (s) => s.steps.length)), stepDefinitions: e2eStatic.stepDefs },
      networkStubs: e2eStatic.stubs,
      navigation: { visits: nav.visits, urlAssertions: nav.assertions, resolved: nav.resolved, builtAtRunTime: nav.unresolved, matchedARoute: nav.matched, matchedNoRoute: sum(Object.keys(nav.unmatched), (k) => nav.unmatched[k]) },
      routes: { total: routeList.length, unresolvedPaths: routeNotes.unresolvedPaths, lazyNotFollowed: routeNotes.unresolvedLazy, remote: routeNotes.remote, notMounted: routeNotes.unmounted },
      screens: {
        total: screens.length,
        visited: screens.filter((e) => e.e2e === 'visited').length,
        asserted: screens.filter((e) => e.e2e === 'asserted').length,
        ran: screens.filter((e) => e.e2e === 'ran').length,
        byElement: screens.filter((e) => e.e2e === 'element').length,
        undecided: screens.filter((e) => e.e2e === 'shared').length,
        noTrace: screens.filter((e) => !e.e2e).length,
      },
      components: e2eByBucket,
      testIds: {
        inTemplates: allIds.size, sharedByComponents: Array.from(allIds).filter((id) => idOwners.get(id) > 1).length,
        namedInE2e: hasE2e ? Array.from(allIds).filter(idInE2e).length : 0,
        composedInE2e: hasE2e ? Array.from(allIds).filter((id) => idHow(id) === 'composed').length : 0,
        attributes: Object.keys(testIdAttrUse).sort((a, b) => testIdAttrUse[b] - testIdAttrUse[a]).map((a) => ({ name: a, count: testIdAttrUse[a] })),
        attributesTakenFromTheTests: extraTestIdAttrs,
      },
      // element ids, name attributes and form control names: weaker than a test id, but tests select by them too
      otherHandles: {
        inTemplates: hookOwners.size,
        sharedByComponents: Array.from(hookOwners.values()).filter((n) => n > 1).length,
        namedInE2e: hasE2e ? Array.from(hookOwners.keys()).filter((h) => hooksInTests.has(h)).length : 0,
      },
      lookups: {
        distinctSelectors: { byTestIdAttribute: lookups.testId, byComponentTag: lookups.tag, byIdNameOrFormControl: lookups.handle, byCssClass: lookups.cssClass, byOtherAttribute: lookups.otherAttribute },
        otherAttributes: topN(lookups.attributes, 8),
        callsThroughATestIdHelper: e2eStatic.lookups.testIdCalls,
        callsByTextRoleOrLabel: e2eStatic.lookups.textCalls,
      },
      graphqlOperations: { named: opNames.length, anonymous: gqlAnonymous.count, namedInE2e: opNames.filter((o) => o.inE2e).length },
      filesNotReadAsCode: e2eStatic.parseErrors,
    },
    e2eCoverage: e2eRep
      ? (() => {
          let f = 0;
          let h = 0;
          for (const r of coverageByFile.e2e.values()) {
            f += r.lf;
            h += r.lh;
          }
          return { filesInReport: coverageByFile.e2e.size, lines: { found: f, hit: h, pct: f ? Math.round((h / f) * 1000) / 10 : null }, countsFunctions: e2eHasFunctions, componentsRun: components.filter((c) => c.e2eRan).length };
        })()
      : null,
    matrix: matrix,
  });
  testGaps.unmatchedUrls = nav.unmatched; // names: kept out of summary.json
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
  const g = Object.assign({}, testGaps);
  delete g.unmatchedUrls;
  summary.testGaps = g;
  summary.tests.coverageReports = coverageReports.map((r) => ({ path: anon ? undefined : r.path, format: r.format, kind: r.kind, files: r.files, matchedToApplicationFiles: r.matched }));
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
const COMPONENT_COLS = ['project', 'file', 'name', 'selector', 'bucket', 'sizeBucket', 'points', 'reasons', 'routed', 'standalone', 'onPush', 'inlineTemplate', 'totalLoc', 'classLoc', 'tplLoc', 'styleLoc', 'deps', 'inputs', 'outputs', 'queries', 'hostBindings', 'methods', 'hooks', 'subscribes', 'rxPipes', 'signals', 'effects', 'manualCd', 'dispatches', 'navigations', 'httpCalls', 'gqlCalls', 'formControls', 'tplFormBindings', 'ngModel', 'ctrlFlow', 'bindings', 'interpolations', 'childTags', 'ngContent', 'ngTemplate', 'templateOutlet', 'tplPipes', 'cva', 'validator', 'dynamic', 'directDom', 'inheritance', 'animations', 'ownProviders', 'specCases', 'unit', 'unitLinePct', 'e2e', 'testIds', 'testIdsInE2e', 'e2eLinePct'];
const CLASS_COLS = ['project', 'file', 'kind', 'name', 'loc', 'deps', 'methods', 'subscribes', 'rxPipes', 'httpCalls', 'gqlCalls', 'subjects', 'signals', 'dispatches', 'inputs', 'outputs', 'hostListeners', 'detail', 'specCases', 'unit', 'unitLinePct', 'e2eLinePct'];
const ROUTE_COLS = ['project', 'path', 'kind', 'component', 'guarded', 'e2e', 'unit', 'sourceFile'];
const E2E_TEST_COLS = ['file', 'framework', 'suite', 'title', 'status', 'parameterised', 'steps', 'actions', 'checks', 'visits'];
const OPERATION_COLS = ['type', 'name', 'file', 'namedInE2e'];
const routeKind = (e) => (e.node.isRedirect ? 'redirect' : e.node.outlet ? 'outlet' : isScreen(e) ? (e.node.lazyComponent ? 'lazy screen' : 'screen') : e.node.remote ? 'remote' : e.node.lazy ? 'lazy group' : 'group');
const outRoutes = routeList.map((e) => ({
  project: anonId('project', e.node.project),
  path: anon ? anonId('route', e.path) : e.path,
  kind: routeKind(e),
  component: e.comps.length ? displayName('component', e.comps[0]) : anon ? '' : e.node.component,
  guarded: e.node.guarded,
  e2e: e.e2e,
  unit: e.comps.length ? e.comps[0].unit : '',
  sourceFile: anonId('file', relOf(e.node.file)),
}));
const outE2eTests = e2eStatic.tests.map((t) => ({
  file: anonId('e2e-file', t.file), framework: t.framework, suite: anon ? '' : t.suite.join(' > '), title: anon ? '' : t.title, status: t.status,
  parameterised: t.each, steps: t.steps.length, actions: t.actions, checks: t.checks, visits: anon ? t.visits.length : t.visits.join(' '),
}));
const outOperations = Array.from(gqlOps.values())
  .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : 1))
  .map((o) => ({ type: o.type, name: anon ? anonId('operation', o.type + ' ' + o.name) : o.name, file: anonId('file', relOf(o.file)), namedInE2e: !!o.inE2e }));

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
  for (const cv of s.tests.coverage) L.push('Coverage report' + (cv.path ? ' `' + cv.path + '`' : '') + ', totals as reported: lines ' + cvPct(cv.lines) + ', branches ' + cvPct(cv.branches) + ', functions ' + cvPct(cv.functions) + '.');
  const tg = s.testGaps;
  const uc = tg.unitCoverage;
  L.push(
    uc.reportFound
      ? 'Unit-test line coverage of the application files: ' + cvPct(uc.lines.pct) + ' in the report, about ' + cvPct(uc.adjustedLinePct) + ' once the ' + fmt(uc.absentFromReport.files) + ' application file(s) the report leaves out are counted.'
      : 'Unit-test coverage: no coverage report was found (run the tests with coverage first, or pass --coverage).'
  );
  const neither = sum(BUCKETS, (b) => tg.matrix[b].neither);
  L.push('Screens with a trace in the e2e tests: ' + fmt(tg.e2e.screens.total - tg.e2e.screens.noTrace - tg.e2e.screens.undecided) + ' of ' + fmt(tg.e2e.screens.total) + (tg.e2e.screens.undecided ? ' (' + fmt(tg.e2e.screens.undecided) + ' more cannot be decided)' : '') + '. Components with neither unit tests nor an e2e trace: ' + fmt(neither) + ' of ' + fmt(c.count) + ', and ' + fmt(sum(BUCKETS, (b) => tg.matrix[b].indirectOnly)) + ' more with no unit tests and an indirect e2e trace only. The lists are in test-gaps.md.');
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
  L.push('- Unit coverage is read from an existing report, per file. The e2e trace is static: URLs, test ids and selectors found in the test code, matched against routes and templates. See test-gaps.md for what that can and cannot show.');
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * test-gaps.md: what the tests cover, what they miss
 * ------------------------------------------------------------------ */
function buildGapsMarkdown(s) {
  const g = s.testGaps;
  const uc = g.unitCoverage;
  const ee = g.e2e;
  const L = [];
  const h = (t) => L.push('', '## ' + t, '');
  const h3 = (t) => L.push('', '### ' + t, '');
  const pc = (x) => (x === null || x === undefined || x === '' ? 'n/a' : x + '%');
  const share = (a, b) => (b ? pct(a, b) + '%' : 'n/a');
  const more = (list, max) => (list.length > max ? ['', '... and ' + fmt(list.length - max) + ' more, see the CSV files.'] : []);
  const code = (x) => '`' + String(x).replace(/`/g, "'") + '`';
  const cell = (x) => String(x).replace(/\|/g, '\\|');
  const u = s.tests.unit;
  const e = s.tests.e2e;
  const t = ee.tests;

  L.push('# Test safety net: ' + s.target);
  L.push('');
  L.push('Generated ' + s.generatedAt.slice(0, 10) + ' by ng-inventory ' + s.version + '. What the tests cover, what they miss, and where neither kind of test is in place.');

  h('What exists');
  const fw = Object.keys(e.byFramework).map((k) => k + ' ' + fmt(e.byFramework[k].cases));
  const state = [];
  if (t.skipped) state.push(fmt(t.skipped) + ' skipped');
  if (t.pending) state.push(fmt(t.pending) + ' without a body');
  if (t.only) state.push(fmt(t.only) + ' marked .only');
  L.push(
    mdTable(
      ['Kind', 'Files', 'Tests', 'Notes'],
      [
        ['Unit tests', fmt(u.files), fmt(u.cases), u.cases ? 'TestBed-based: ' + share(u.testbed.cases, u.cases) : ''],
        ['End-to-end tests', fmt(e.files), fmt(e.cases), fw.concat(state).join(', ')],
        ['Gherkin scenarios', fmt(e.featureFiles), fmt(e.scenarios), ee.gherkin.stepDefinitions ? fmt(ee.gherkin.stepDefinitions) + ' step definitions' : ''],
      ]
    )
  );

  h('Unit tests: coverage');
  if (!uc.reportFound) {
    L.push('No coverage report was found, so there are no coverage numbers here.');
    L.push('To get them, run the unit tests with coverage once (`ng test --no-watch --code-coverage`, or `jest --coverage`) and run this script again. A report that sits somewhere else can be passed with `--coverage <path>`.');
    L.push('');
    L.push('Until then, "has a spec file next to it with one test or more" stands in for unit coverage:');
    L.push('');
    const rows = [];
    const add = (label, k) => rows.push([label, fmt(uc.byKind[k].count), fmt(uc.byKind[k].ok), fmt(uc.byKind[k].count - uc.byKind[k].ok)]);
    for (const b of BUCKETS) add('Components, bucket ' + b, 'components' + b);
    add('Services', 'services');
    add('Guards, interceptors, resolvers', 'guardsInterceptorsResolvers');
    add('Effects and stores', 'effectsAndStores');
    add('Directives', 'directives');
    add('Pipes', 'pipes');
    L.push(mdTable(['Kind', 'Count', 'With a spec file', 'Without'], rows));
  } else {
    const reps = (s.tests.coverageReports || []).filter((r) => r.kind === 'unit');
    L.push('Read from ' + reps.map((r) => (r.path ? code(r.path) + ' ' : '') + '(' + r.format + ', ' + fmt(r.matchedToApplicationFiles) + ' of ' + fmt(r.files) + ' files matched to application code)').join('; ') + '.');
    L.push('');
    L.push(
      mdTable(
        ['', 'Files', 'Lines', 'Covered', 'Coverage'],
        [
          ['Application files the report lists', fmt(uc.filesInReport), fmt(uc.lines.found), fmt(uc.lines.hit), pc(uc.lines.pct)],
          ['Application files with code that the report does not list', fmt(uc.absentFromReport.files), '~' + fmt(uc.absentFromReport.estimatedLines), '0', '0%'],
          ['All application code (estimate)', fmt(uc.filesInReport + uc.absentFromReport.files), '~' + fmt(uc.lines.found + uc.absentFromReport.estimatedLines), fmt(uc.lines.hit), pc(uc.adjustedLinePct)],
        ]
      )
    );
    L.push('');
    L.push('A coverage report only lists the files that some test loaded. A file no test imports is missing from it, and that makes the reported percentage look better than it is. The second row adds those files back: ' + fmt(uc.absentFromReport.loc) + ' lines of code, converted to coverable lines at the ratio seen in the listed files.');
    L.push('Branches: ' + pc(uc.branches.pct) + ', functions: ' + pc(uc.functions.pct) + ' (files in the report only).');
    L.push('');
    const rows = [];
    const add = (label, k) => {
      const x = uc.byKind[k];
      rows.push([label, fmt(x.count), fmt(x.inReport), pc(x.linePct), fmt(x.none), fmt(x.partial), fmt(x.ok)]);
    };
    for (const b of BUCKETS) add('Components, bucket ' + b, 'components' + b);
    add('Services', 'services');
    add('Guards, interceptors, resolvers', 'guardsInterceptorsResolvers');
    add('Effects and stores', 'effectsAndStores');
    add('Directives', 'directives');
    add('Pipes', 'pipes');
    L.push(mdTable(['Kind', 'Count', 'In the report', 'Line coverage', 'Not covered (0% or not in the report)', 'Below ' + uc.okThresholdPct + '%', uc.okThresholdPct + '% or more'], rows));
    L.push('');
    L.push('Coverage is per file, so for a component it is the coverage of its .ts file; the template is not measured.');
  }

  h('End-to-end tests: what they reach');
  if (!t.total && !ee.gherkin.scenarios) {
    L.push('No end-to-end tests were found. They are looked for in folders named like e2e, e2e-playwright, app-e2e, cypress or playwright, and in files named *.cy.ts, *.e2e.ts or *.e2e-spec.ts.');
  } else {
    L.push('This part is a static trace. The script reads the test code and looks for URLs that are opened or asserted, for test ids (`data-testid`, `data-cy` and the like) and for component selectors. It then matches them against the routes and templates of the application. A test that finds its elements by visible text or by role leaves no trace, so "no trace" means "not shown to be covered", not "not covered".');
    L.push('');
    L.push(
      mdTable(
        ['Tests', 'Count'],
        [
          ['All', fmt(t.total)],
          ['Active', fmt(t.active)],
          ['Skipped (`.skip`, `xit`, `.fixme`, or inside a skipped suite)', fmt(t.skipped)],
          ['Declared without a body', fmt(t.pending)],
          ['Marked `.only`', fmt(t.only)],
          ['Parameterised (`.each`)', fmt(t.parameterised)],
          ['With named steps (`test.step`)', fmt(t.withSteps)],
          ['No explicit check in the test body', fmt(t.noExplicitCheck)],
        ]
      )
    );
    L.push('');
    const nv = ee.navigation;
    L.push('URLs in the test code: ' + fmt(nv.visits) + ' navigations and ' + fmt(nv.urlAssertions) + ' URL assertions. ' + fmt(nv.resolved) + ' could be read, ' + fmt(nv.builtAtRunTime) + ' are built at run time. Of the readable ones, ' + fmt(nv.matchedARoute) + ' match a route and ' + fmt(nv.matchedNoRoute) + ' match none.');
    L.push('Network stubs (`cy.intercept`, `page.route`): ' + fmt(ee.networkStubs) + '.');
    if (ee.filesNotReadAsCode) L.push(fmt(ee.filesNotReadAsCode) + ' test file(s) could not be parsed and were only counted.');

    const lk = ee.lookups;
    const ds = lk.distinctSelectors;
    const traceable = ds.byTestIdAttribute + ds.byComponentTag + ds.byIdNameOrFormControl + lk.callsThroughATestIdHelper;
    const opaque = ds.byCssClass + ds.byOtherAttribute + lk.callsByTextRoleOrLabel;
    if (traceable + opaque > 0) {
      h3('How the tests find their elements');
      L.push(
        'Distinct selectors in the live test code: ' + fmt(ds.byTestIdAttribute) + ' by a test id attribute, ' + fmt(ds.byComponentTag) + ' by the tag of an application component, ' + fmt(ds.byIdNameOrFormControl) +
          ' by an element id, a name or a form control name, ' + fmt(ds.byCssClass) + ' by a CSS class, ' + fmt(ds.byOtherAttribute) + ' by another attribute' +
          (lk.otherAttributes.length ? ' (' + lk.otherAttributes.map((a) => a.name + ' ' + a.count).join(', ') + ')' : '') + '.'
      );
      L.push('Calls in the live test code: ' + fmt(lk.callsThroughATestIdHelper) + ' through a test id helper (`getByTestId` and the like), ' + fmt(lk.callsByTextRoleOrLabel) + ' by visible text, role or label (`contains`, `getByRole`, `getByText` and the like).');
      L.push(
        'Only test ids, component tags, ids, names and form control names can be matched against the templates.' +
          (opaque > traceable ? ' Here most lookups are of the other kinds, so the lists below miss a good part of what the tests reach: read "no trace" with that in mind, or measure with an instrumented run.' : '')
      );
    }

    h3('Screens');
    const sc = ee.screens;
    if (!sc.total) L.push('No routes that render a component were found in the application code.');
    else {
      L.push(
        mdTable(
          ['Screens (routes that render a component)', 'Count', 'Share'],
          [
            ['All', fmt(sc.total), ''],
            ['Opened by a test (direct navigation, or a redirect from one)', fmt(sc.visited), share(sc.visited, sc.total)],
            ['Not opened directly, but a test asserts their URL', fmt(sc.asserted), share(sc.asserted, sc.total)],
          ]
            .concat(g.e2eCoverage ? [['No URL in the tests, but code of the screen ran in the instrumented e2e run', fmt(sc.ran), share(sc.ran, sc.total)]] : [])
            .concat([
              ['No URL in the tests, but a test uses a test id or a selector that only this screen can put on the page', fmt(sc.byElement), share(sc.byElement, sc.total)],
              ['Cannot be decided: the tests use a component or a test id that this screen shares with other screens', fmt(sc.undecided), share(sc.undecided, sc.total)],
              ['No trace', fmt(sc.noTrace), share(sc.noTrace, sc.total)],
            ])
        )
      );
      L.push('');
      L.push('"Only this screen" covers the screen itself, a screen below it, and a component that nothing else in the application uses. The same component under two paths counts for both.');
      const rn = ee.routes;
      const notes = [];
      if (rn.unresolvedPaths) notes.push(fmt(rn.unresolvedPaths) + ' route path(s) are built from something the script could not resolve');
      if (rn.lazyNotFollowed) notes.push(fmt(rn.lazyNotFollowed) + ' lazy-loaded route group(s) could not be followed to their routes');
      if (rn.remote) notes.push(fmt(rn.remote) + ' route(s) load a remote microfrontend, whose own routes are not in this code base');
      if (rn.notMounted) notes.push(fmt(rn.notMounted) + ' route(s) sit in arrays that nothing hands to the router, and are left out as dead code');
      if (notes.length) L.push('', 'Limits of the route list: ' + notes.join('; ') + '.');
    }

    h3('Components');
    L.push(
      mdTable(
        ['Bucket', 'Components', 'Direct trace', 'Indirect trace', 'No trace'],
        BUCKETS.map((b) => {
          const x = ee.components[b];
          return [b, fmt(x.count), fmt(x.direct), fmt(x.indirect), fmt(x.none)];
        })
      )
    );
    L.push('');
      L.push('Direct: a test opens or asserts the route of the component, or uses a test id, an element id, a name or the selector that only this component has, or the component is the only one that can put such a component on screen.');
    L.push('Indirect: the component sits on a screen the tests reach, below a component with a direct trace (it may still be behind a condition that no test triggers). Or the trace points at two or three components at once and cannot say which: a test id that several components carry, a child that several components use. A trace that points at more than ' + SHARED_MAX + ' candidates is ignored: it says too little about any one of them.');
    L.push(
      'Test ids in templates: ' + fmt(ee.testIds.inTemplates) + ' (' + fmt(ee.testIds.sharedByComponents) + ' of them used by more than one component); found in the test code: ' + fmt(ee.testIds.namedInE2e) +
        (ee.testIds.composedInE2e ? ', ' + fmt(ee.testIds.composedInE2e) + ' of these put together by a helper from a fixed part and a name (`${entity}DetailsHeading`)' : '') + '.' +
        (ee.testIds.attributes.length ? ' Attributes read as test ids: ' + ee.testIds.attributes.map((a) => code(a.name) + ' ' + fmt(a.count)).join(', ') + (ee.testIds.attributesTakenFromTheTests.length ? ' (' + ee.testIds.attributesTakenFromTheTests.map(code).join(', ') + ' is not a usual name: it was taken from the selectors of the test code)' : '') + '.' : '')
    );
    if (!ee.testIds.inTemplates && t.total) L.push('No test id attribute was found in the templates. If the project marks its elements for tests in another way, the trace below rests on URLs, component tags, ids and names alone.');
    const oh = ee.otherHandles;
    if (oh.inTemplates) L.push('Element ids, names and form control names in templates: ' + fmt(oh.inTemplates) + ' (' + fmt(oh.sharedByComponents) + ' used by more than one component); selected by the test code: ' + fmt(oh.namedInE2e) + '.');
    const go = ee.graphqlOperations;
    if (go.named) L.push('Named GraphQL operations in the application: ' + fmt(go.named) + '; named in the test code (intercepted, mocked or awaited): ' + fmt(go.namedInE2e) + '. An operation can run in a test without being named.');
    if (g.e2eCoverage) L.push('', 'A coverage report from an instrumented e2e run was read as well: ' + fmt(g.e2eCoverage.filesInReport) + ' application files, line coverage ' + pc(g.e2eCoverage.lines.pct) + ', ' + fmt(g.e2eCoverage.componentsRun) + (g.e2eCoverage.componentsRun === 1 ? ' component' : ' components') + ' ran. Those components count as a direct trace.' + (g.e2eCoverage.countsFunctions ? ' A file counts as run when one of its functions ran; lines that run when a file is merely loaded do not count.' : ' The report has no function counts, so a file counts as run when any of its lines ran, and that includes files that were only loaded.'));

    if (!anon) {
      const blank = routeList.filter((r) => isScreen(r) && !r.e2e);
      if (blank.length) {
        h3('Screens with no trace in the e2e tests');
        const seen = new Set();
        const rows = [];
        for (const r of blank) {
          const comp = r.comps[0];
          const key = r.path + '|' + (comp ? comp.name : r.node.component);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push([code(r.path), cell(comp ? comp.name : r.node.component || '(lazy component)'), comp ? comp.bucket : '', comp ? fmt(comp.totalLoc) : '', comp ? (comp.unitLinePct === '' ? comp.unit : comp.unitLinePct + '%') : '']);
        }
        L.push('No test opens these, asserts their URL, or uses a test id or selector of anything that is known to sit on them.');
        L.push('');
        L.push(mdTable(['Path', 'Component', 'Bucket', 'LOC', 'Unit tests'], rows.slice(0, 80)));
        for (const x of more(rows, 80)) L.push(x);
      }
      const open = routeList.filter((r) => isScreen(r) && r.e2e === 'shared');
      if (open.length) {
        h3('Screens the trace cannot decide');
        L.push('The tests use something these screens have, but other screens have it too: the same component under another path, a component that several screens use, a test id that several components carry. A test may reach them or not; look at the tests, or measure with an instrumented run.');
        L.push('');
        const seen = new Set();
        const rows = [];
        for (const r of open) {
          const comp = r.comps[0];
          const key = r.path + '|' + (comp ? comp.name : r.node.component);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push([code(r.path), cell(comp ? comp.name : r.node.component || '(lazy component)'), comp ? comp.bucket : '', comp ? fmt(comp.totalLoc) : '', comp ? (comp.unitLinePct === '' ? comp.unit : comp.unitLinePct + '%') : '']);
        }
        L.push(mdTable(['Path', 'Component', 'Bucket', 'LOC', 'Unit tests'], rows.slice(0, 80)));
        for (const x of more(rows, 80)) L.push(x);
      }
      const un = Object.keys(testGaps.unmatchedUrls)
        .map((k) => [k, testGaps.unmatchedUrls[k]])
        .sort((a, b) => b[1] - a[1]);
      if (un.length) {
        h3('URLs in tests that match no route');
        L.push('Either the route list is incomplete (see the limits above), the application runs under a base path, or the test opens something outside this application.');
        L.push('');
        L.push(un.slice(0, 20).map((x) => code(x[0]) + (x[1] > 1 ? ' x' + x[1] : '')).join(', ') + (un.length > 20 ? ', ...' : ''));
      }
      const ops = Array.from(gqlOps.values()).filter((o) => !o.inE2e);
      if (ops.length && go.named) {
        h3('GraphQL operations the test code does not name');
        L.push(ops.slice(0, 80).map((o) => code(o.type + ' ' + o.name)).join(', ') + (ops.length > 80 ? ', ... (' + fmt(ops.length - 80) + ' more in operations.csv)' : ''));
      }
    }
  }

  h('Where both nets are missing');
  L.push('A component has unit tests here when ' + (uc.reportFound ? 'its file has ' + uc.okThresholdPct + '% line coverage or more' : 'it has a spec file with one test or more (no coverage report was found)') + ', and an e2e trace when it has a direct or an indirect trace.');
  L.push('');
  L.push(
    mdTable(
      ['Bucket', 'Components', 'Unit tests and e2e trace', 'Unit tests only', 'E2E trace only', '... of which indirect only', 'Neither'],
      BUCKETS.map((b) => {
        const x = g.matrix[b];
        return [b, fmt(x.count), fmt(x.both), fmt(x.unitOnly), fmt(x.e2eOnly), fmt(x.indirectOnly), fmt(x.neither) + (x.count ? ' (' + pct(x.neither, x.count) + '%)' : '')];
      })
    )
  );
  L.push('');
  L.push('"Indirect only" is the thin part of the net: no unit tests, and the component is only known to sit on a screen the tests reach. For a cautious count, add that column to "Neither".');
  if (!anon) {
    const rank = { XL: 3, L: 2, M: 1, S: 0 };
    const bare = components.filter((c) => !c.unitOk && c.e2eLevel === 'none').sort((a, b) => rank[b.bucket] - rank[a.bucket] || b.totalLoc - a.totalLoc);
    if (bare.length) {
      h3('Largest components with neither');
      L.push(mdTable(['Component', 'Bucket', 'LOC', 'Unit tests', 'File'], bare.slice(0, 40).map((c) => [cell(c.name), c.bucket, fmt(c.totalLoc), c.unitLinePct === '' ? c.unit : c.unitLinePct + '%', code(c.file)])));
      for (const x of more(bare, 40)) L.push(x);
    }
    const thin = components.filter((c) => !c.unitOk && c.e2eLevel === 'indirect').sort((a, b) => rank[b.bucket] - rank[a.bucket] || b.totalLoc - a.totalLoc);
    if (thin.length) {
      h3('Largest components without unit tests and with an indirect e2e trace only');
      L.push(mdTable(['Component', 'Bucket', 'LOC', 'Unit tests', 'E2E trace', 'File'], thin.slice(0, 20).map((c) => [cell(c.name), c.bucket, fmt(c.totalLoc), c.unitLinePct === '' ? c.unit : c.unitLinePct + '%', c.e2e, code(c.file)])));
      for (const x of more(thin, 20)) L.push(x);
    }
    const svc = classes.filter((c) => (c.kind === 'service' || c.kind === 'effects' || c.kind === 'store' || c.kind === 'guard' || c.kind === 'interceptor' || c.kind === 'resolver') && !c.unitOk).sort((a, b) => b.loc - a.loc);
    if (svc.length) {
      h3('Largest services, stores and guards without unit tests');
      L.push('E2E tests leave no static trace on these classes, so unit tests are the only evidence there is.');
      L.push('');
      L.push(mdTable(['Class', 'Kind', 'LOC', 'Unit tests', 'File'], svc.slice(0, 30).map((c) => [cell(c.name), c.kind, fmt(c.loc), c.unitLinePct === '' ? c.unit : c.unitLinePct + '%', code(c.file)])));
      for (const x of more(svc, 30)) L.push(x);
    }
  } else L.push('', 'The lists behind these numbers are left out in anonymized mode.');

  if (t.total) {
    h('Tests that may protect less than they seem to');
    L.push('- Skipped or without a body: ' + fmt(t.skipped + t.pending) + '. They show up in the test count but never run.');
    L.push('- Marked `.only`: ' + fmt(t.only) + '. While one is in place, the rest of that file or suite does not run.');
    L.push('- No explicit check in the test body: ' + fmt(t.noExplicitCheck) + ', of which ' + fmt(t.noCheckAndNoAction) + ' contain no action either. Many of these delegate to page objects or helpers that do the checking, so look before judging.');
    L.push('- Titles shorter than three words: ' + fmt(ee.titles.shorterThan3Words) + ' (median title length: ' + (ee.titles.medianWords === null ? 'n/a' : ee.titles.medianWords + ' words') + ').');
    if (!anon) {
      const show = (title, list) => {
        if (!list.length) return;
        h3(title);
        for (const x of list.slice(0, 25)) L.push('- ' + cell(x.suite.concat([x.title]).join(' > ')) + ' (' + code(x.file) + ')');
        for (const y of more(list, 25)) L.push(y);
      };
      show('Skipped tests and tests without a body', e2eStatic.tests.filter((x) => x.status === 'skipped' || x.status === 'pending'));
      show('Tests marked .only', e2eStatic.tests.filter((x) => x.status === 'only'));
      show('Tests with no explicit check and no action in their body', e2eStatic.tests.filter((x) => (x.status === 'active' || x.status === 'only') && x.checks === 0 && x.actions === 0));
    }
  }

  h('How to read this, and how to get a firmer answer');
  L.push('- Everything about e2e tests here comes from reading the code, not from running it. A screen in the "no trace" list is a strong hint, not proof: a test that finds its elements by visible text or by role leaves no trace. A screen with a trace was reached by some test; whether that test checks anything there is a separate question.');
  L.push('- A firmer answer is a coverage report from a real e2e run: build the application with Istanbul instrumentation (for Cypress, the `@cypress/code-coverage` plugin collects it; Playwright can collect V8 coverage in Chromium), then run this script with `--e2e-coverage <path to lcov.info>`. The components that ran are then marked in components.csv and count as a direct trace.');
  L.push('- Coverage says which code ran, not that anything was checked. To test the tests, break something on purpose in a few places and see whether a test turns red.');
  L.push('- components.csv has the raw columns: `unit`, `unitLinePct`, `e2e`, `testIds`, `testIdsInE2e`. In `e2e`: `route` (a test opens or asserts its URL), `root` (the root component), `testid` (a test id only this component has), `selector`, `attr` (an element id, a name or a form control name only this component has), `host` (the only component that can put a traced one on screen), `ran` (ran in an instrumented e2e run), then the weaker `screen`, `shared-id` and `shared-host`. routes.csv lists every route with its trace (`visited`, `asserted`, `ran`, `element`, `shared` or nothing), e2e-tests.csv every test.');
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * functional-spec.md: what the e2e tests say the application does
 * ------------------------------------------------------------------ */
function buildSpecMarkdown(s) {
  const tests = e2eStatic.tests;
  const features = e2eStatic.features.filter((f) => f.scenarios.length || f.name);
  if (!tests.length && !features.length) return null;
  const L = [];
  const g = s.testGaps.e2e;
  const esc = (x) => String(x).replace(/([*_`<>|])/g, '\\$1');
  const flags = (t) => {
    const f = [];
    if (t.status === 'skipped') f.push('skipped');
    if (t.status === 'pending') f.push('not written yet');
    if (t.each) f.push('several data sets');
    return f.length ? ' _(' + f.join(', ') + ')_' : '';
  };
  L.push('# What the application does, according to its end-to-end tests: ' + s.target);
  L.push('');
  L.push('Generated ' + s.generatedAt.slice(0, 10) + ' by ng-inventory ' + s.version + ' from ' + fmt(tests.length) + ' test titles in ' + fmt(new Set(tests.map((t) => t.file)).size) + ' test file(s)' + (features.length ? ' and ' + fmt(g.gherkin.scenarios) + ' Gherkin scenario(s) in ' + fmt(features.length) + ' feature file(s)' : '') + '.');
  L.push('');
  L.push('This is the behaviour of the application in the words of the people who wrote the tests: suites become headings, tests become list items. It covers only what has an end-to-end test, and it is as precise as the titles are. Screens that no test mentions are listed at the end.');
  if (g.titles.medianWords !== null) L.push('', 'Title quality: the median title has ' + g.titles.medianWords + ' words; ' + fmt(g.titles.shorterThan3Words) + ' of ' + fmt(tests.length) + ' titles have fewer than three.');

  const byFile = new Map();
  for (const t of tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push(t);
  }
  const humanize = (file) => {
    const base = file.split('/').pop().replace(/\.(cy|e2e-spec|e2e|pw|spec|test)\.(ts|js)$/i, '').replace(/\.(ts|js)$/i, '');
    const words = base.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const opens = new Map(); // file -> paths its live code opens, also outside tests (beforeEach, page objects are per file)
  for (const n of e2eStatic.navs) {
    if (n.kind !== 'visit') continue;
    const segs = urlToSegs(n.raw);
    if (!segs) continue;
    if (!opens.has(n.file)) opens.set(n.file, []);
    const p = '/' + segs.join('/');
    if (opens.get(n.file).indexOf(p) === -1) opens.get(n.file).push(p);
  }
  for (const file of Array.from(byFile.keys()).sort()) {
    // one section per top-level suite of the file; tests outside any suite get a section named after the file
    const groups = new Map();
    for (const t of byFile.get(file)) {
      const top = t.suite[0] || '';
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(t);
    }
    let first = true;
    for (const [top, list] of groups) {
      const title = top || humanize(file) + (groups.size > 1 ? ' (tests outside a suite)' : '');
      L.push('', '## ' + esc(title), '');
      const urls = first ? opens.get(file) || [] : [];
      L.push('`' + file + '` · ' + list[0].framework + ' · ' + fmt(list.length) + (list.length === 1 ? ' test' : ' tests') + (urls.length ? ' · opens ' + urls.slice(0, 6).map((x) => '`' + x + '`').join(', ') + (urls.length > 6 ? ', ...' : '') : ''));
      first = false;
      // tests that sit directly in the suite first, then its nested suites in the order they appear
      const nested = new Map();
      for (const t of list) {
        const key = t.suite.slice(top ? 1 : 0).join('\u0000');
        if (!nested.has(key)) nested.set(key, []);
        nested.get(key).push(t);
      }
      const keys = Array.from(nested.keys()).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0));
      let prev = [];
      for (const key of keys) {
        const sp = key ? key.split('\u0000') : [];
        let common = 0;
        while (common < sp.length && common < prev.length && sp[common] === prev[common]) common++;
        for (let i = common; i < sp.length; i++) {
          if (i === 0) L.push('', '### ' + esc(sp[0]));
          else if (i === 1) L.push('', '#### ' + esc(sp[1]));
          else L.push('', '**' + esc(sp.slice(2, i + 1).join(' › ')) + '**');
        }
        L.push('');
        prev = sp;
        for (const t of nested.get(key)) {
          L.push('- ' + esc(t.title || '(no title)') + flags(t));
          for (const st of t.steps) L.push('  - ' + esc(st));
        }
      }
    }
  }
  for (const f of features.slice().sort((a, b) => (a.file < b.file ? -1 : 1))) {
    L.push('', '## Feature: ' + esc(f.name || f.file), '');
    L.push('`' + f.file + '` · Gherkin · ' + fmt(f.scenarios.length) + (f.scenarios.length === 1 ? ' scenario' : ' scenarios') + (f.tags.length ? ' · ' + f.tags.join(' ') : ''));
    if (f.description.length) L.push('', '> ' + esc(f.description.join(' ')));
    L.push('');
    if (f.background.length) {
      L.push('- **Background**');
      for (const st of f.background) L.push('  - ' + esc(st));
    }
    let rule = '';
    for (const sc of f.scenarios) {
      if (sc.rule !== rule) {
        rule = sc.rule;
        L.push('', '### Rule: ' + esc(rule), '');
      }
      L.push('- **' + esc(sc.name || '(no name)') + '**' + (sc.outline ? ' _(' + (sc.examples ? fmt(sc.examples) + ' examples' : 'outline') + ')_' : '') + (sc.tags.length ? ' ' + sc.tags.join(' ') : ''));
      for (const st of sc.steps) L.push('  - ' + esc(st));
    }
  }
  const blank = routeList.filter((r) => isScreen(r) && !r.e2e);
  if (blank.length) {
    L.push('', '## Screens that no test mentions', '');
    L.push('Routes of the application that render a component and leave no trace in the test code: no test opens them, asserts their URL or addresses anything on them by test id or selector. Their behaviour is not described above.');
    L.push('');
    const seen = new Set();
    let n = 0;
    for (const r of blank) {
      const name = r.comps[0] ? r.comps[0].name : r.node.component || '';
      const key = r.path + '|' + name;
      if (seen.has(key)) continue;
      seen.add(key);
      if (++n <= 150) L.push('- `' + r.path + '`' + (!name ? '' : name.charAt(0) === '(' ? ' ' + name : ' (' + esc(name) + ')'));
    }
    if (n > 150) L.push('- ... and ' + fmt(n - 150) + ' more, see routes.csv');
  }
  const open = routeList.filter((r) => isScreen(r) && r.e2e === 'shared');
  if (open.length) {
    L.push('', '## Screens that a test may or may not reach', '');
    L.push('The tests use a component or a test id that these screens share with other screens, so the test code alone cannot say whether they are described above.');
    L.push('');
    const seen = new Set();
    let n = 0;
    for (const r of open) {
      const name = r.comps[0] ? r.comps[0].name : r.node.component || '';
      const key = r.path + '|' + name;
      if (seen.has(key)) continue;
      seen.add(key);
      if (++n <= 150) L.push('- `' + r.path + '`' + (!name ? '' : name.charAt(0) === '(' ? ' ' + name : ' (' + esc(name) + ')'));
    }
    if (n > 150) L.push('- ... and ' + fmt(n - 150) + ' more, see routes.csv');
  }
  return L.join('\n') + '\n';
}

fs.mkdirSync(opts.out, { recursive: true });
fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(opts.out, 'summary.md'), buildMarkdown(summary));
fs.writeFileSync(path.join(opts.out, 'components.csv'), csv(outComponents, COMPONENT_COLS));
fs.writeFileSync(path.join(opts.out, 'classes.csv'), csv(outClasses, CLASS_COLS));
fs.writeFileSync(path.join(opts.out, 'test-gaps.md'), buildGapsMarkdown(summary));
const written = ['summary.md', 'summary.json', 'components.csv', 'classes.csv', 'test-gaps.md'];
// a file from an earlier run must not survive when this run has nothing for it (or must not show names)
const writeOrRemove = (name, content) => {
  const p = path.join(opts.out, name);
  if (content) {
    fs.writeFileSync(p, content);
    written.push(name);
  } else if (fs.existsSync(p)) fs.unlinkSync(p);
};
writeOrRemove('functional-spec.md', anon ? null : buildSpecMarkdown(summary));
writeOrRemove('routes.csv', outRoutes.length ? csv(outRoutes, ROUTE_COLS) : null);
writeOrRemove('e2e-tests.csv', outE2eTests.length ? csv(outE2eTests, E2E_TEST_COLS) : null);
writeOrRemove('operations.csv', outOperations.length ? csv(outOperations, OPERATION_COLS) : null);

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
      (() => {
        const uc = testGaps.unitCoverage;
        return uc.reportFound
          ? 'Unit coverage (lines): ' + uc.lines.pct + '% in the report, about ' + uc.adjustedLinePct + '% with the ' + fmt(uc.absentFromReport.files) + ' application file(s) the report leaves out'
          : 'Unit coverage: no report found (run the tests with coverage, or pass --coverage <path>)';
      })(),
      (() => {
        const sc = testGaps.e2e.screens;
        const m = testGaps.matrix;
        return 'E2E trace: ' + fmt(sc.total - sc.noTrace - sc.undecided) + ' of ' + fmt(sc.total) + ' screens' + (sc.undecided ? ' (' + fmt(sc.undecided) + ' undecided)' : '') + '; components with neither unit tests nor e2e trace: ' + fmt(sum(BUCKETS, (b) => m[b].neither)) + ' of ' + fmt(c.count) + ' (XL ' + m.XL.neither + ', L ' + m.L.neither + '), indirect e2e trace only: ' + fmt(sum(BUCKETS, (b) => m[b].indirectOnly));
      })(),
      agg.misc.parseErrors ? 'Files that could not be analysed: ' + agg.misc.parseErrors : '',
      'Report written to ' + opts.out + ' in ' + (summary.environment.durationMs / 1000).toFixed(1) + 's: ' + written.join(', '),
    ]
      .filter(Boolean)
      .join('\n')
  );
}
