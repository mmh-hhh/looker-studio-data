'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assessCaptureState,
  isCsvFormatLabel,
  replaceBatchRequestTarget,
  replaceFilePortable,
  portableSafeName,
  browserCandidatePaths,
  browserTerminationPlan,
  reportPageFileStem,
  reportPageUrl,
  selectCatalogComponent,
  usablePageName,
  windowsPrivateAclArgs,
} = require('../scripts/looker_studio_core.cjs');

test('core self-test remains available before Playwright is installed', () => {
  const result = childProcess.spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/looker_studio_data.cjs'),
    'self-test',
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '', LOOKER_DISABLE_PLAYWRIGHT_DISCOVERY: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).self_test, 'passed');
});

test('doctor reports a structured dependency issue before Playwright is installed', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'looker-doctor-'));
  const result = childProcess.spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/looker_studio_data.cjs'),
    'doctor',
    '--profile', profile,
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '', LOOKER_DISABLE_PLAYWRIGHT_DISCOVERY: '1' },
  });
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.dependency_issue.code, 'PLAYWRIGHT_NOT_FOUND');
  fs.rmSync(profile, { recursive: true, force: true });
});

test('capture does not settle on the first unrelated data response', () => {
  const result = assessCaptureState({
    reportReady: true,
    expectedPageId: 'page-a',
    observedPageId: 'page-a',
    loading: true,
    expectedComponentIds: ['chart-a', 'chart-b'],
    tracedComponentIds: ['filter-a'],
    lastRelevantResponseAt: 1000,
    now: 5000,
    stableWindowMs: 750,
  });

  assert.equal(result.settled, false);
  assert.equal(result.reason, 'page_loading');
});

test('settled page with no captured data is an explicit empty failure', () => {
  const result = assessCaptureState({
    reportReady: true,
    expectedPageId: 'page-a',
    observedPageId: 'page-a',
    loading: false,
    expectedComponentIds: ['chart-a'],
    tracedComponentIds: [],
    lastRelevantResponseAt: 1000,
    now: 5000,
    stableWindowMs: 750,
  });

  assert.equal(result.settled, true);
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.missingComponentIds, ['chart-a']);
});

test('settled page reports partial coverage instead of success', () => {
  const result = assessCaptureState({
    reportReady: true,
    expectedPageId: 'page-a',
    observedPageId: 'page-a',
    loading: false,
    expectedComponentIds: ['chart-a', 'chart-b'],
    tracedComponentIds: ['chart-a'],
    lastRelevantResponseAt: 1000,
    now: 5000,
    stableWindowMs: 750,
  });

  assert.equal(result.settled, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.readyCount, 1);
  assert.equal(result.expectedCount, 2);
});

test('CSV format matching accepts Looker Studio Excel variants', () => {
  for (const label of ['CSV', 'CSV (Excel)', 'CSV（Excel）', 'CSV - Excel']) {
    assert.equal(isCsvFormatLabel(label), true, label);
  }
  assert.equal(isCsvFormatLabel('Google 表格'), false);
  assert.equal(isCsvFormatLabel('PNG'), false);
});

test('component selection is scoped to the current page', () => {
  const catalog = {
    current_page: { id: 'page-a' },
    datasets: [
      { page_id: 'page-a', component_id: 'a1', title: '周搜索年增速榜单', selection_key: 'page-a/search-growth-a', status: 'ready' },
      { page_id: 'page-b', component_id: 'b1', title: '周搜索年增速榜单', selection_key: 'page-b/search-growth', status: 'ready' },
    ],
  };

  const result = selectCatalogComponent(catalog, '周搜索年增速榜单');
  assert.equal(result.ok, true);
  assert.equal(result.component.component_id, 'a1');
});

test('same-page duplicate returns business choices without requiring an internal id', () => {
  const catalog = {
    current_page: { id: 'page-a' },
    datasets: [
      { page_id: 'page-a', component_id: 'a1', title: '按选品主题聚合', selection_key: 'page-a/theme/summary', selection_label: '按选品主题聚合——主题汇总（87 行）' },
      { page_id: 'page-a', component_id: 'a2', title: '按选品主题聚合', selection_key: 'page-a/theme/store', selection_label: '按选品主题聚合——店铺明细（885 行）' },
    ],
  };

  const result = selectCatalogComponent(catalog, '按选品主题聚合');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AMBIGUOUS_COMPONENT');
  assert.deepEqual(result.choices, [
    { key: 'page-a/theme/summary', label: '按选品主题聚合——主题汇总（87 行）' },
    { key: 'page-a/theme/store', label: '按选品主题聚合——店铺明细（885 行）' },
  ]);
  assert.equal(JSON.stringify(result).includes('component_id'), false);
});

