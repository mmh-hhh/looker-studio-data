'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessCaptureState,
  isCsvFormatLabel,
  replaceBatchRequestTarget,
  reportPageFileStem,
  reportPageUrl,
  selectCatalogComponent,
  usablePageName,
} = require('../scripts/looker_studio_core.cjs');

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
