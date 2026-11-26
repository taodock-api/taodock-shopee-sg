import { isObject, readRules, reviewDraft } from './catalog.mjs';
import { AppError } from './errors.mjs';
import { checkFacts, conflictingMeasurement, readFacts } from './facts.mjs';

function draftsFrom(data) {
  if (!Array.isArray(data) || !data.length || data.length > 100) {
    throw new AppError(400, 'Provide a JSON array of 1–100 Shopee drafts.');
  }
  return data;
}

function factIssues(facts, text, issue) {
  for (const { kind, value } of checkFacts(facts, text)) {
    const message = {
      empty: 'Enter text to check.',
      missing: `Missing approved measurement ${value}.`,
      extra: `Found a measurement outside the approved list (${value}).`,
      phrase: `Missing the required phrase “${value}”.`,
    }[kind];
    issue('error', 'item_name / description', message);
  }
}

function compareAttributes(facts, list, issue) {
  if (!Array.isArray(list)) return;
  for (const [index, attribute] of list.entries()) {
    if (!Array.isArray(attribute?.attribute_value_list)) continue;
    for (const [position, entry] of attribute.attribute_value_list.entries()) {
      const value = conflictingMeasurement(facts, entry?.original_value_name, entry?.value_unit);
      if (value) {
        issue('error', `attribute_list[${index}].attribute_value_list[${position}]`,
          `Attribute measurement ${value} conflicts with the approved facts.`);
      }
    }
  }
}

function addSku(value, path, row, seen, optional) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) {
    if (!optional || (value !== undefined && value !== '')) {
      row.issues.push({ severity: 'error', path, message: 'Enter a seller SKU of up to 255 characters.' });
    }
    return;
  }
  const sku = value.trim();
  const first = seen.get(sku);
  if (first) {
    const conflict = (target, field) => {
      if (target.issues.some((issue) => issue.path === field && issue.message === 'Repeated seller SKU.')) return;
      target.issues.push({ severity: 'error', path: field, message: 'Repeated seller SKU.' });
    };
    conflict(first.row, first.path);
    conflict(row, path);
  } else seen.set(sku, { path, row });
}

function label(draft) {
  return typeof draft?.item_sku === 'string' ? draft.item_sku.trim().slice(0, 255) : '';
}

export function reviewBatch({ snapshot, drafts }) {
  const rules = readRules(snapshot);
  const input = draftsFrom(drafts);
  const parentSku = new Map();
  const modelSku = new Map();
  const rows = input.map((draft, index) => {
    const row = { index, itemSku: label(draft), issues: [] };
    const issue = (severity, path, message) => row.issues.push({ severity, path, message });
    if (!isObject(draft)) {
      issue('error', 'draft', 'Enter a draft object.');
      return row;
    }
    reviewDraft(rules, draft, issue);
    addSku(draft.item_sku, 'item_sku', row, parentSku, true);
    if (Array.isArray(draft.models)) {
      draft.models.forEach((model, position) => {
        addSku(model?.model_sku, `models[${position}].model_sku`, row, modelSku, true);
      });
    }
    if (draft.approved !== undefined) {
      try {
        if (!isObject(draft.approved)) throw new AppError(400, 'Enter approved facts as an object.');
        const approved = draft.approved;
        const facts = readFacts({ measurements: approved.measurements ?? '', phrases: approved.phrases ?? '' });
        const text = [draft.item_name, draft.description].filter((part) => typeof part === 'string').join('\n');
        factIssues(facts, text, issue);
        compareAttributes(facts, draft.attribute_list, issue);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        issue('error', 'approved', error.message);
      }
    }
    return row;
  });
  let passed = 0;
  for (const row of rows) {
    row.valid = !row.issues.some(({ severity }) => severity === 'error');
    if (row.valid) passed += 1;
  }
  const warnings = [];
  if (rules.sample) warnings.push('The sample uses fictional categories and limits. Load current Shopee Singapore responses to review real listings.');
  if (!rules.checks.size) warnings.push('No supported GetItemLimit checks were provided. Verify listing limits in Seller Centre.');
  return { market: 'SG', total: rows.length, passed, rows, warnings };
}

function approvedSource(input) {
  if (!isObject(input) || typeof input.productName !== 'string' || !input.productName.trim()
      || input.productName.length > 255 || /[\r\n\u0000-\u001f]/u.test(input.productName)
      || typeof input.statements !== 'string' || input.statements.length > 6000) {
    throw new AppError(400, 'Enter an approved product name and one or more approved statements.');
  }
  const statements = input.statements.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!statements.length || statements.length > 20
      || statements.some((text) => text.length > 400 || /[\u0000-\u001f]/u.test(text))) {
    throw new AppError(400, 'Use one approved statement per line, up to 20 statements of 400 characters.');
  }
  const facts = readFacts({ measurements: input.measurements ?? '', phrases: input.phrases ?? '' });
  return { item_name: input.productName.trim(), statements, facts };
}

async function createCopy(draft, index, orderStatements) {
  const issues = [];
  try {
    const { item_name, statements, facts } = approvedSource(draft?.approved);
    factIssues(facts, [item_name, ...statements].join('\n'), (severity, path, message) => issues.push({ severity, path, message }));
    if (issues.length) return { index, itemSku: label(draft), valid: false, issues };
    const order = orderStatements && statements.length > 1
      ? await orderStatements(statements)
      : statements.map((_, index) => index);
    if (!Array.isArray(order) || order.length !== statements.length
        || new Set(order).size !== statements.length
        || order.some((index) => !Number.isInteger(index) || index < 0 || index >= statements.length)) {
      throw new AppError(502, 'The model returned an invalid statement order. Try the local draft instead.');
    }
    const bullets = order.map((index) => statements[index]);
    return { index, itemSku: label(draft), valid: true, item_name, bullets, description: bullets.join('\n\n') };
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 400) throw error;
    return { index, itemSku: label(draft), valid: false, issues: [{ severity: 'error', path: 'approved', message: error.message }] };
  }
}

export async function prepareCopy({ mode, drafts, index, model }, taodock) {
  const input = draftsFrom(drafts);
  if (mode === 'local') return { rows: await Promise.all(input.map((draft, i) => createCopy(draft, i))) };
  if (mode !== 'taodock' || !Number.isInteger(index) || index < 0 || index >= input.length) {
    throw new AppError(400, 'Select a draft for Taodock or prepare all drafts locally.');
  }
  return { rows: [await createCopy(input[index], index, (statements) => taodock.order(model, statements))] };
}