test('report page filenames remain unique when page names collide or are untitled', () => {
  assert.equal(reportPageFileStem({ id: 'p_a', name: '趋势' }), '趋势_p_a');
  assert.equal(reportPageFileStem({ id: 'p_b', name: '趋势' }), '趋势_p_b');
  assert.equal(reportPageFileStem({ id: 'p_c', name: '无标题页面' }), 'page_p_c');
  assert.equal(reportPageFileStem({ id: 'p_d', name: '很长'.repeat(100) }).length <= 113, true);
});

test('portable filenames handle Windows reserved names and trailing dots', () => {
  assert.equal(portableSafeName('CON'), '_CON');
  assert.equal(portableSafeName('nul.csv'), '_nul.csv');
  assert.equal(portableSafeName('主题.  '), '主题');
  assert.equal(portableSafeName('a/b:c'), 'a_b_c');
});

test('private file replacement overwrites an existing target without losing recovery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looker-replace-'));
  const source = path.join(directory, 'state.tmp');
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(target, 'old');
  replaceFilePortable(source, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('private file replacement restores the previous target when the new rename fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looker-rollback-'));
  const source = path.join(directory, 'state.tmp');
  const target = path.join(directory, 'state.json');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(target, 'old');
  const originalRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('simulated Windows replacement failure'), { code: 'EPERM' });
    return originalRename(...args);
  };
  try {
    assert.throws(() => replaceFilePortable(source, target), /simulated Windows replacement failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.equal(fs.readFileSync(source, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['state.json', 'state.tmp']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Windows private ACL removes inheritance and grants only the user and SYSTEM', () => {
  assert.deepEqual(windowsPrivateAclArgs('C:\\private\\auth-state.json', 'S-1-5-21-123', false), [
    'C:\\private\\auth-state.json',
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-21-123:(F)',
    '*S-1-5-18:(F)',
  ]);
});

test('Windows browser candidates include user and machine Chrome and Edge installs', () => {
  const candidates = browserCandidatePaths('win32', {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  }, 'C:\\Users\\tester');
  assert.equal(candidates.some((item) => item.kind === 'chrome' && /Chrome.*chrome\.exe$/i.test(item.path)), true);
  assert.equal(candidates.some((item) => item.kind === 'edge' && /Edge.*msedge\.exe$/i.test(item.path)), true);
});

test('browser termination uses the Windows process-tree command', () => {
  assert.deepEqual(browserTerminationPlan('win32', 321), {
    command: 'taskkill',
    args: ['/PID', '321', '/T', '/F'],
  });
});

test('report page navigation preserves the signed-in account slot', () => {
  assert.equal(
    reportPageUrl('https://datastudio.google.com/u/0/reporting/report-id/page/p_old?x=1', 'p_new'),
    'https://datastudio.google.com/u/0/reporting/report-id/page/p_new?x=1',
  );
});

test('whole-batch replay replaces only the captured request index', () => {
  const original = { dataRequest: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], metadata: { keep: true } };
  const replacement = { id: 'target', paginateInfo: { startRow: 100 } };
  const result = replaceBatchRequestTarget(original, replacement, 1);
  assert.deepEqual(result.body, {
    dataRequest: [{ id: 'a' }, replacement, { id: 'c' }],
    metadata: { keep: true },
  });
  assert.equal(result.targetIndex, 1);
  assert.deepEqual(original.dataRequest[1], { id: 'b' });
});

test('page name falls back when Looker Studio exposes a placeholder', () => {
  assert.equal(usablePageName(' 运营选品方向 '), '运营选品方向');
  assert.equal(usablePageName('无标题页面'), '');
  assert.equal(usablePageName('Untitled Page'), '');
  assert.equal(usablePageName('Page 3'), '');
});

test('business choices never expose qt field aliases', () => {
  const result = selectCatalogComponent({
    current_page: { id: 'page-a' },
    datasets: [
      { page_id: 'page-a', component_id: 'a1', title: '榜单', fields: [{ name: 'qt_abcd' }], row_summary: { main: { totalCount: 10 } } },
      { page_id: 'page-a', component_id: 'a2', title: '榜单', fields: [{ name: '业务字段' }], row_summary: { main: { totalCount: 20 } } },
    ],
  }, '榜单');
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('qt_abcd'), false);
});
