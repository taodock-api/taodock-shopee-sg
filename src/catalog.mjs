import { AppError } from './errors.mjs';

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return undefined;
  const text = String(value);
  return /^[1-9][0-9]{0,19}$/u.test(text) ? text : undefined;
}

function invalidRules(message) {
  throw new AppError(400, message);
}

function response(envelope, label) {
  if (!isObject(envelope) || (envelope.error && envelope.error !== '-') || !isObject(envelope.response)) {
    invalidRules(`Paste a successful Shopee ${label} response.`);
  }
  return envelope.response;
}

function scanRules(tree, category, depth = 0) {
  if (!Array.isArray(tree) || depth > 16) invalidRules('The supplied attribute tree is invalid or too deep.');
  const siblingIds = new Set();
  for (const rule of tree) {
    const id = identifier(rule?.attribute_id);
    const info = rule?.attribute_info;
    if (!id || siblingIds.has(id) || !isObject(info) || typeof rule.mandatory !== 'boolean'
        || (rule.attribute_value_list !== undefined && !Array.isArray(rule.attribute_value_list))) {
      invalidRules('Each attribute tree entry needs a valid ID, mandatory flag and attribute_info object.');
    }
    siblingIds.add(id);
    category.known.add(id);
    category.count += 1;
    if (category.count > 5000) invalidRules('The category has more than 5,000 attribute entries.');
    const options = new Set();
    for (const option of rule.attribute_value_list ?? []) {
      const optionId = identifier(option?.value_id);
      if (!optionId || options.has(optionId)) invalidRules('An attribute tree has an invalid or repeated option ID.');
      options.add(optionId);
      if (option.child_attribute_list?.length || !Array.isArray(option.child_attribute_list ?? [])) {
        scanRules(option.child_attribute_list, category, depth + 1);
      }
    }
  }
}

export function readRules(snapshot) {
  if (!isObject(snapshot) || snapshot.market !== 'SG') invalidRules('Set market to SG in the Shopee rule snapshot.');
  const list = response(snapshot.attributeResponse, 'GetAttributeTree').list;
  if (!Array.isArray(list) || !list.length || list.length > 100) {
    invalidRules('The GetAttributeTree response must contain 1–100 categories in response.list.');
  }
  const categories = new Map();
  for (const entry of list) {
    const id = identifier(entry?.category_id);
    if (!id || categories.has(id)) invalidRules('Each category needs a distinct positive category ID.');
    const category = { tree: entry.attribute_tree, known: new Set(), count: 0 };
    scanRules(category.tree, category);
    categories.set(id, category);
  }

  const checks = new Map();
  if (snapshot.itemLimitResponse !== undefined) {
    const data = response(snapshot.itemLimitResponse, 'GetItemLimit');
    for (const [rule, field] of [
      ['item_name_length_limit', 'item_name'],
      ['item_description_length_limit', 'description'],
      ['item_image_count_limit', 'image.image_id_list'],
    ]) {
      if (!Object.hasOwn(data, rule)) continue;
      const { min_limit: min, max_limit: max } = data[rule] ?? {};
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
        invalidRules(`The ${rule} must contain numeric min_limit and max_limit values.`);
      }
      checks.set(field, { min, max });
    }
  }
  return { categories, checks, sample: snapshot.source === 'sample' };
}

function validDate(text, format) {
  if (/^\d{1,12}$/u.test(text)) return Number.isFinite(new Date(Number(text) * 1000).valueOf());
  if (format === 1) return /^(?:0[1-9]|1[0-2])\/\d{4}$/u.test(text);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(text);
  if (!match) return false;
  const date = new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === `${match[3]}-${match[2]}-${match[1]}`;
}

function valueIssue(value, info) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!text) return 'Enter a custom attribute value.';
  const validator = info.input_validation_type ?? 0;
  if (validator === 1 && !/^[+-]?\d+$/u.test(text)) return 'Enter an integer.';
  if (validator === 3 && (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(text) || !Number.isFinite(Number(text)))) {
    return 'Enter a decimal number.';
  }
  if (validator === 4 && !validDate(text, info.date_format_type)) {
    return info.date_format_type === 1 ? 'Use MM/YYYY or Unix seconds.' : 'Use DD/MM/YYYY or Unix seconds.';
  }
  return '';
}

