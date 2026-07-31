#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: 'PLAYWRIGHT_NOT_FOUND',
    message: 'Playwright is unavailable. Load the Codex workspace dependencies and run this script with their Node executable and NODE_PATH.',
  }, null, 2));
  process.exit(2);
}

const VERSION = '0.5.0';
const SKILL_ROOT = path.resolve(__dirname, '..');
const DATA_ENDPOINT = /\/batchedDataV2\?/;
const REPORT_ENDPOINT = /\/getReport\?/;
const SCHEMA_ENDPOINT = /\/getSchema\?/;
const REPORT_URL_RE = /^https:\/\/(?:lookerstudio|datastudio)\.google\.com\/(?:u\/\d+\/)?reporting\/([A-Za-z0-9_-]+)(?:\/page\/([A-Za-z0-9_-]+))?/i;
const NON_DATA_TYPE_RE = /(shape|description|image|filter|daterange|date-range|control|slider|navigation|button|text)/i;

function fail(code, message, details = undefined, exitCode = 1) {
  const payload = { ok: false, code, message };
  if (details !== undefined) payload.details = details;
  console.error(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = { _: [], filter: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    }
    if (value === undefined) value = true;
    if (key === 'filter') result.filter.push(String(value));
    else result[key] = value;
  }
  return result;
}

function defaultProfileDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Codex', 'looker-studio-data', 'google-profile');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Codex', 'looker-studio-data', 'google-profile');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'codex', 'looker-studio-data', 'google-profile');
}

function defaultAuthStatePath(profileDir = defaultProfileDir()) {
  return path.join(path.dirname(profileDir), 'auth-state.json');
}

function defaultLoginStatePath(profileDir = defaultProfileDir()) {
  return path.join(path.dirname(profileDir), 'login-state.json');
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const directories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of directories) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

