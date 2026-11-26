const byId = (id) => document.getElementById(id);
const snapshot = byId('snapshot');
const drafts = byId('drafts');
const status = byId('status');
const reportStatus = byId('report-status');
const copyStatus = byId('copy-status');
const confirmCopy = byId('confirm-copy');
let revision = 0;
let copyRequest = 0;
let report;
let copy;

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The local tool could not complete the request.');
  return result;
}

function showMessage(target, message, error = false) {
  target.textContent = message;
  target.toggleAttribute('data-error', error);
}

function action(id, handler, output = status) {
  const button = byId(id);
  button.addEventListener('click', async () => {
    button.disabled = true;
    showMessage(output, '');
    try {
      await handler();
    } catch (error) {
      showMessage(output, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function parse(input, label) {
  try {
    return JSON.parse(input.value);
  } catch {
    throw new Error(`Enter valid JSON for ${label}.`);
  }
}

function invalidate() {
  revision += 1;
  report = undefined;
  copy = undefined;
  byId('download-report').disabled = true;
  byId('report-rows').replaceChildren();
  byId('warnings').hidden = true;
  byId('copy-rows').replaceChildren();
  byId('copy-controls').hidden = true;
  confirmCopy.checked = false;
  byId('download-copy').disabled = true;
  showMessage(reportStatus, 'Run a check to update the report.');
  showMessage(copyStatus, '');
}

function renderList(entries, makeItem) {
  const list = document.createElement('ul');
  for (const entry of entries) {
    const row = document.createElement('li');
    makeItem(row, entry);
    list.append(row);
  }
  return list;
}

function renderIssues(issues) {
  const list = renderList(issues, (element, { severity, path, message }) => {
    const field = document.createElement('code');
    field.textContent = path;
    const text = document.createElement('span');
    text.textContent = `${severity === 'error' ? 'Error' : 'Review'} · ${message}`;
    element.append(field, text);
  });
  list.className = 'issue-list';
  return list;
}

function section({ index, itemSku }, detail, content, expanded) {
  const row = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `${itemSku || `Draft ${index + 1}`} · ${detail}`;
  const block = document.createElement('div');
  block.className = 'details-content';
  block.append(content);
  row.append(summary, block);
  row.open = expanded;
  return row;
}

function displayReport(result) {
  report = result;
  reportStatus.textContent = `${result.passed} of ${result.total} drafts passed the supplied checks.`;
  const warnings = byId('warnings');
  warnings.replaceChildren(...result.warnings.map((message) => {
    const warning = document.createElement('li');
    warning.textContent = message;
    return warning;
  }));
  warnings.hidden = !result.warnings.length;
  byId('report-rows').replaceChildren(...result.rows.map((row) => {
    const count = row.issues.filter(({ severity }) => severity === 'error').length;
    const content = row.issues.length ? renderIssues(row.issues) : 'No issues in the supplied checks.';
    const detail = count ? `${count} blocking finding(s)` : 'Checks passed';
    return section(row, detail, content, count > 0);
  }));
  byId('download-report').disabled = false;
}

function displayCopy(result) {
  copy = result;
  confirmCopy.checked = false;
  byId('download-copy').disabled = true;
  const valid = result.rows.filter((row) => row.valid).length;
  showMessage(copyStatus, `${valid} of ${result.rows.length} draft(s) ready to review.`);
  byId('copy-controls').hidden = valid === 0;
  byId('copy-rows').replaceChildren(...result.rows.map((row) => {
    if (!row.valid) return section(row, 'Needs approved facts', renderIssues(row.issues), true);
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = row.item_name;
    const bullets = renderList(row.bullets, (item, statement) => { item.textContent = statement; });
    const description = document.createElement('p');
    description.className = 'description';
    description.textContent = row.description;
    content.append(title, bullets, description);
    return section(row, 'Preview', content, result.rows.length <= 4);
  }));
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

for (const input of [snapshot, drafts]) input.addEventListener('input', invalidate);
for (const [id, input] of [['snapshot-file', snapshot], ['drafts-file', drafts]]) {
  byId(id).addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const start = revision;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('The JSON file exceeds 2 MiB.');
      const content = await file.text();
      const value = JSON.parse(content);
      if (revision !== start) return;
      input.value = JSON.stringify(value, null, 2);
      invalidate();
      showMessage(status, `Loaded ${file.name}.`);
    } catch {
      showMessage(status, 'Import valid JSON under 2 MiB.', true);
    } finally {
      event.target.value = '';
    }
  });
}

action('load-demo', async () => {
  const demo = await api('/api/demo');
  snapshot.value = JSON.stringify(demo.snapshot, null, 2);
  drafts.value = JSON.stringify(demo.drafts, null, 2);
  invalidate();
  showMessage(status, 'Fictional batch loaded. Check it to compare a passing draft with one that needs changes.');
});

action('check-batch', async () => {
  const start = revision;
  const data = { snapshot: parse(snapshot, 'Shopee rules'), drafts: parse(drafts, 'listing drafts') };
  const result = await api('/api/review', data);
  if (revision === start) displayReport(result);
});
byId('download-report').addEventListener('click', () => download('shopee-sg-batch-report.json', report));

async function createCopy(mode, options = {}) {
  const start = revision;
  const request = ++copyRequest;
  const result = await api('/api/copy', { mode, drafts: parse(drafts, 'listing drafts'), ...options });
  if (revision === start && request === copyRequest) displayCopy(result);
}
action('local-copy', () => createCopy('local'), copyStatus);
action('ai-copy', async () => {
  const model = byId('model').value;
  if (!model) throw new Error('Select a text-capable Taodock model.');
  const index = byId('draft-number').valueAsNumber - 1;
  await createCopy('taodock', { model, index });
}, copyStatus);

action('load-models', async () => {
  const { models } = await api('/api/models');
  if (!models.length) throw new Error('Your key currently has no available Taodock models.');
  const placeholder = new Option('Select a text-capable model', '', true, true);
  placeholder.disabled = true;
  byId('model').replaceChildren(placeholder, ...models.map((model) => new Option(model, model)));
  byId('ai-settings').hidden = false;
}, copyStatus);

confirmCopy.addEventListener('change', () => { byId('download-copy').disabled = !confirmCopy.checked; });
byId('download-copy').addEventListener('click', () => {
  if (!confirmCopy.checked || !copy) return;
  download('shopee-sg-reviewed-copy.json', copy.rows.filter((row) => row.valid).map((row) => ({
    draft_number: row.index + 1,
    item_sku: row.itemSku,
    item_name: row.item_name,
    bullets: row.bullets,
    description: row.description,
  })));
});

try {
  const config = await api('/api/config');
  byId('load-models').disabled = !config.taodock;
} catch (error) {
  showMessage(status, error.message, true);
}