function reviewAttributes(category, input, issue) {
  if (input !== undefined && !Array.isArray(input)) {
    issue('error', 'attribute_list', 'Enter an attribute list.');
    return;
  }
  const values = new Map();
  for (const [index, attribute] of (input ?? []).entries()) {
    const id = identifier(attribute?.attribute_id);
    if (!id || !Array.isArray(attribute.attribute_value_list) || values.has(id)) {
      issue('error', `attribute_list[${index}]`, 'Enter a unique attribute ID and a list of its values.');
      continue;
    }
    values.set(id, attribute.attribute_value_list);
  }

  const active = new Set();
  function check(tree) {
    for (const rule of tree) {
      const id = String(rule.attribute_id);
      const label = rule.name || `Attribute ${id}`;
      const path = `attribute_list.${id}`;
      const picked = values.get(id) ?? [];
      active.add(id);
      if (!picked.length) {
        if (rule.mandatory) issue('error', path, `${label} is required.`);
        continue;
      }

      const info = rule.attribute_info;
      const inputType = info.input_type;
      if (![1, 2, 3, 4, 5].includes(inputType)) {
        issue('warning', path, `${label} has an unrecognised input type. Review it in Seller Centre.`);
        continue;
      }
      const limit = inputType < 4 ? 1 : info.max_value_count;
      if (limit > 0 && picked.length > limit) issue('error', path, `${label} allows at most ${limit} value(s).`);
      const options = new Map((rule.attribute_value_list ?? []).map((option) => [String(option.value_id), option]));
      const used = new Set();
      for (const [index, entry] of picked.entries()) {
        const pickPath = `${path}[${index}]`;
        const custom = entry?.value_id === 0 || entry?.value_id === '0';
        const id = identifier(entry?.value_id);
        let option;
        if (custom && [2, 3, 5].includes(inputType)) {
          const problem = valueIssue(entry.original_value_name, info);
          if (problem) issue('error', pickPath, `${label}. ${problem}`);
        } else if (id && options.has(id) && inputType !== 3) {
          option = options.get(id);
        } else if (id && info.support_search_value === true && inputType !== 3) {
          issue('warning', pickPath, `${label} uses a searchable value. Confirm its ID in Shopee.`);
        } else {
          issue('error', pickPath, `Choose a valid value for ${label} from the available options.`);
          continue;
        }

        const key = custom ? JSON.stringify([String(entry.original_value_name).trim(), entry.value_unit ?? '']) : id;
        if (used.has(key)) issue('error', pickPath, `${label} contains a repeated value.`);
        used.add(key);
        if (info.format_type === 2) {
          const units = Array.isArray(info.attribute_unit_list) ? info.attribute_unit_list : [];
          if (typeof entry.value_unit !== 'string' || !entry.value_unit.trim()
              || (units.length && !units.includes(entry.value_unit))
              || (option?.value_unit && option.value_unit !== entry.value_unit)) {
            issue('error', pickPath, `${label} needs a valid unit${units.length ? ` (${units.join(', ')})` : ''}.`);
          }
        }
        if (option?.child_attribute_list?.length) check(option.child_attribute_list);
      }
    }
  }

  check(category.tree);
  for (const id of values.keys()) {
    if (active.has(id)) continue;
    if (category.known.has(id)) {
      issue('error', `attribute_list.${id}`, 'Select the associated parent option to use this child attribute.');
    } else {
      issue('warning', `attribute_list.${id}`, 'This attribute is absent from the imported category tree.');
    }
  }
}

function reviewVariants(draft, issue) {
  if (draft.tier_variation === undefined && draft.models === undefined) return;
  const tiers = draft.tier_variation;
  const models = draft.models;
  if (!Array.isArray(tiers) || !tiers.length || !Array.isArray(models) || !models.length) {
    issue('error', 'models', 'Provide option tiers and model rows together.');
    return;
  }
  const combinations = new Set();
  const names = new Set();
  tiers.forEach((tier, i) => {
    const name = typeof tier?.name === 'string' ? tier.name.trim().toLowerCase() : '';
    if (!name || names.has(name)) issue('error', `tier_variation[${i}].name`, 'Enter a distinct tier name.');
    names.add(name);
    const options = tier?.option_list;
    const labels = Array.isArray(options) ? options.map((entry) => (
      typeof entry?.option === 'string' ? entry.option.trim().toLowerCase() : '')) : [];
    if (!labels.length || labels.includes('') || new Set(labels).size !== labels.length) {
      issue('error', `tier_variation[${i}].option_list`, 'Enter distinct option names.');
    }
  });
  models.forEach((model, i) => {
    const indices = model?.tier_index;
    const path = `models[${i}].tier_index`;
    if (!Array.isArray(indices) || indices.length !== tiers.length
        || indices.some((index, tier) => !Number.isSafeInteger(index) || index < 0
          || !Array.isArray(tiers[tier]?.option_list) || index >= tiers[tier].option_list.length)) {
      issue('error', path, 'Select a valid zero-based option index for each tier.');
      return;
    }
    const key = indices.join(',');
    if (combinations.has(key)) issue('error', path, 'This variation combination appears more than once.');
    combinations.add(key);
  });
}

export function reviewDraft(rules, draft, issue) {
  const id = identifier(draft.category_id);
  const category = rules.categories.get(id);
  if (!category) issue('error', 'category_id', 'Use a Singapore leaf category included in the imported attribute tree.');
  else reviewAttributes(category, draft.attribute_list, issue);
  for (const field of ['item_name', 'description']) {
    const value = draft[field];
    if (typeof value !== 'string' || !value.trim()) {
      issue('error', field, `Enter a product ${field === 'item_name' ? 'title' : 'description'}.`);
      continue;
    }
    const limit = rules.checks.get(field);
    const length = Array.from(value.trim()).length;
    if (limit && (length < limit.min || length > limit.max)) {
      issue('error', field, `Use ${limit.min}–${limit.max} characters. Found ${length}.`);
    }
  }

  const images = rules.checks.get('image.image_id_list');
  if (images) {
    const values = draft.image?.image_id_list;
    if (!Array.isArray(values) || values.length < images.min || values.length > images.max
        || values.some((value) => typeof value !== 'string' || !value.trim())
        || new Set(values).size !== values.length) {
      issue('error', 'image.image_id_list', `Provide ${images.min}–${images.max} distinct image IDs.`);
    }
  }
  reviewVariants(draft, issue);
}