function browserCandidates(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
      { kind: 'chrome', path: path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
      { kind: 'edge', path: path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge') },
      { kind: 'chromium', path: path.join(os.homedir(), 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium') },
    ];
  }
  if (platform === 'win32') {
    return [
      { kind: 'chrome', path: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'chrome', path: path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'chrome', path: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'edge', path: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { kind: 'edge', path: path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { kind: 'edge', path: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    ];
  }
  return [
    { kind: 'chrome', path: '/usr/bin/google-chrome' },
    { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge-stable' },
    { kind: 'chromium', path: '/usr/bin/chromium' },
    { kind: 'chromium', path: '/usr/bin/chromium-browser' },
  ];
}

function detectBrowserExecutable(override, preferred = 'auto') {
  if (override) {
    const candidate = path.resolve(String(override));
    if (!isExecutable(candidate)) {
      fail('BROWSER_NOT_FOUND', 'The supplied browser path is not an executable file.', { browser: candidate });
    }
    return { kind: preferred === 'auto' ? 'custom' : preferred, executablePath: candidate };
  }
  const supported = ['auto', 'chrome', 'edge', 'chromium'];
  if (!supported.includes(preferred)) {
    fail('INVALID_BROWSER', '--browser must be auto, chrome, edge, or chromium.');
  }
  const installed = browserCandidates().find((candidate) =>
    (preferred === 'auto' || candidate.kind === preferred) && isExecutable(candidate.path));
  if (installed) return { kind: installed.kind, executablePath: installed.path };

  const pathNames = preferred === 'auto'
    ? ['google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge', 'microsoft-edge-stable', 'msedge', 'chromium', 'chromium-browser']
    : preferred === 'chrome'
      ? ['google-chrome', 'google-chrome-stable', 'chrome']
      : preferred === 'edge'
        ? ['microsoft-edge', 'microsoft-edge-stable', 'msedge']
        : ['chromium', 'chromium-browser'];
  const pathMatch = findOnPath(pathNames);
  if (pathMatch) return { kind: preferred === 'auto' ? 'system' : preferred, executablePath: pathMatch };

  if (preferred === 'auto' || preferred === 'chromium') {
    const bundled = chromium.executablePath();
    if (isExecutable(bundled)) return { kind: 'playwright-chromium', executablePath: bundled };
  }
  return null;
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function writePrivateFile(filePath, contents) {
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function writePrivateJson(filePath, value) {
  writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeName(value) {
  const normalized = String(value || 'data')
    .normalize('NFKC')
    .replace(/[\/\\:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || 'data').slice(0, 120);
}

function stripXssi(text) {
  return String(text).replace(/^\)\]\}'\s*/, '');
}

function parseJsonResponse(text, endpoint) {
  try {
    return JSON.parse(stripXssi(text));
  } catch (error) {
    throw new Error(`${endpoint} returned non-JSON or changed its anti-XSSI envelope: ${error.message}`);
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeReportUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['lookerstudio.google.com', 'datastudio.google.com'].includes(parsed.hostname)) {
    fail('INVALID_URL', 'Only lookerstudio.google.com or datastudio.google.com report URLs are supported.');
  }
  const match = rawUrl.match(REPORT_URL_RE);
  if (!match) fail('INVALID_URL', 'The URL is not a Looker Studio report or report page URL.');
  parsed.hostname = 'datastudio.google.com';
  parsed.hash = '';
  return { url: parsed.toString(), reportId: match[1], pageSlug: match[2] || null };
}

async function launchProfileContext(profileDir, headed, args = {}) {
  ensurePrivateDir(profileDir);
  const choice = String(args.browser || 'auto').toLowerCase();
  const browser = detectBrowserExecutable(args['browser-path'] || args.chrome, choice);
  if (!browser) {
    fail('BROWSER_NOT_FOUND', 'No supported browser runtime was found. Use an available Chrome, Edge, or Chromium executable, or install Playwright Chromium.');
  }
  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: browser.executablePath,
      headless: !headed,
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
      locale: 'zh-CN',
      viewport: headed ? null : { width: 1440, height: 1000 },
    });
    context._lookerBrowserKind = browser.kind;
    return context;
  } catch (error) {
    const message = String(error && error.message || error);
    if (/profile|Singleton|locked|in use/i.test(message)) {
      fail('PROFILE_IN_USE', 'The dedicated Looker Studio browser profile is already open. Close that window and retry.', { profile: profileDir });
    }
    throw error;
  }
}

function resolveAuthStatePath(args, profileDir, requireExisting = false) {
  const authStatePath = path.resolve(String(args['auth-state'] || args._manifestAuthState || defaultAuthStatePath(profileDir)));
  if (requireExisting && !fs.existsSync(authStatePath)) {
    fail('AUTH_STATE_MISSING', 'The reusable Google auth-state file is missing. Initialize it locally with login, then pass it with --auth-state.', {
      auth_state: authStatePath,
    });
  }
  return authStatePath;
}

function loadLoginStateManifest(args, allowMissing = false) {
  if (!args['login-state']) return;
  const manifestPath = path.resolve(String(args['login-state']));
  if (allowMissing && !fs.existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail('LOGIN_STATE_INVALID', 'The login-state manifest is missing or invalid JSON.', {
      login_state: manifestPath,
      message: error.message,
    });
  }
  if (manifest.kind !== 'looker-studio-google-session' || !manifest.profile) {
    fail('LOGIN_STATE_INVALID', 'The login-state manifest has an unsupported schema.', { login_state: manifestPath });
  }
  if (!args.profile) args.profile = manifest.profile;
  if (!args['auth-state'] && manifest.auth_state) args._manifestAuthState = manifest.auth_state;
  if (!args.browser && ['chrome', 'edge', 'chromium'].includes(manifest.browser)) args.browser = manifest.browser;
  args._loginStateManifest = manifestPath;
}

function writeLoginStateManifest(manifestPath, profile, authStatePath, verifiedUrl, browserKind = 'auto') {
  const browser = browserKind === 'playwright-chromium'
    ? 'chromium'
    : ['chrome', 'edge', 'chromium'].includes(browserKind) ? browserKind : 'auto';
  writePrivateJson(manifestPath, {
    schema_version: 1,
    kind: 'looker-studio-google-session',
    binding: 'same_device',
    preferred_auth_source: 'profile',
    created_at: new Date().toISOString(),
    verified_url: verifiedUrl,
    profile,
    auth_state: authStatePath,
    browser,
    portable_across_projects_on_this_machine: true,
    portable_across_machines: false,
    contains_credentials: false,
    note: 'This manifest points to sensitive local artifacts. The same-device browser profile is the durable login source.',
  });
}

function validateAuthStateFile(authStatePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
  } catch (error) {
    fail('AUTH_STATE_INVALID', 'The reusable Google auth-state file is unreadable or invalid JSON.', {
      auth_state: authStatePath,
      message: error.message,
    });
  }
  if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins) || parsed.cookies.length === 0) {
    fail('AUTH_STATE_INVALID', 'The reusable Google auth-state file does not contain an authenticated browser state.', {
      auth_state: authStatePath,
    });
  }
}

function authStateSummary(authStatePath) {
  validateAuthStateFile(authStatePath);
  const parsed = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
  const nowSeconds = Date.now() / 1000;
  const googleCookies = parsed.cookies.filter((cookie) => /(^|\.)google\.com$/i.test(cookie.domain || ''));
  const persistentExpiries = googleCookies
    .map((cookie) => Number(cookie.expires))
    .filter((expires) => Number.isFinite(expires) && expires > 0);
  const futureExpiries = persistentExpiries.filter((expires) => expires > nowSeconds);
  return {
    google_cookie_count: googleCookies.length,
    expired_persistent_cookie_count: persistentExpiries.length - futureExpiries.length,
    session_cookie_count: googleCookies.filter((cookie) => Number(cookie.expires) <= 0).length,
    earliest_persistent_cookie_expiry: futureExpiries.length
      ? new Date(Math.min(...futureExpiries) * 1000).toISOString()
      : null,
    latest_persistent_cookie_expiry: futureExpiries.length
      ? new Date(Math.max(...futureExpiries) * 1000).toISOString()
      : null,
    note: 'Cookie expiry timestamps are advisory; Google can revoke or challenge a web session earlier.',
  };
}

async function persistBrowserAuthState(context, authStatePath) {
  ensurePrivateDir(path.dirname(authStatePath));
  const temporaryPath = `${authStatePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await context.storageState({ path: temporaryPath, indexedDB: true });
    try { fs.chmodSync(temporaryPath, 0o600); } catch {}
    validateAuthStateFile(temporaryPath);
    fs.renameSync(temporaryPath, authStatePath);
    try { fs.chmodSync(authStatePath, 0o600); } catch {}
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

async function launchPortableBrowser(args, headed) {
  const choice = String(args.browser || 'auto').toLowerCase();
  const browser = detectBrowserExecutable(args['browser-path'] || args.chrome, choice);
  if (!browser) {
    fail('BROWSER_NOT_FOUND', 'No supported browser runtime was found. Use an available Chrome, Edge, or Chromium executable, or install Playwright Chromium.');
  }
  return chromium.launch({ executablePath: browser.executablePath, headless: !headed });
}

async function launchAuthorizedContext(args, profileDir, headed) {
  const authStatePath = resolveAuthStatePath(args, profileDir);
  if (args['auth-state']) {
    validateAuthStateFile(authStatePath);
    const browser = await launchPortableBrowser(args, headed);
    try {
      const context = await browser.newContext({
        storageState: authStatePath,
        locale: 'zh-CN',
        viewport: headed ? null : { width: 1440, height: 1000 },
      });
      context._lookerAuthSource = 'auth_state';
      return context;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
  if (fs.existsSync(profileDir)) {
    const context = await launchProfileContext(profileDir, headed, args);
    context._lookerAuthSource = 'profile';
    return context;
  }
  if (fs.existsSync(authStatePath)) {
    validateAuthStateFile(authStatePath);
    const browser = await launchPortableBrowser(args, headed);
    try {
      const context = await browser.newContext({
        storageState: authStatePath,
        locale: 'zh-CN',
        viewport: headed ? null : { width: 1440, height: 1000 },
      });
      context._lookerAuthSource = 'auth_state';
      return context;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
  fail('AUTH_MISSING', 'No same-device browser profile or reusable auth-state file is available. Run login on this machine first.', {
    profile: profileDir,
    auth_state: authStatePath,
  });
}

async function closeContext(context) {
  const browser = context.browser();
  await context.close().catch(() => {});
  if (browser && browser.isConnected()) await browser.close().catch(() => {});
}

async function primaryPage(context) {
  const pages = context.pages();
  return pages[0] || context.newPage();
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopLoginBrowser(pid) {
  if (!pid || !processExists(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    fail('BROWSER_CLOSE_FAILED', 'The dedicated browser process could not be closed for login verification.', {
      pid,
      message: error.message,
    });
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (processExists(pid)) {
    fail('BROWSER_STILL_RUNNING', 'The dedicated browser process did not close within 10 seconds. Quit that window and run status.', { pid });
  }
}

async function pageAuthState(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const state = await page.evaluate(() => {
    const text = (document.body && document.body.innerText || '').slice(0, 4000);
    const accountButton = Array.from(document.querySelectorAll('[aria-label]'))
      .some((el) => {
        const label = el.getAttribute('aria-label') || '';
        return /(?:Google (?:Account|账号)|用户账号切换)/.test(label) && /@/.test(label);
      })
      || Boolean(document.querySelector('a[href*="SignOutOptions"]'));
    return { text, accountButton };
  }).catch(() => ({ text: '', accountButton: false }));
  const loginRedirect = /accounts\.google\.com|ServiceLogin|signin/i.test(url);
  const denied = /You need access|Request access|您需要访问权限|请求访问权限/.test(state.text);
  const signedNavigation = /\/navigation(?:\/|$)/.test(new URL(url).pathname);
  return {
    authenticated: !loginRedirect && !denied && (state.accountButton || signedNavigation),
    loginRedirect,
    denied,
    url,
    title,
  };
}

function createCaptureState(page) {
  const state = {
    report: null,
    reportRequest: null,
    schemas: new Map(),
    batched: [],
    pending: new Set(),
    errors: [],
  };

  page.on('response', (response) => {
    const url = response.url();
    if (!REPORT_ENDPOINT.test(url) && !SCHEMA_ENDPOINT.test(url) && !DATA_ENDPOINT.test(url)) return;
    const pending = (async () => {
      try {
        const status = response.status();
        const request = response.request();
        const bodyText = await response.text();
        if (status < 200 || status >= 300) {
          state.errors.push({ endpoint: new URL(url).pathname, status });
          return;
        }
        const parsed = parseJsonResponse(bodyText, new URL(url).pathname);
        const headers = await request.allHeaders().catch(() => ({}));
        if (REPORT_ENDPOINT.test(url)) {
          state.report = parsed;
          state.reportRequest = {
            url,
            method: request.method(),
            body: request.postData() || '',
            safeHeaders: {
              'content-type': headers['content-type'] || 'application/json;charset=UTF-8',
              accept: headers.accept,
              encoding: headers.encoding,
              'x-goog-authuser': headers['x-goog-authuser'],
              'x-goog-pageid': headers['x-goog-pageid'],
            },
            referrer: headers.referer || '',
            diagnosticHeaderNames: Object.keys(headers)
              .filter((name) => !/authorization|cookie|token|secret/i.test(name))
              .sort(),
            capturedAt: new Date().toISOString(),
          };
          return;
        }
        if (SCHEMA_ENDPOINT.test(url)) {
          let requestBody = {};
          try { requestBody = JSON.parse(request.postData() || '{}'); } catch {}
          if (requestBody.datasourceId) state.schemas.set(requestBody.datasourceId, parsed);
          return;
        }
        let requestBody;
        try { requestBody = JSON.parse(request.postData() || '{}'); } catch {
          state.errors.push({ endpoint: '/batchedDataV2', status, issue: 'request_body_not_json' });
          return;
        }
        state.batched.push({
          url,
          request: requestBody,
          response: parsed,
          safeHeaders: {
            accept: headers.accept,
            encoding: headers.encoding,
            'x-goog-authuser': headers['x-goog-authuser'],
            'x-goog-pageid': headers['x-goog-pageid'],
          },
          referrer: headers.referer || '',
          capturedAt: new Date().toISOString(),
        });
      } catch (error) {
        state.errors.push({ endpoint: new URL(url).pathname, issue: String(error.message || error) });
      }
    })();
    state.pending.add(pending);
    pending.finally(() => state.pending.delete(pending));
  });
  return state;
}

async function waitForCapture(state, timeoutMs, requireData = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.report && (!requireData || state.batched.length)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await Promise.allSettled([...state.pending]);
}

function reportShareable(report) {
  return report && report.reportConfig && report.reportConfig.shareable || {};
}

function reportPages(report) {
  const config = report && report.reportConfig || {};
  const navNames = new Map();
  for (const item of config.navigationInfo && config.navigationInfo.navItems || []) {
    const page = item.page || {};
    if (page.pageId) navNames.set(String(page.pageId), page.displayName || '');
  }
  return (config.page || []).map((entry, index) => {
    const page = entry.page || {};
    const pageId = String(entry.pageId || '');
    const name = navNames.get(pageId)
      || page.attributeConfig && page.attributeConfig.pageAttribute && page.attributeConfig.pageAttribute.name
      || `Page ${index + 1}`;
    return {
      id: pageId,
      name,
      position: entry.position,
      components: page.componentConfig || [],
    };
  });
}

function schemaFieldMaps(schemas) {
  const result = new Map();
  for (const [datasourceId, payload] of schemas.entries()) {
    const fields = new Map();
    const schema = payload && payload.schema || {};
    for (const field of [...(schema.dimensions || []), ...(schema.metrics || [])]) {
      if (!field.name) continue;
      fields.set(field.name, {
        name: field.displayName || field.fieldName && field.fieldName.label || field.name,
        dataType: field.underlyingConnectorDataType || field.dataType,
        conceptType: field.conceptType,
      });
    }
    result.set(datasourceId, fields);
  }
  return result;
}

function responseDatasetSummary(dataResponse) {
  const subsets = dataResponse && dataResponse.dataSubset || [];
  const tables = [];
  for (const subset of subsets) {
    const table = subset && subset.dataset && subset.dataset.tableDataset;
    if (!table) continue;
    tables.push({
      totalCount: Number(table.totalCount ?? table.size ?? 0),
      returnedRows: Number(table.size ?? inferTableSize(table)),
      columns: (table.columnInfo || []).map((column) => column.name || ''),
      isTotals: Boolean(subset.isTotals),
      isCompare: Boolean(subset.isCompare),
    });
  }
  const main = tables.find((item) => !item.isTotals && !item.isCompare) || tables[0] || null;
  return { main, subsets: tables };
}

function componentTracePriority(request, responseSummary) {
  const role = normalizeText(request && request.role).toLowerCase();
  const rolePriority = role === 'row0' ? 3 : !role ? 2 : /total/.test(role) ? 1 : 2;
  const returnedRows = Number(responseSummary && responseSummary.main && responseSummary.main.returnedRows || 0);
  return rolePriority * 1_000_000_000 + Math.min(Math.max(returnedRows, 0), 999_999_999);
}

function inferTableSize(table) {
  let maximum = 0;
  for (const column of table.column || []) {
    const nulls = Array.isArray(column.nullIndex)
      ? column.nullIndex.length
      : Array.isArray(column.nullIndex && column.nullIndex.values) ? column.nullIndex.values.length : 0;
    const container = Object.values(column).find((value) => value && Array.isArray(value.values));
    maximum = Math.max(maximum, (container && container.values.length || 0) + nulls);
  }
  return maximum;
}

function componentTraces(state, fieldMaps) {
  const result = new Map();
  for (const batch of state.batched) {
    const requests = batch.request && batch.request.dataRequest || [];
    const responses = batch.response && batch.response.dataResponse || [];
    requests.forEach((request, index) => {
      const context = request && request.requestContext && request.requestContext.reportContext || {};
      const componentId = context.componentId;
      if (!componentId) return;
      const datasetSpec = request.datasetSpec || {};
      const datasourceId = datasetSpec.dataset && datasetSpec.dataset[0] && datasetSpec.dataset[0].datasourceId || null;
      const sourceMap = fieldMaps.get(datasourceId) || new Map();
      const fields = (datasetSpec.queryFields || []).map((field) => {
        const sourceField = field.dataTransformation && field.dataTransformation.sourceFieldName || field.sourceFieldName || field.name;
        const schemaField = sourceMap.get(sourceField);
        return {
          name: schemaField && schemaField.name || sourceField || field.name,
          source_field: sourceField,
          query_alias: field.name,
          data_type: schemaField && schemaField.dataType,
        };
      });
      const responseSummary = responseDatasetSummary(responses[index]);
      const trace = {
        componentId,
        pageId: context.pageId || null,
        displayType: context.displayType || null,
        datasourceId,
        fields,
        endpoint: batch.url,
        safeHeaders: batch.safeHeaders,
        referrer: batch.referrer,
        request,
        response: responses[index],
        responseSummary,
        capturedAt: batch.capturedAt,
      };
      const previous = result.get(componentId);
      if (!previous
        || componentTracePriority(request, responseSummary) >= componentTracePriority(previous.request, previous.responseSummary)) {
        result.set(componentId, trace);
      }
    });
  }
  return result;
}

async function inspectDom(page, includeFilterValues) {
  const components = await page.evaluate(() => Array.from(document.querySelectorAll('.lego-component')).slice(0, 400).map((element) => {
    const classes = String(element.className || '').split(/\s+/);
    const id = classes.find((value) => /^cd-/.test(value)) || '';
    const type = classes.find((value) => value !== 'lego-component' && value !== 'small-layout' && !/^cd-/.test(value)) || '';
    const shell = element.closest('.cdk-drag') || element.parentElement || element;
    const titleNodes = shell.querySelectorAll('[class*="title"], ng2-component-header, .component-title, .chart-title');
    const titles = Array.from(titleNodes).map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      id,
      type,
      title: titles[0] || '',
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }).filter((item) => item.id));

  const byId = new Map(components.map((item) => [item.id, item]));
  const filters = [];
  for (const component of components.filter((item) => /filter|daterange|date-range|slider/i.test(item.type))) {
    const filter = {
      component_id: component.id,
      type: component.type,
      label: component.text.replace(/[▼▾]\s*$/, '').replace(/^calendar_today\s*/, '').trim(),
      current_value: component.text,
      values_preview: [],
      values_preview_complete: false,
    };
    if (includeFilterValues && /dimension-filter/i.test(component.type)) {
      const shell = page.locator(`.${component.id}`);
      const buttons = shell.locator('button');
      if (await buttons.count() === 1) {
        try {
          await buttons.click({ timeout: 5000 });
          await page.waitForTimeout(350);
          const visible = page.locator('[role="checkbox"]:visible, [role="option"]:visible');
          const optionCount = await visible.count();
          const preview = [];
          for (let i = 0; i < Math.min(optionCount, 100); i += 1) {
            const option = visible.nth(i);
            const text = normalizeText(await option.innerText().catch(() => ''));
            if (!text) continue;
            preview.push({
              value: text,
              selected: ['true', 'checked'].includes(String(await option.getAttribute('aria-checked') || await option.getAttribute('aria-selected') || '')),
            });
          }
          filter.values_preview = preview;
          filter.values_preview_complete = false;
          await page.keyboard.press('Escape');
          await page.waitForTimeout(100);
        } catch (error) {
          filter.preview_error = String(error.message || error).split('\n')[0];
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    }
    filters.push(filter);
  }
  return { components, byId, filters };
}

function componentFieldsFromConfig(component, fieldMaps) {
  const sourceMap = fieldMaps.get(component.datasourceId) || new Map();
  const seen = new Set();
  const result = [];
  for (const concept of component.conceptDefs || []) {
    const transformation = concept.queryTimeTransformation || {};
    const data = transformation.dataTransformation || {};
    const source = data.sourceFieldName || concept.name;
    const schemaField = sourceMap.get(source);
    const display = transformation.displayTransformation && transformation.displayTransformation.displayName;
    const key = `${source}:${display || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: display || schemaField && schemaField.name || source,
      source_field: source,
      query_alias: concept.name,
      data_type: schemaField && schemaField.dataType,
    });
  }
  return result;
}

