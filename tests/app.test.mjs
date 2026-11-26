import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readRules } from '../src/catalog.mjs';
import { prepareCopy, reviewBatch } from '../src/review.mjs';
import { app } from '../src/server.mjs';
import { taodockClient } from '../src/taodock.mjs';

const sample = JSON.parse(await readFile(new URL('../examples/demo.json', import.meta.url)));
const clone = () => structuredClone(sample);
const tree = ({ snapshot }) => snapshot.attributeResponse.response.list[0].attribute_tree;
const value = (id, original_value_name, value_unit) => ({ value_id: id, original_value_name, value_unit });
const attribute = (id, ...values) => ({ attribute_id: id, attribute_value_list: values });
const issueAt = (row, path) => row.issues.some((issue) => issue.path === path);

test('sample batch finds a missing child plus wrong measurement and allows equivalent units', () => {
  const report = reviewBatch(sample);
  assert.equal(report.passed, 1);
  assert.equal(report.total, 2);
  assert.match(report.warnings[0], /fictional/i);
  assert(issueAt(report.rows[0], 'attribute_list.41002'));
  assert(report.rows[0].issues.some(({ message }) => message.includes('700 ml')));
  assert.equal(report.rows[1].valid, true);
});

test('child attributes require the corresponding parent option', () => {
  const data = clone();
  data.drafts[1].attribute_list.push(attribute(41002, value(51201)));
  const inactive = reviewBatch(data).rows[1];
  assert(inactive.issues.some(({ message }) => message.includes('associated parent')));
  data.drafts[1].attribute_list[0] = attribute(41001, value(51101));
  assert.equal(reviewBatch(data).rows[1].valid, true);
});

test('enforces dropdown, option counts, custom values, and units from the snapshot', () => {
  const data = clone();
  tree(data).push({
    attribute_id: 42, name: 'Colours', mandatory: true, attribute_info: { input_type: 4, max_value_count: 2 },
    attribute_value_list: [{ value_id: 401, name: 'Red' }, { value_id: 402, name: 'Silver' }],
  });
  const draft = data.drafts[1];
  draft.attribute_list[1] = attribute(41003, value(0, 'not a number', 'cm'));
  draft.attribute_list.push(attribute(42, value(401), value(401), value(0, 'Black')));
  const row = reviewBatch(data).rows[1];
  assert.equal(row.valid, false);
  for (const text of ['decimal', 'valid unit', 'at most 2', 'repeated value', 'Choose a valid value']) {
    assert(row.issues.some(({ message }) => message.includes(text)), text);
  }
});

test('checks a quantitative attribute against approved measurements of the same kind', () => {
  const data = clone();
  data.drafts[1].attribute_list[1] = attribute(41003, value(0, '0.8', 'l'));
  const row = reviewBatch(data).rows[1];
  assert.equal(row.valid, false);
  assert(row.issues.some(({ message }) => message.includes('conflicts with the approved facts')));
  data.drafts[1].attribute_list[1] = attribute(41003, value(0, '0.75', 'l'));
  assert.equal(reviewBatch(data).rows[1].valid, true);
});

test('checks date formats while treating missing rule capabilities as review warnings', () => {
  const data = clone();
  tree(data).push({
    attribute_id: 43, name: 'Packed on', mandatory: false, attribute_info: { input_type: 3, input_validation_type: 4 },
  }, {
    attribute_id: 44, name: 'Future attribute', mandatory: false, attribute_info: { input_type: 20 },
  });
  data.drafts[1].attribute_list.push(attribute(43, value(0, '31/02/2026')), attribute(44, value(3)));
  let row = reviewBatch(data).rows[1];
  assert(row.issues.some(({ message }) => message.includes('DD/MM/YYYY')));
  data.drafts[1].attribute_list[2] = attribute(43, value(0, '28/02/2026'));
  row = reviewBatch(data).rows[1];
  assert.equal(row.valid, true);
  assert(row.issues.some(({ severity, path }) => severity === 'warning' && path === 'attribute_list.44'));
});

test('uses imported title, description and image limits and rejects other-market data', () => {
  const data = clone();
  Object.assign(data.drafts[1], { item_name: 'Short', description: 'Small', image: { image_id_list: ['same', 'same'] } });
  const row = reviewBatch(data).rows[1];
  for (const path of ['item_name', 'description', 'image.image_id_list']) assert(issueAt(row, path), path);
  assert.throws(() => readRules({ ...data.snapshot, market: 'MY' }), /market to SG/);
  assert.throws(() => readRules({ ...data.snapshot, attributeResponse: { error: 'error_auth' } }), /successful Shopee/);
  assert.throws(() => reviewBatch({ ...data, drafts: Array(101).fill(data.drafts[1]) }), /1–100/);
});

