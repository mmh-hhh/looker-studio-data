'use strict';

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '')).filter(Boolean))];
}

function usablePageName(name) {
  const value = String(name || '').replace(/\s+/g, ' ').trim();
  return value && !/^(?:无标题页面|untitled page|page \d+)$/i.test(value) ? value : '';
}

function reportPageFileStem(page = {}) {
  const safe = (value) => String(value || 'page')
    .normalize('NFKC')
    .replace(/[\/\\:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'page';
  return `${safe(usablePageName(page.name) || 'page')}_${safe(page.id || 'unknown')}`;
}

function reportPageUrl(sourceUrl, pageId) {
  const parsed = new URL(String(sourceUrl));
  if (/\/page\/[A-Za-z0-9_-]+/i.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/page\/[A-Za-z0-9_-]+/i, `/page/${pageId}`);
  } else {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/page/${pageId}`;
  }
  return parsed.toString();
}

function replaceBatchRequestTarget(batchRequest, request, requestIndex = 0) {
  const body = batchRequest && Array.isArray(batchRequest.dataRequest)
    ? structuredClone(batchRequest)
    : { dataRequest: [structuredClone(request)] };
  const targetIndex = batchRequest && Array.isArray(batchRequest.dataRequest) ? Number(requestIndex || 0) : 0;
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || !body.dataRequest[targetIndex]) {
    throw new RangeError(`Invalid batch request index: ${requestIndex}`);
  }
  body.dataRequest[targetIndex] = structuredClone(request);
  return { body, targetIndex };
}

function assessCaptureState(input = {}) {
  const expectedPageId = String(input.expectedPageId || '');
  const observedPageId = String(input.observedPageId || '');
  const expectedComponentIds = uniqueStrings(input.expectedComponentIds);
  const traced = new Set(uniqueStrings(input.tracedComponentIds));
  const readyComponentIds = expectedComponentIds.filter((id) => traced.has(id));
  const missingComponentIds = expectedComponentIds.filter((id) => !traced.has(id));
  const result = {
    settled: false,
    status: 'waiting',
    reason: '',
    expectedCount: expectedComponentIds.length,
    readyCount: readyComponentIds.length,
    readyComponentIds,
    missingComponentIds,
  };

  if (!input.reportReady) {
    result.reason = 'report_metadata_pending';
    return result;
  }
  if (expectedPageId && observedPageId !== expectedPageId) {
    result.reason = observedPageId ? 'wrong_page' : 'page_identity_pending';
    return result;
  }
  if (input.loading) {
    result.reason = 'page_loading';
    return result;
  }
  const now = Number(input.now || Date.now());
  const lastRelevantResponseAt = Number(input.lastRelevantResponseAt || 0);
  const stableWindowMs = Math.max(0, Number(input.stableWindowMs || 0));
  if (!lastRelevantResponseAt || now - lastRelevantResponseAt < stableWindowMs) {
    result.reason = 'capture_not_stable';
    return result;
  }

  result.settled = true;
  if (!result.readyCount) {
    result.status = 'empty';
    result.reason = 'no_data_components_captured';
  } else if (result.readyCount < result.expectedCount) {
    result.status = 'partial';
    result.reason = 'some_data_components_missing';
  } else {
    result.status = 'ready';
    result.reason = 'all_data_components_captured';
  }
  return result;
}

function normalizeFormatLabel(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function isCsvFormatLabel(value) {
  const normalized = normalizeFormatLabel(value);
  if (!normalized) return false;
  if (normalized === 'csv') return true;
  return /^csv\s*(?:[-–—:]|\(|（)?\s*excel\s*(?:\)|）)?$/i.test(normalized)
    || /(?:excel|microsoft excel).*(?:csv)|(?:csv).*(?:excel|microsoft excel)/i.test(normalized);
}

function componentChoice(component) {
  const count = component && component.row_summary && component.row_summary.main
    ? Number(component.row_summary.main.totalCount)
    : null;
  const fieldNames = (component && component.fields || [])
    .map((field) => field.name)
    .filter((name) => name && !/^qt_[A-Za-z0-9_-]+$/i.test(name) && !/^_.*_$/.test(name))
    .slice(0, 2);
  const fallbackSuffix = count !== null && Number.isFinite(count)
    ? `${count} 行`
    : fieldNames.length ? fieldNames.join('、') : '数据表';
  return {
    key: component.selection_key || component.title,
    label: component.selection_label || `${component.title}——${fallbackSuffix}`,
  };
}

function selectCatalogComponent(catalog, selector) {
  const datasets = Array.isArray(catalog && catalog.datasets) ? catalog.datasets : [];
  const selected = String(selector || '').trim();
  const currentPageId = catalog && catalog.current_page && String(catalog.current_page.id || '');
  const currentPage = currentPageId ? datasets.filter((item) => String(item.page_id || '') === currentPageId) : datasets;

  const byId = datasets.filter((item) => item.component_id === selected);
  if (byId.length === 1) return { ok: true, component: byId[0], matchedBy: 'component_id' };

  const byKey = currentPage.filter((item) => item.selection_key === selected);
  if (byKey.length === 1) return { ok: true, component: byKey[0], matchedBy: 'selection_key' };

  const exact = currentPage.filter((item) => item.title === selected || item.selection_label === selected);
  if (exact.length === 1) return { ok: true, component: exact[0], matchedBy: 'business_name' };
  if (exact.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_COMPONENT', choices: exact.map(componentChoice) };
  }

  const partial = currentPage.filter((item) => item.title && item.title.includes(selected));
  if (partial.length === 1) return { ok: true, component: partial[0], matchedBy: 'partial_business_name' };
  if (partial.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_COMPONENT', choices: partial.map(componentChoice) };
  }
  return { ok: false, code: 'COMPONENT_NOT_FOUND', choices: [] };
}

module.exports = {
  assessCaptureState,
  isCsvFormatLabel,
  replaceBatchRequestTarget,
  reportPageFileStem,
  reportPageUrl,
  selectCatalogComponent,
  usablePageName,
};