function buildCatalog({ normalized, state, dom, catalogPath, capturePath }) {
  const shareable = reportShareable(state.report);
  const pages = reportPages(state.report);
  const fieldMaps = schemaFieldMaps(state.schemas);
  const traces = componentTraces(state, fieldMaps);
  const currentPageId = [...traces.values()].find((trace) => trace.pageId)?.pageId || null;
  const currentPage = pages.find((page) => page.id === currentPageId) || null;
  const domById = dom.byId;
  const datasets = [];
  const captureComponents = {};

  for (const page of pages) {
    for (const component of page.components) {
      const type = component.type || '';
      const isData = Boolean(component.datasourceId || component.conceptDefs && component.conceptDefs.length)
        && !NON_DATA_TYPE_RE.test(type);
      if (!isData) continue;
      const trace = traces.get(component.componentId);
      const domComponent = domById.get(component.componentId);
      const fields = trace && trace.fields.length ? trace.fields : componentFieldsFromConfig(component, fieldMaps);
      const onCurrentPage = currentPageId && page.id === currentPageId;
      let status = 'open_page_to_capture';
      let reason = 'Open this report page and catalog it to capture the component request.';
      if (shareable.downloadable === false) {
        status = 'blocked_by_owner';
        reason = 'The report owner disabled downloading.';
      } else if (trace) {
        status = 'ready';
        reason = 'Authenticated data request captured.';
      } else if (onCurrentPage) {
        status = 'metadata_only';
        reason = 'No data request was observed for this component.';
      }
      const title = domComponent && domComponent.title || fields.map((field) => field.name).slice(0, 2).join(' / ') || component.componentId;
      datasets.push({
        page_id: page.id,
        page_name: page.name,
        component_id: component.componentId,
        title,
        type,
        datasource_id: component.datasourceId || trace && trace.datasourceId || null,
        fields,
        row_summary: trace && trace.responseSummary || null,
        status,
        reason,
      });
      if (trace) {
        captureComponents[component.componentId] = {
          component_id: component.componentId,
          title,
          type,
          page_id: page.id,
          page_name: page.name,
          endpoint: trace.endpoint,
          safe_headers: trace.safeHeaders,
          referrer: trace.referrer,
          fields,
          request: trace.request,
          captured_at: trace.capturedAt,
        };
      }
    }
  }

  const catalog = {
    schema_version: 1,
    collector_version: VERSION,
    generated_at: new Date().toISOString(),
    source_url: normalized.url,
    report: {
      id: shareable.id || normalized.reportId,
      name: shareable.name || '',
      downloadable: shareable.downloadable === true,
      copyable: shareable.copyable === true,
      editable: shareable.editable === true,
      is_owner: shareable.isOwner === true,
    },
    current_page: currentPage ? { id: currentPage.id, name: currentPage.name } : null,
    pages: pages.map((page) => ({ id: page.id, name: page.name, component_count: page.components.length })),
    filters: dom.filters,
    datasets,
    private_capture_file: capturePath,
    security: {
      contains_cookies: false,
      contains_authorization_headers: false,
      file_mode: '0600',
    },
    warnings: state.errors,
  };
  const capture = {
    schema_version: 1,
    collector_version: VERSION,
    generated_at: catalog.generated_at,
    source_url: normalized.url,
    report_id: catalog.report.id,
    report_name: catalog.report.name,
    downloadable: catalog.report.downloadable,
    current_page: catalog.current_page,
    report_request: state.reportRequest,
    components: captureComponents,
    security: catalog.security,
  };
  return { catalog, capture, catalogPath };
}

function resolveCatalogPaths(normalized, outArg) {
  if (outArg) {
    const catalogPath = path.resolve(String(outArg));
    const ext = path.extname(catalogPath);
    const stem = ext ? catalogPath.slice(0, -ext.length) : catalogPath;
    return { catalogPath, capturePath: `${stem}.capture.json` };
  }
  const directory = path.join(os.homedir(), 'Downloads', 'looker-studio-data', normalized.reportId, nowStamp());
  return {
    catalogPath: path.join(directory, 'catalog.json'),
    capturePath: path.join(directory, 'catalog.capture.json'),
  };
}

async function runDoctor(args) {
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const authStatePath = resolveAuthStatePath(args, profile);
  const loginStatePath = path.resolve(String(args._loginStateManifest || defaultLoginStatePath(profile)));
  const choice = String(args.browser || 'auto').toLowerCase();
  const detectedBrowser = detectBrowserExecutable(args['browser-path'] || args.chrome, choice);
  ensurePrivateDir(profile);
  console.log(JSON.stringify({
    ok: true,
    version: VERSION,
    node: process.version,
    platform: process.platform,
    playwright: true,
    browser_choice: choice,
    detected_browser: detectedBrowser,
    interactive_login_supported: Boolean(detectedBrowser),
    profile,
    profile_mode: (fs.statSync(profile).mode & 0o777).toString(8),
    auth_state: authStatePath,
    auth_state_exists: fs.existsSync(authStatePath),
    auth_state_mode: fs.existsSync(authStatePath) ? (fs.statSync(authStatePath).mode & 0o777).toString(8) : null,
    login_state: loginStatePath,
    login_state_exists: fs.existsSync(loginStatePath),
    portable_browser: args.browser || 'auto',
  }, null, 2));
}