test('checks variation options and combinations and flags duplicate SKUs on both drafts', () => {
  const data = clone();
  for (const draft of data.drafts) {
    draft.item_sku = 'REPEAT';
    draft.tier_variation = [{ name: 'Colour', option_list: [{ option: 'Navy' }] }];
    draft.models = [{ model_sku: 'REPEAT-MODEL', tier_index: [0] }];
  }
  data.drafts[1].models.push({ model_sku: 'variant-2', tier_index: [0] }, { model_sku: 'variant-3', tier_index: [2] });
  const rows = reviewBatch(data).rows;
  for (const row of rows) {
    assert(issueAt(row, 'item_sku'));
    assert(issueAt(row, 'models[0].model_sku'));
  }
  assert(issueAt(rows[1], 'models[1].tier_index'));
  assert(issueAt(rows[1], 'models[2].tier_index'));
  data.drafts[1].tier_variation[0].option_list = [null];
  assert(issueAt(reviewBatch(data).rows[1], 'tier_variation[0].option_list'));
});

test('locally prepares the whole batch and confines malformed approved facts to their own draft', async () => {
  const { drafts } = clone();
  drafts[0].approved.statements += '\nA second capacity of 900 ml.';
  const { rows } = await prepareCopy({ mode: 'local', drafts }, {});
  assert.equal(rows[0].valid, false);
  assert.equal(rows[1].valid, true);
  assert.equal(rows[1].item_name, drafts[1].approved.productName);
  assert.deepEqual(rows[1].bullets, drafts[1].approved.statements.split('\n'));
  assert.equal(rows[1].description, rows[1].bullets.join('\n\n'));
});

test('optional AI orders just the selected draft and accepts only a permutation', async () => {
  const request = { mode: 'taodock', index: 1, model: 'test', drafts: sample.drafts };
  const { rows } = await prepareCopy(request, {
    async order(model, statements) {
      assert.equal(model, 'test');
      assert.deepEqual(statements, sample.drafts[1].approved.statements.split('\n'));
      return [1, 0];
    },
  });
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].bullets[0], 'The capacity is 750 ml.');
  for (const invalid of [[0, 0], [0], ['0', 1], ['Durable', 0], 'New product copy']) {
    await assert.rejects(prepareCopy(request, { async order() { return invalid; } }), /invalid statement order/);
  }
});

test('Taodock client uses an exact available model and sends only the selected statements', async () => {
  const urls = [];
  const client = taodockClient({ TAODOCK_API_KEY: 'test-key' }, async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test/exact' }] });
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'test/exact');
    assert.deepEqual(JSON.parse(payload.messages[1].content), ['One.', 'Two.']);
    return Response.json({ choices: [{ message: { content: '\x60\x60\x60json\n[1,0]\n\x60\x60\x60' } }] });
  });
  await assert.rejects(client.order('exact', ['One.', 'Two.']), /unavailable/);
  assert.deepEqual(await client.order('test/exact', ['One.', 'Two.']), [1, 0]);
  assert.deepEqual(urls, ['https://taodock.com/v1/models', 'https://taodock.com/v1/models', 'https://taodock.com/v1/chat/completions']);
});

test('loopback server serves the UI and completes sample review without external calls', async (t) => {
  const server = app({ env: {}, fetchImpl() { throw new Error('Unexpected external request'); } });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url);
  assert.match(await page.text(), /Draft Checker for Shopee Singapore/);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const get = (path) => fetch(url + path);
  for (const path of ['/app.mjs', '/styles.css']) assert.equal((await get(path)).status, 200);
  assert.deepEqual(await (await get('/api/config')).json(), { taodock: false });
  const demo = await (await get('/api/demo')).json();
  const post = (path, data, headers = {}) => fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  assert.equal((await post('/api/review', demo, { Origin: 'https://another.example' })).status, 403);
  assert.equal((await post('/api/review', demo, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/review', { snapshot: {}, drafts: [] })).status, 400);
  assert.equal((await (await post('/api/review', demo)).json()).passed, 1);
  const result = await (await post('/api/copy', { mode: 'local', drafts: demo.drafts })).json();
  assert.equal(result.rows.filter((row) => row.valid).length, 2);
});