async function runLogin(args) {
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const authStatePath = resolveAuthStatePath(args, profile);
  const loginStatePath = path.resolve(String(args['login-state'] || defaultLoginStatePath(profile)));
  const choice = String(args.browser || 'auto').toLowerCase();
  const loginBrowser = detectBrowserExecutable(args['browser-path'] || args.chrome, choice);
  if (!loginBrowser) {
    fail('BROWSER_NOT_FOUND', 'No supported login browser was found. Use an available Chrome, Edge, or Chromium executable, or install Playwright Chromium.');
  }
  ensurePrivateDir(profile);
  const startUrl = 'https://datastudio.google.com/';
  const browser = childProcess.spawn(loginBrowser.executablePath, [
    `--user-data-dir=${profile}`,
    startUrl,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  browser.once('error', (error) => {
    fail('BROWSER_LAUNCH_FAILED', 'The login browser window could not be opened.', { message: error.message });
  });
  browser.unref();
  console.log(JSON.stringify({
    ok: true,
    login_method: 'same_device_browser',
    action_required: 'Complete Google sign-in in the opened browser window. When Looker Studio is visible, leave that window open and press Enter here; the skill will close only this dedicated process before verification.',
    profile,
    browser: loginBrowser,
  }, null, 2));
  await waitForEnter('\nWhen Looker Studio is visible, leave the dedicated browser window open and press Enter to verify the login state... ');
  await stopLoginBrowser(browser.pid);

  const context = await launchProfileContext(profile, false, args);
  try {
    const page = await primaryPage(context);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    const state = await pageAuthState(page);
    if (!state.authenticated) {
      fail('LOGIN_NOT_CONFIRMED', 'Looker Studio is not authenticated yet.', { url: state.url, title: state.title });
    }
    ensurePrivateDir(path.dirname(authStatePath));
    await persistBrowserAuthState(context, authStatePath);
    const metadataPath = `${authStatePath}.meta.json`;
    writePrivateJson(metadataPath, {
      schema_version: 1,
      collector_version: VERSION,
      created_at: new Date().toISOString(),
      verified_url: state.url,
      login_method: 'same_device_browser',
      browser: loginBrowser.kind,
      auth_state: authStatePath,
      contains_credentials: false,
      portable_across_projects_on_this_machine: true,
      portable_across_machines: false,
      note: 'The adjacent auth-state file contains sensitive reusable cookies and browser storage. Never commit or share it.',
    });
    writeLoginStateManifest(loginStatePath, profile, authStatePath, state.url, loginBrowser.kind);
    console.log(JSON.stringify({
      ok: true,
      authenticated: true,
      login_method: 'same_device_browser',
      browser: loginBrowser.kind,
      profile,
      login_state: loginStatePath,
      auth_state: authStatePath,
      auth_state_metadata: metadataPath,
      portable_across_projects_on_this_machine: true,
      portable_across_machines: false,
      warning: 'The auth-state file can impersonate the signed-in account. Transfer only through an approved secret channel; never attach, commit, or share it.',
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

async function runAuthExport(args) {
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const authStatePath = resolveAuthStatePath(args, profile);
  const loginStatePath = path.resolve(String(args['login-state'] || defaultLoginStatePath(profile)));
  if (!fs.existsSync(profile)) {
    fail('PROFILE_MISSING', 'The local browser login profile is missing. Run login first.', { profile });
  }
  const context = await launchProfileContext(profile, false, args);
  try {
    const page = await primaryPage(context);
    await page.goto('https://datastudio.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    const state = await pageAuthState(page);
    if (!state.authenticated) {
      fail('LOGIN_NOT_CONFIRMED', 'The local browser profile is not authenticated. Run login first.', {
        url: state.url,
        title: state.title,
      });
    }
    await persistBrowserAuthState(context, authStatePath);
    writeLoginStateManifest(loginStatePath, profile, authStatePath, state.url, context._lookerBrowserKind);
    console.log(JSON.stringify({
      ok: true,
      authenticated: true,
      auth_state: authStatePath,
      login_state: loginStatePath,
      portable_across_projects_on_this_machine: true,
      portable_across_machines: false,
      health: authStateSummary(authStatePath),
      warning: 'This file can impersonate the signed-in account. Store it as a secret and never commit it.',
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

async function runStatus(args) {
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const authStatePath = resolveAuthStatePath(args, profile);
  if (!fs.existsSync(profile) && !fs.existsSync(authStatePath)) {
    console.log(JSON.stringify({
      ok: true,
      authenticated: false,
      reason: 'auth_state_and_profile_missing',
      profile,
      auth_state: authStatePath,
    }, null, 2));
    return;
  }
  const context = await launchAuthorizedContext(args, profile, Boolean(args.headed));
  try {
    const page = await primaryPage(context);
    await page.goto('https://datastudio.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    const state = await pageAuthState(page);
    if (state.authenticated && fs.existsSync(authStatePath)) {
      await persistBrowserAuthState(context, authStatePath);
    }
    if (args['require-authenticated'] && !state.authenticated) {
      fail('AUTH_NOT_VERIFIED', 'Google authentication is not currently verified. Renew the same-device profile with login.', {
        profile,
        auth_state: fs.existsSync(authStatePath) ? authStatePath : null,
      });
    }
    console.log(JSON.stringify({
      ok: true,
      ...state,
      auth_source: context._lookerAuthSource || 'profile',
      auth_state: fs.existsSync(authStatePath) ? authStatePath : null,
      health: fs.existsSync(authStatePath) ? authStateSummary(authStatePath) : null,
      profile,
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

async function runCatalog(args) {
  if (!args.url) fail('MISSING_URL', 'catalog requires --url <Looker Studio URL>.');
  const normalized = normalizeReportUrl(String(args.url));
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const timeoutMs = Math.max(5000, Number(args.timeout || 45000));
  const context = await launchAuthorizedContext(args, profile, Boolean(args.headed));
  try {
    const page = await primaryPage(context);
    const state = createCaptureState(page);
    await page.goto(normalized.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCapture(state, timeoutMs, true);
    const auth = await pageAuthState(page);
    if (auth.loginRedirect) fail('LOGIN_REQUIRED', 'Google login is required or the reusable auth state expired. Initialize it locally with login and redeploy the auth-state file.', {
      profile,
      auth_state: resolveAuthStatePath(args, profile),
    });
    if (auth.denied) fail('ACCESS_DENIED', 'The signed-in Google account does not have access to this report.');
    if (!state.report) fail('REPORT_METADATA_MISSING', 'The report metadata request was not captured. The page may still be loading or Looker Studio changed its endpoint.', state.errors);
    const dom = await inspectDom(page, args['no-filter-values'] !== true);
    const { catalogPath, capturePath } = resolveCatalogPaths(normalized, args.out);
    const built = buildCatalog({ normalized, state, dom, catalogPath, capturePath });
    writePrivateJson(capturePath, built.capture);
    writePrivateJson(catalogPath, built.catalog);
    const authStatePath = resolveAuthStatePath(args, profile);
    if (fs.existsSync(authStatePath)) {
      await persistBrowserAuthState(context, authStatePath);
    }
    console.log(JSON.stringify({
      ok: true,
      catalog: catalogPath,
      private_capture: capturePath,
      report: built.catalog.report,
      current_page: built.catalog.current_page,
      datasets: {
        total: built.catalog.datasets.length,
        ready: built.catalog.datasets.filter((item) => item.status === 'ready').length,
        blocked: built.catalog.datasets.filter((item) => item.status === 'blocked_by_owner').length,
      },
      filters: built.catalog.filters.length,
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

function parseFilterSpec(spec) {
  const eq = spec.indexOf('=');
  if (eq <= 0) fail('INVALID_FILTER', `Invalid --filter "${spec}". Use LABEL=value1|value2 or COMPONENT_ID=value.`);
  const target = spec.slice(0, eq).trim();
  const values = spec.slice(eq + 1).split('|').map((value) => value.trim()).filter(Boolean);
  if (!values.length) fail('INVALID_FILTER', `Filter "${target}" has no selected values.`);
  return { target, values };
}

async function applyDimensionFilter(page, spec) {
  const candidates = await page.locator('.lego-component.dimension-filter').evaluateAll((elements, target) => elements.map((element) => {
    const classes = String(element.className || '').split(/\s+/);
    const id = classes.find((value) => /^cd-/.test(value)) || '';
    const label = (element.textContent || '').replace(/\s+/g, ' ').replace(/[▼▾]\s*$/, '').trim();
    return { id, label, match: id === target || label === target };
  }).filter((item) => item.match), spec.target);
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? `Filter label "${spec.target}" is ambiguous; use one of its component IDs.`
      : `Filter "${spec.target}" was not found on this page.`);
  }
  const component = page.locator(`.${candidates[0].id}`);
  const button = component.locator('button');
  if (await button.count() !== 1) throw new Error(`Filter "${spec.target}" does not expose one semantic menu button.`);
  await button.click();
  await page.waitForTimeout(350);
  const visibleChecks = page.locator('[role="checkbox"]:visible');
  const checkCount = await visibleChecks.count();
  if (!checkCount) throw new Error(`Filter "${spec.target}" opened without checkbox options.`);

  let selectAll = null;
  for (let i = 0; i < checkCount; i += 1) {
    const checkbox = visibleChecks.nth(i);
    const text = normalizeText(await checkbox.innerText().catch(() => ''));
    if (!text || /^(Select all|All|全选|全部)$/i.test(text)) {
      selectAll = checkbox;
      break;
    }
  }
  if (selectAll && await selectAll.getAttribute('aria-checked') === 'true') await selectAll.click();

  const searchInputs = page.locator('input:visible');
  const search = await searchInputs.count() === 1 ? searchInputs : null;
  for (const value of spec.values) {
    if (search) {
      await search.fill(value);
      await page.waitForTimeout(300);
    }
    const options = page.locator('[role="checkbox"]:visible');
    const optionCount = await options.count();
    let exact = null;
    for (let i = 0; i < optionCount; i += 1) {
      const option = options.nth(i);
      if (normalizeText(await option.innerText().catch(() => '')) === value) {
        exact = option;
        break;
      }
    }
    if (!exact) throw new Error(`Value "${value}" is not available in filter "${spec.target}".`);
    if (await exact.getAttribute('aria-checked') !== 'true') await exact.click();
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
}

function parseDateRange(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (!match) fail('INVALID_DATE', '--date must be YYYY-MM-DD:YYYY-MM-DD.');
  if (match[1] > match[2]) fail('INVALID_DATE', 'The date range start must not be after the end.');
  return { start: match[1], end: match[2] };
}

function addIsoDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateInTimeZone(timeZone, date = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    fail('INVALID_TIMEZONE', `Invalid IANA timezone "${timeZone}".`);
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveDateRule(ruleValue, timeZone, fixedValue = null) {
  const rule = String(ruleValue || (fixedValue ? 'fixed' : 'captured')).toLowerCase();
  if (rule === 'captured') return { type: 'captured', timezone: timeZone, range: null };
  if (rule === 'fixed') {
    if (!fixedValue) fail('INVALID_DATE_RULE', 'A fixed date rule requires --date YYYY-MM-DD:YYYY-MM-DD.');
    return { type: 'fixed', timezone: timeZone, range: parseDateRange(fixedValue) };
  }
  const today = dateInTimeZone(timeZone);
  if (rule === 'today') return { type: rule, timezone: timeZone, range: { start: today, end: today } };
  if (rule === 'yesterday') {
    const yesterday = addIsoDays(today, -1);
    return { type: rule, timezone: timeZone, range: { start: yesterday, end: yesterday } };
  }
  const rolling = rule.match(/^last-(\d+)-days$/);
  if (rolling) {
    const days = Number(rolling[1]);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      fail('INVALID_DATE_RULE', 'Rolling date rules must be last-1-days through last-366-days.');
    }
    const end = addIsoDays(today, -1);
    return { type: rule, timezone: timeZone, range: { start: addIsoDays(end, -(days - 1)), end } };
  }
  if (rule === 'month-to-date') {
    return { type: rule, timezone: timeZone, range: { start: `${today.slice(0, 7)}-01`, end: today } };
  }
  if (rule === 'previous-month') {
    const firstThisMonth = `${today.slice(0, 7)}-01`;
    const end = addIsoDays(firstThisMonth, -1);
    return { type: rule, timezone: timeZone, range: { start: `${end.slice(0, 7)}-01`, end } };
  }
  fail('INVALID_DATE_RULE', 'Date rule must be captured, fixed, today, yesterday, last-N-days, month-to-date, or previous-month.');
}

function compactDate(iso) {
  return iso.replace(/-/g, '');
}

function rewriteDateValue(current, iso) {
  if (typeof current === 'string') {
    if (/^\d{8}$/.test(current)) return compactDate(iso);
    if (/^\d{4}-\d{2}-\d{2}$/.test(current)) return iso;
    return current;
  }
  if (current && typeof current === 'object' && ['year', 'month', 'day'].every((key) => key in current)) {
    const [year, month, day] = iso.split('-').map(Number);
    return { ...current, year, month, day };
  }
  return current;
}

function applyDateOverride(request, range) {
  let changed = 0;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      if (/^(startdate|datestart|start_date)$/.test(lower)) {
        const next = rewriteDateValue(value[key], range.start);
        if (next !== value[key]) { value[key] = next; changed += 1; }
      } else if (/^(enddate|dateend|end_date)$/.test(lower)) {
        const next = rewriteDateValue(value[key], range.end);
        if (next !== value[key]) { value[key] = next; changed += 1; }
      } else if (typeof value[key] === 'object') {
        visit(value[key]);
      }
    }
  };
  visit(request.datasetSpec && request.datasetSpec.dateRanges);
  return changed;
}

function captureLatestComponent(state, componentId, fieldMaps) {
  return componentTraces(state, fieldMaps).get(componentId) || null;
}

function traceHasUsableRows(trace) {
  const main = trace && trace.responseSummary && trace.responseSummary.main;
  const role = normalizeText(trace && trace.request && trace.request.role).toLowerCase();
  if (!main || /total/.test(role)) return false;
  return main.returnedRows > 0 || main.totalCount === 0;
}

async function waitForComponentTrace(state, componentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    await Promise.allSettled([...state.pending]);
    latest = captureLatestComponent(state, componentId, schemaFieldMaps(state.schemas));
    if (traceHasUsableRows(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

async function fetchComponentPage(page, endpoint, request, safeHeaders, referrer = '') {
  const result = await page.evaluate(async ({ url, body, headers, requestReferrer }) => {
    const requestHeaders = { 'content-type': 'application/json;charset=UTF-8' };
    if (headers && headers['x-goog-authuser']) requestHeaders['x-goog-authuser'] = headers['x-goog-authuser'];
    if (headers && headers['x-goog-pageid']) requestHeaders['x-goog-pageid'] = headers['x-goog-pageid'];
    if (headers && headers.accept) requestHeaders.accept = headers.accept;
    if (headers && headers.encoding) requestHeaders.encoding = headers.encoding;
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: requestHeaders,
      referrer: requestReferrer || undefined,
      body: JSON.stringify({ dataRequest: [body] }),
    });
    return { status: response.status, text: await response.text() };
  }, { url: endpoint, body: request, headers: safeHeaders || {}, requestReferrer: referrer });
  if (result.status < 200 || result.status >= 300) {
    const detail = normalizeText(stripXssi(result.text)).slice(0, 800);
    throw new Error(`batchedDataV2 replay returned HTTP ${result.status}${detail ? `: ${detail}` : ''}.`);
  }
  return parseJsonResponse(result.text, '/batchedDataV2');
}

function nullIndexes(column) {
  if (Array.isArray(column.nullIndex)) return new Set(column.nullIndex.map(Number));
  if (Array.isArray(column.nullIndex && column.nullIndex.values)) return new Set(column.nullIndex.values.map(Number));
  return new Set();
}

function typedValues(column) {
  for (const [key, value] of Object.entries(column)) {
    if (key === 'nullIndex') continue;
    if (value && Array.isArray(value.values)) return value.values;
  }
  return [];
}

function decodeTable(table, fields) {
  const size = Number(table.size ?? inferTableSize(table));
  const columnInfo = table.columnInfo || [];
  const fieldByAlias = new Map((fields || []).map((field) => [field.query_alias, field]));
  const headers = [];
  const used = new Map();
  for (const info of columnInfo) {
    const field = fieldByAlias.get(info.name);
    let name = field && field.name || info.name || 'column';
    const count = used.get(name) || 0;
    used.set(name, count + 1);
    if (count) name = `${name}_${count + 1}`;
    headers.push(name);
  }
  const expanded = (table.column || []).map((column) => {
    const nulls = nullIndexes(column);
    const values = typedValues(column);
    const output = [];
    let valueIndex = 0;
    for (let row = 0; row < size; row += 1) {
      if (nulls.has(row)) output.push(null);
      else output.push(values[valueIndex++]);
    }
    return output;
  });
  const rows = [];
  for (let row = 0; row < size; row += 1) {
    rows.push(headers.map((_, column) => (expanded[column] ? expanded[column][row] : null) ?? null));
  }
  return { headers, rows, totalCount: Number(table.totalCount ?? size), size };
}

function mainTable(payload) {
  const response = payload && payload.dataResponse && payload.dataResponse[0];
  const subsets = response && response.dataSubset || [];
  let fallback = null;
  for (const subset of subsets) {
    const table = subset && subset.dataset && subset.dataset.tableDataset;
    if (!table) continue;
    if (!fallback) fallback = table;
    if (!subset.isTotals && !subset.isCompare) return table;
  }
  return fallback;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function countCsvDataRows(csv) {
  let rows = 0;
  let hasCell = false;
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        index += 1;
        hasCell = true;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === '\n' && !quoted) {
      if (hasCell) rows += 1;
      hasCell = false;
      continue;
    }
    if (char !== '\r') hasCell = true;
  }
  if (quoted) throw new Error('Downloaded CSV has an unterminated quoted field.');
  if (hasCell) rows += 1;
  if (!rows) throw new Error('Downloaded CSV is empty.');
  return rows - 1;
}

function isReplayRejected(error) {
  return /batchedDataV2 replay returned HTTP (400|401|403)\b/.test(String(error && error.message || error));
}

async function clickVisibleNamedAction(page, labels) {
  const normalized = labels.map((label) => normalizeText(label).toLocaleLowerCase());
  const result = await page.locator('button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="radio"]').evaluateAll((elements, expected) => {
    const visible = (element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const text = (element) => String(element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const matches = elements.filter((element) => visible(element) && expected.includes(text(element)));
    if (matches.length !== 1) {
      return { count: matches.length, available: elements.filter(visible).map(text).filter(Boolean).slice(0, 30) };
    }
    matches[0].click();
    return { count: 1 };
  }, normalized);
  if (result.count !== 1) {
    throw new Error(`Looker Studio download UI is ambiguous or unavailable for ${labels.join(' / ')}. Visible actions: ${result.available.join(' | ')}`);
  }
}

async function hoverVisibleNamedAction(page, labels) {
  const normalized = labels.map((label) => normalizeText(label).toLocaleLowerCase());
  const marker = `looker-native-action-${Date.now()}`;
  const result = await page.locator('button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="radio"]').evaluateAll((elements, input) => {
    const visible = (element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const text = (element) => String(element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const matches = elements.filter((element) => visible(element) && input.expected.includes(text(element)));
    if (matches.length === 1) matches[0].setAttribute('data-looker-native-action', input.marker);
    return { count: matches.length };
  }, { expected: normalized, marker });
  if (result.count !== 1) throw new Error(`Looker Studio download UI is ambiguous or unavailable for ${labels.join(' / ')}.`);
  await page.locator(`[data-looker-native-action="${marker}"]`).hover({ timeout: 5000 });
}

async function ensureNativeCsvSelected(dialog) {
  const result = await dialog.evaluate((element) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const labels = Array.from(element.querySelectorAll('label'));
    const csv = labels.find((label) => normalize(label.textContent) === 'csv');
    if (!csv) return { ok: false, reason: 'CSV option is not available.' };
    const input = element.querySelector(`#${CSS.escape(csv.htmlFor)}`);
    if (!input || input.type !== 'radio') return { ok: false, reason: 'CSV option is not a radio control.' };
    if (!input.checked) csv.click();
    return { ok: input.checked, reason: input.checked ? '' : 'CSV selection did not apply.' };
  });
  if (!result.ok) throw new Error(`Looker Studio native export cannot select CSV: ${result.reason}`);
}

async function downloadNativeCsv(page, component, output) {
  const chart = page.locator(`.lego-component.${component.component_id}`);
  if (await chart.count() !== 1) {
    throw new Error(`Chart "${component.title}" has no unique visible component for native download.`);
  }
  const header = page.locator(`.${component.component_id}-header`);
  if (await header.count() !== 1) {
    throw new Error(`Chart "${component.title}" has no unique page header for native download.`);
  }
  const menu = header.locator('.ng2-chart-menu-button');
  if (await menu.count() !== 1) {
    throw new Error(`Chart "${component.title}" does not expose one native chart menu.`);
  }
  await chart.hover({ timeout: 5000 });
  await menu.click({ timeout: 5000 });
  await page.waitForTimeout(250);
  await hoverVisibleNamedAction(page, ['导出图表…', 'Export chart']);
  await page.waitForTimeout(250);
  await clickVisibleNamedAction(page, ['导出数据', 'Export data']);
  await page.waitForTimeout(250);
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.count() !== 1) throw new Error(`Chart "${component.title}" did not open a native export dialog.`);
  await ensureNativeCsvSelected(dialog);
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await clickVisibleNamedAction(page, ['导出', 'Export']);
  const download = await downloadPromise;
  const filename = String(download.suggestedFilename() || 'download.csv');
  if (!/\.csv$/i.test(filename)) {
    throw new Error(`Chart "${component.title}" downloaded "${filename}", not a CSV file.`);
  }
  ensurePrivateDir(path.dirname(output));
  await download.saveAs(output);
  try { fs.chmodSync(output, 0o600); } catch {}
  const csv = fs.readFileSync(output, 'utf8');
  return {
    rows: countCsvDataRows(csv),
    sha256: crypto.createHash('sha256').update(csv).digest('hex'),
    output,
  };
}

function findCatalogComponent(catalog, selector) {
  const exact = catalog.datasets.filter((item) => item.component_id === selector || item.title === selector);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail('AMBIGUOUS_COMPONENT', `Multiple datasets match "${selector}". Use the component ID.`);
  const partial = catalog.datasets.filter((item) => item.title && item.title.includes(selector));
  if (partial.length === 1) return partial[0];
  fail('COMPONENT_NOT_FOUND', partial.length
    ? `Multiple datasets partially match "${selector}". Use the component ID.`
    : `No dataset matches "${selector}".`);
}

function resolveExportPath(catalog, component, outArg) {
  if (outArg) return path.resolve(String(outArg));
  const directory = path.join(
    os.homedir(),
    'Downloads',
    'looker-studio-data',
    catalog.report.id,
    nowStamp(),
  );
  return path.join(directory, `${safeName(component.title || component.component_id)}.csv`);
}

function resolveRecipePath(catalog, component, recipeOutArg) {
  if (typeof recipeOutArg === 'string') return path.resolve(recipeOutArg);
  const directory = path.join(
    os.homedir(),
    'Downloads',
    'looker-studio-data',
    catalog.report.id,
    'recipes',
  );
  return path.join(directory, `${safeName(component.title || component.component_id)}.recipe.json`);
}

async function runExport(args) {
  if (!args.confirmed) fail('CONFIRMATION_REQUIRED', 'Export requires --confirmed after the user confirms dataset, dates, filters, and destination.');
  if (!args.catalog) fail('MISSING_CATALOG', 'export requires --catalog <catalog.json>.');
  if (!args.component) fail('MISSING_COMPONENT', 'export requires --component <component ID or exact title>.');
  const catalogPath = path.resolve(String(args.catalog));
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!catalog.report || catalog.report.downloadable !== true) {
    fail('DOWNLOAD_DISABLED', 'The report owner disabled downloading; direct replay is blocked.');
  }
  const component = findCatalogComponent(catalog, String(args.component));
  if (component.status !== 'ready') fail('COMPONENT_NOT_READY', component.reason || 'The component request was not captured.');
  const capturePath = path.resolve(String(catalog.private_capture_file || ''));
  if (!fs.existsSync(capturePath)) fail('CAPTURE_MISSING', 'The private request capture referenced by the catalog is missing.', { capture: capturePath });
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const capturedComponent = capture.components && capture.components[component.component_id];
  if (!capturedComponent) fail('CAPTURE_MISSING', 'The selected component has no private request template.');

  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  // One-time export may need the page's own chart-download UI after direct replay is rejected.
  // Keep this context visible so the fallback remains available without a user-facing flag.
  const context = await launchAuthorizedContext(args, profile, true);
  try {
    const page = await primaryPage(context);
    const state = createCaptureState(page);
    await page.goto(catalog.source_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCapture(state, Math.max(5000, Number(args.timeout || 45000)), true);
    const auth = await pageAuthState(page);
    if (auth.loginRedirect) fail('LOGIN_REQUIRED', 'Google login expired. Initialize a fresh auth-state file locally and redeploy it.');
    if (auth.denied) fail('ACCESS_DENIED', 'The signed-in account no longer has access to this report.');

    const appliedFilters = args.filter.map(parseFilterSpec);
    for (const filter of appliedFilters) {
      await applyDimensionFilter(page, filter);
    }
    if (appliedFilters.length) {
      await page.waitForTimeout(1500);
      await Promise.allSettled([...state.pending]);
    }
    const latest = await waitForComponentTrace(
      state,
      component.component_id,
      Math.max(5000, Number(args.timeout || 45000)),
    );
    const template = latest || {
      endpoint: capturedComponent.endpoint,
      safeHeaders: capturedComponent.safe_headers,
      referrer: capturedComponent.referrer,
      request: capturedComponent.request,
      fields: capturedComponent.fields,
    };
    const request = structuredClone(template.request);
    const timezone = String(args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const dateRule = resolveDateRule(args['date-rule'], timezone, args.date);
    const appliedDate = dateRule.range;
    if (appliedDate) {
      const changed = applyDateOverride(request, appliedDate);
      if (!changed) {
        fail('DATE_OVERRIDE_UNSUPPORTED', 'The captured request has no recognizable date range. Set the date in the visible report and catalog again instead of guessing.');
      }
    }
    const pageSize = Math.min(50000, Math.max(100, Number(args['page-size'] || 10000)));
    const paginateInfo = request.datasetSpec && request.datasetSpec.paginateInfo;
    let startRow = paginateInfo && Number(paginateInfo.startRow || 1) || 1;
    const rows = [];
    let headers = null;
    let totalCount = null;
    let requestsMade = 0;
    let transportMode = 'direct_replay';
    const output = resolveExportPath(catalog, component, args.out);
    let nativeDownload = null;

    try {
      while (true) {
        if (paginateInfo) {
          request.datasetSpec.paginateInfo = { ...request.datasetSpec.paginateInfo, startRow, rowsCount: pageSize };
        }
        let payload;
        if (requestsMade === 0 && latest && latest.response && !appliedDate) {
          payload = { dataResponse: [latest.response] };
          transportMode = 'native_chart_response';
        } else {
          payload = await fetchComponentPage(page, template.endpoint, request, template.safeHeaders, template.referrer);
        }
        requestsMade += 1;
        const table = mainTable(payload);
        if (!table) throw new Error('batchedDataV2 response has no tableDataset for the selected component.');
        const decoded = decodeTable(table, template.fields || capturedComponent.fields);
        if (!headers) headers = decoded.headers;
        else if (JSON.stringify(headers) !== JSON.stringify(decoded.headers)) {
          throw new Error('Column schema changed during pagination.');
        }
        rows.push(...decoded.rows);
        totalCount = decoded.totalCount;
        if (!paginateInfo || decoded.rows.length === 0 || rows.length >= totalCount) break;
        startRow += decoded.rows.length;
        if (requestsMade > 1000) throw new Error('Pagination exceeded 1000 requests; aborting to avoid an unbounded loop.');
      }
    } catch (error) {
      const canUseNativeFallback = isReplayRejected(error) && !appliedDate && args['recipe-out'] === undefined && totalCount !== null;
      if (!canUseNativeFallback) throw error;
      nativeDownload = await downloadNativeCsv(page, component, output);
      if (nativeDownload.rows !== totalCount) {
        fail('INCOMPLETE_NATIVE_DOWNLOAD', 'The native CSV row count does not match the chart total.', {
          rows: nativeDownload.rows,
          total_count: totalCount,
        });
      }
      transportMode = 'native_browser_download';
    }

    const exportedRows = nativeDownload ? nativeDownload.rows : rows.length;
    const complete = totalCount === null ? !paginateInfo : exportedRows === totalCount;
    if (!complete) {
      fail('INCOMPLETE_EXPORT', 'Returned row count does not match the endpoint total.', { rows: exportedRows, total_count: totalCount });
    }
    const csv = nativeDownload ? null : toCsv(headers || [], rows);
    if (csv) writePrivateFile(output, csv);
    const checksum = nativeDownload ? nativeDownload.sha256 : crypto.createHash('sha256').update(csv).digest('hex');
    let recipePath = null;
    if (args['recipe-out']) {
      recipePath = resolveRecipePath(catalog, component, args['recipe-out']);
      writePrivateJson(recipePath, {
        schema_version: 1,
        collector_version: VERSION,
        created_at: new Date().toISOString(),
        confirmed_at: new Date().toISOString(),
        confirmed: true,
        authentication: {
          required: args.anonymous !== true,
          source: args.anonymous === true ? 'anonymous' : (context._lookerAuthSource || 'profile'),
        },
        source_url: catalog.source_url,
        report: { id: catalog.report.id, name: catalog.report.name },
        page: catalog.current_page,
        component: { id: component.component_id, title: component.title, type: component.type },
        selection: {
          filters: appliedFilters,
          date_rule: { type: dateRule.type, timezone: dateRule.timezone, fixed_range: dateRule.type === 'fixed' ? dateRule.range : null },
        },
        data_request: {
          endpoint: template.endpoint,
          safe_headers: template.safeHeaders,
          referrer: template.referrer,
          fields: template.fields || capturedComponent.fields,
          request: structuredClone(request),
        },
        security: {
          contains_cookies: false,
          contains_authorization_headers: false,
          requires_separate_auth: true,
        },
      });
    }
    const metadataPath = `${output}.meta.json`;
    writePrivateJson(metadataPath, {
      schema_version: 1,
      collector_version: VERSION,
      exported_at: new Date().toISOString(),
      source_url: catalog.source_url,
      report: catalog.report,
      page: catalog.current_page,
      component: {
        id: component.component_id,
        title: component.title,
        type: component.type,
      },
      selection: {
        date: appliedDate,
        date_rule: dateRule,
        filters: appliedFilters,
      },
      verification: {
        transport: transportMode,
        complete,
        rows: exportedRows,
        total_count: totalCount,
        requests: requestsMade,
        sha256: checksum,
      },
      output,
    });
    const authStatePath = resolveAuthStatePath(args, profile);
    if (fs.existsSync(authStatePath)) {
      await persistBrowserAuthState(context, authStatePath);
    }
    console.log(JSON.stringify({
      ok: true,
      output,
      metadata: metadataPath,
      component: { id: component.component_id, title: component.title },
      rows: exportedRows,
      total_count: totalCount,
      complete,
      sha256: checksum,
      transport: transportMode,
      recipe: recipePath,
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

function resolveRecipeDateRule(recipe) {
  const stored = recipe.selection && recipe.selection.date_rule || { type: 'captured', timezone: 'UTC' };
  const timezone = stored.timezone || 'UTC';
  const fixed = stored.fixed_range
    ? `${stored.fixed_range.start}:${stored.fixed_range.end}`
    : null;
  return resolveDateRule(stored.type, timezone, fixed);
}

async function runRecipe(args) {
  if (!args.recipe) fail('MISSING_RECIPE', 'run-recipe requires --recipe <recipe.json>.');
  const recipePath = path.resolve(String(args.recipe));
  if (!fs.existsSync(recipePath)) fail('RECIPE_MISSING', 'The direct-download recipe file is missing.', { recipe: recipePath });
  const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
  if (recipe.confirmed !== true) {
    fail('RECIPE_NOT_CONFIRMED', 'The recipe was not created from a user-confirmed selection.');
  }
  if (!recipe.data_request || !recipe.data_request.request) {
    fail('RECIPE_INVALID', 'The recipe is missing its captured data request.');
  }
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const authStatePath = resolveAuthStatePath(args, profile);
  const context = await launchAuthorizedContext(args, profile, Boolean(args.headed));
  try {
    const page = await primaryPage(context);
    const shellState = createCaptureState(page);
    const blockData = (route) => route.abort();
    await page.route(DATA_ENDPOINT, blockData);
    await page.goto(recipe.source_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCapture(shellState, Math.max(5000, Number(args['shell-timeout'] || 15000)), false);
    await page.unroute(DATA_ENDPOINT, blockData);
    const auth = await pageAuthState(page);
    const requiresAuthentication = !recipe.authentication || recipe.authentication.required !== false;
    if (auth.loginRedirect || auth.denied || !shellState.report) {
      fail('LOGIN_REQUIRED', 'The same-device Google session expired or was challenged. Renew it with login on this machine.', {
        profile,
        auth_state: fs.existsSync(authStatePath) ? authStatePath : null,
      });
    }

    const liveReport = shellState.report;
    const liveShareable = reportShareable(liveReport);
    if (liveShareable.downloadable !== true) {
      fail('DOWNLOAD_DISABLED', 'The report owner currently disables downloading; the scheduled direct replay was blocked.');
    }
    if (recipe.report.id && liveShareable.id && recipe.report.id !== liveShareable.id) {
      fail('REPORT_MISMATCH', 'The live metadata response does not match the recipe report.');
    }

    const dateRule = resolveRecipeDateRule(recipe);
    const dataTemplate = recipe.data_request;
    const request = structuredClone(dataTemplate.request);
    if (dateRule.range) {
      const changed = applyDateOverride(request, dateRule.range);
      if (!changed) {
        fail('DATE_OVERRIDE_UNSUPPORTED', 'The recipe request no longer exposes a recognizable date range.');
      }
    }
    const pageSize = Math.min(50000, Math.max(100, Number(args['page-size'] || 10000)));
    const paginateInfo = request.datasetSpec && request.datasetSpec.paginateInfo;
    let startRow = paginateInfo && Number(paginateInfo.startRow || 1) || 1;
    const rows = [];
    let headers = null;
    let totalCount = null;
    let requestsMade = 0;

    while (true) {
      if (paginateInfo) {
        request.datasetSpec.paginateInfo = { ...request.datasetSpec.paginateInfo, startRow, rowsCount: pageSize };
      }
      let payload;
      try {
        payload = await fetchComponentPage(page, dataTemplate.endpoint, request, dataTemplate.safe_headers, dataTemplate.referrer);
      } catch (error) {
        fail('RECIPE_STALE', 'The saved data request is no longer accepted. Refresh the page catalog and recreate this recipe.', {
          message: error.message,
        });
      }
      requestsMade += 1;
      const table = mainTable(payload);
      if (!table) fail('RESPONSE_SCHEMA_CHANGED', 'The direct data response has no tableDataset for the recipe component.');
      const decoded = decodeTable(table, dataTemplate.fields || []);
      if (!headers) headers = decoded.headers;
      else if (JSON.stringify(headers) !== JSON.stringify(decoded.headers)) {
        fail('RESPONSE_SCHEMA_CHANGED', 'Column schema changed during direct pagination.');
      }
      rows.push(...decoded.rows);
      totalCount = decoded.totalCount;
      if (!paginateInfo || decoded.rows.length === 0 || rows.length >= totalCount) break;
      startRow += decoded.rows.length;
      if (requestsMade > 1000) fail('PAGINATION_LIMIT', 'Direct pagination exceeded 1000 requests.');
    }

    const complete = totalCount === null ? !paginateInfo : rows.length === totalCount;
    if (!complete) {
      fail('INCOMPLETE_EXPORT', 'Returned row count does not match the endpoint total.', {
        rows: rows.length,
        total_count: totalCount,
      });
    }
    const catalogLike = {
      report: { id: recipe.report.id },
    };
    const component = {
      component_id: recipe.component.id,
      title: recipe.component.title,
    };
    const output = resolveExportPath(catalogLike, component, args.out);
    const csv = toCsv(headers || [], rows);
    writePrivateFile(output, csv);
    const checksum = crypto.createHash('sha256').update(csv).digest('hex');
    const metadataPath = `${output}.meta.json`;
    writePrivateJson(metadataPath, {
      schema_version: 1,
      collector_version: VERSION,
      exported_at: new Date().toISOString(),
      mode: 'direct_recipe',
      recipe: recipePath,
      source_url: recipe.source_url,
      report: recipe.report,
      page: recipe.page,
      component: recipe.component,
      selection: {
        filters: recipe.selection.filters,
        date_rule: dateRule,
      },
      verification: {
        live_downloadable: true,
        complete,
        rows: rows.length,
        total_count: totalCount,
        requests: requestsMade,
        sha256: checksum,
      },
      output,
    });
    if (requiresAuthentication && fs.existsSync(authStatePath)) {
      await persistBrowserAuthState(context, authStatePath);
    }
    console.log(JSON.stringify({
      ok: true,
      mode: 'direct_recipe',
      page_catalog_refreshed: false,
      report_shell_bootstrapped: true,
      automatic_chart_requests_blocked: true,
      live_download_permission_checked: true,
      output,
      metadata: metadataPath,
      recipe: recipePath,
      component: recipe.component,
      date: dateRule.range,
      rows: rows.length,
      total_count: totalCount,
      complete,
      sha256: checksum,
      auth_state_rolled_forward: requiresAuthentication && fs.existsSync(authStatePath),
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

async function runProbe(args) {
  if (!args.capture) fail('MISSING_CAPTURE', 'probe requires --capture <catalog.capture.json>.');
  const capturePath = path.resolve(String(args.capture));
  if (!fs.existsSync(capturePath)) fail('CAPTURE_MISSING', 'The private request capture is missing.', { capture: capturePath });
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  if (!capture.source_url) {
    fail('CAPTURE_INVALID', 'The capture has no source report URL.');
  }
  const profile = path.resolve(String(args.profile || defaultProfileDir()));
  const authStatePath = resolveAuthStatePath(args, profile);
  const context = await launchAuthorizedContext(args, profile, Boolean(args.headed));
  try {
    const page = await primaryPage(context);
    const shellState = createCaptureState(page);
    const blockData = (route) => route.abort();
    await page.route(DATA_ENDPOINT, blockData);
    await page.goto(capture.source_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCapture(shellState, Math.max(5000, Number(args['shell-timeout'] || 15000)), false);
    await page.unroute(DATA_ENDPOINT, blockData);
    const auth = await pageAuthState(page);
    if (auth.loginRedirect || auth.denied || !shellState.report) {
      fail('LOGIN_REQUIRED', 'The direct metadata probe requires a valid Google session.');
    }
    const liveReport = shellState.report;
    const shareable = reportShareable(liveReport);
    if (fs.existsSync(authStatePath)) {
      await persistBrowserAuthState(context, authStatePath);
    }
    console.log(JSON.stringify({
      ok: true,
      mode: 'report_shell_metadata_probe',
      page_catalog_refreshed: false,
      automatic_chart_requests_blocked: true,
      session_access_verified: true,
      account_button_detected: auth.authenticated,
      report: {
        id: shareable.id || capture.report_id,
        name: shareable.name || capture.report_name,
        downloadable: shareable.downloadable === true,
        copyable: shareable.copyable === true,
      },
      auth_state_rolled_forward: fs.existsSync(authStatePath),
    }, null, 2));
  } finally {
    await closeContext(context);
  }
}

function auditSkillPackage() {
  const findings = [];
  const forbiddenFilePatterns = [
    /(^|[._-])(auth|login|storage)[._-]?state.*\.json$/i,
    /(cookie|credential|secret).*\.json$/i,
    /\.capture\.json$/i,
    /\.recipe\.json$/i,
    /(^|\/)catalog(?:\..*)?\.json$/i,
    /\.csv$/i,
    /(^|\/)\.env(?:\..*)?$/i,
    /(^|\/)\.DS_Store$/i,
  ];
  const forbiddenDirectories = new Set(['google-profile', 'browser-profile', 'runtime-state']);
  const contentPatterns = [
    { reason: 'browser cookie state', pattern: new RegExp(`"${['cook', 'ies'].join('')}"\\s*:\\s*\\[`, 'i') },
    { reason: 'Google session cookie', pattern: new RegExp(`${['__Secure-', '3PSID'].join('')}\\s*[=:]`, 'i') },
    { reason: 'Google session cookie', pattern: new RegExp(`\\b${['SAPI', 'SID'].join('')}\\s*[=:]`, 'i') },
    { reason: 'OAuth access token', pattern: new RegExp(`\\b${['ya', '29\\.'].join('')}[A-Za-z0-9._-]+`) },
    { reason: 'OAuth refresh token', pattern: new RegExp(`\\b${['1', '//'].join('')}[A-Za-z0-9._-]{20,}`) },
    { reason: 'account email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  ];
  const textExtensions = new Set(['', '.cjs', '.js', '.json', '.md', '.txt', '.yaml', '.yml', '.env', '.gitignore']);

  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(SKILL_ROOT, absolute);
      if (entry.isSymbolicLink()) {
        findings.push({ file: relative, reason: 'unexpected symlink inside skill package' });
        continue;
      }
      if (entry.isDirectory()) {
        if (forbiddenDirectories.has(entry.name)) {
          findings.push({ file: relative, reason: 'runtime browser directory inside skill package' });
          continue;
        }
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (forbiddenFilePatterns.some((pattern) => pattern.test(relative))) {
        findings.push({ file: relative, reason: 'runtime or sensitive artifact filename' });
        continue;
      }
      const stat = fs.statSync(absolute);
      const extension = entry.name === '.gitignore' ? '.gitignore' : path.extname(entry.name).toLowerCase();
      if (stat.size > 5_000_000 || !textExtensions.has(extension)) continue;
      const text = fs.readFileSync(absolute, 'utf8');
      const match = contentPatterns.find((item) => item.pattern.test(text));
      if (match) findings.push({ file: relative, reason: match.reason });
    }
  };

  visit(SKILL_ROOT);
  return { ok: findings.length === 0, checked_root: SKILL_ROOT, findings };
}

function runSecurityAudit() {
  const audit = auditSkillPackage();
  if (!audit.ok) {
    fail('SENSITIVE_RUNTIME_ARTIFACT_IN_SKILL', 'The skill package contains a possible personal login or runtime artifact.', {
      files: audit.findings,
    });
  }
  console.log(JSON.stringify({
    ok: true,
    security_audit: 'passed',
    checked_root: audit.checked_root,
    personal_login_state_bundled: false,
  }, null, 2));
}

function runSelfTest() {
  const securityAudit = auditSkillPackage();
  if (!securityAudit.ok) {
    throw new Error(`Skill package security audit failed: ${securityAudit.findings.map((item) => item.file).join(', ')}`);
  }
  for (const platform of ['darwin', 'win32', 'linux']) {
    const kinds = browserCandidates(platform).map((candidate) => candidate.kind);
    if (kinds.indexOf('chrome') === -1 || kinds.indexOf('edge') === -1 || kinds.indexOf('chrome') > kinds.indexOf('edge')) {
      throw new Error(`Browser priority failed for ${platform}.`);
    }
  }
  const parsed = parseJsonResponse(`)]}'\n\n{"ok":true}`, '/test');
  if (!parsed.ok) throw new Error('XSSI parser failed.');
  const table = {
    columnInfo: [{ name: 'a' }, { name: 'b' }],
    totalCount: 3,
    size: 3,
    column: [
      { nullIndex: [1], stringColumn: { values: ['x', 'z'] } },
      { nullIndex: [], doubleColumn: { values: [1, 2, 3] } },
    ],
  };
  const decoded = decodeTable(table, [
    { query_alias: 'a', name: 'Name' },
    { query_alias: 'b', name: 'Value' },
  ]);
  if (JSON.stringify(decoded.rows) !== JSON.stringify([['x', 1], [null, 2], ['z', 3]])) throw new Error('Column decoder failed.');
  const request = { datasetSpec: { dateRanges: [{ startDate: '20260101', endDate: '20260102' }] } };
  if (applyDateOverride(request, { start: '2026-07-01', end: '2026-07-23' }) !== 2) throw new Error('Date override failed.');
  const rolling = resolveDateRule('last-7-days', 'UTC');
  if (!rolling.range || addIsoDays(rolling.range.end, -6) !== rolling.range.start) throw new Error('Rolling date rule failed.');
  if (countCsvDataRows('name,note\r\na,"line one\nline two"\r\nb,plain\r\n') !== 2) {
    throw new Error('Native CSV row counter failed.');
  }
  if (!isReplayRejected(new Error('batchedDataV2 replay returned HTTP 400.'))) {
    throw new Error('Replay rejection detector failed.');
  }
  if (mainTable({ dataResponse: [{ dataSubset: [{ dataset: { tableDataset: table } }] }] }) !== table) {
    throw new Error('Native chart response adapter failed.');
  }
  if (componentTracePriority({ role: 'row0' }, { main: { returnedRows: 6 } })
      <= componentTracePriority({ role: 'TotalOfTotal' }, { main: { returnedRows: 1 } })) {
    throw new Error('Pivot main-response priority failed.');
  }
  if (!traceHasUsableRows({ request: { role: 'row0' }, responseSummary: { main: { returnedRows: 6, totalCount: 6 } } })
      || traceHasUsableRows({ request: {}, responseSummary: { main: { returnedRows: 0, totalCount: 6 } } })) {
    throw new Error('Usable component-response condition failed.');
  }
  if (!toCsv(['Name'], [['x,y']]).includes('"x,y"')) throw new Error('CSV encoder failed.');
  console.log(JSON.stringify({
    ok: true,
    self_test: 'passed',
    security_audit: 'passed',
    personal_login_state_bundled: false,
    version: VERSION,
  }, null, 2));
}

function usage() {
  console.log(`Looker Studio Data ${VERSION}

Commands:
  doctor [--login-state FILE | --profile DIR | --auth-state FILE]
         [--browser auto|chrome|edge|chromium] [--browser-path PATH]
  login [--profile DIR] [--login-state FILE] [--auth-state FILE]
        [--browser auto|chrome|edge|chromium] [--browser-path PATH]
  auth-export [--profile DIR] [--login-state FILE] [--auth-state FILE]
              [--browser auto|chrome|edge|chromium] [--browser-path PATH]
  status [--login-state FILE | --profile DIR | --auth-state FILE]
         [--browser auto|chrome|edge|chromium] [--browser-path PATH]
         [--require-authenticated] [--headed]
  catalog --url URL [--auth-state FILE] [--browser auto|chrome|edge|chromium]
          [--browser-path PATH]
          [--out catalog.json] [--headed] [--no-filter-values]
  export --catalog catalog.json --component ID_OR_TITLE [--date START:END]
         [--date-rule captured|fixed|today|yesterday|last-N-days|month-to-date|previous-month]
         [--timezone IANA_ZONE] [--recipe-out [recipe.json]]
         [--filter LABEL=value1|value2] [--auth-state FILE]
         [--browser auto|chrome|edge|chromium] [--browser-path PATH] [--anonymous]
         [--out file.csv] --confirmed
  run-recipe --recipe recipe.json [--login-state FILE | --profile DIR | --auth-state FILE]
             [--browser auto|chrome|edge|chromium] [--browser-path PATH] [--out file.csv]
  probe --capture catalog.capture.json [--profile DIR | --auth-state FILE]
        [--browser auto|chrome|edge|chromium] [--browser-path PATH]
  security-audit
  self-test
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  loadLoginStateManifest(args, command === 'login' || command === 'auth-export');
  if (!command || command === 'help' || args.help) return usage();
  if (command === 'doctor') return runDoctor(args);
  if (command === 'login') return runLogin(args);
  if (command === 'auth-export') return runAuthExport(args);
  if (command === 'status') return runStatus(args);
  if (command === 'catalog') return runCatalog(args);
  if (command === 'export') return runExport(args);
  if (command === 'run-recipe') return runRecipe(args);
  if (command === 'probe') return runProbe(args);
  if (command === 'security-audit') return runSecurityAudit();
  if (command === 'self-test') return runSelfTest();
  fail('UNKNOWN_COMMAND', `Unknown command "${command}".`);
}

main().catch((error) => {
  fail('UNEXPECTED_ERROR', String(error && error.message || error), undefined, 1);
});
