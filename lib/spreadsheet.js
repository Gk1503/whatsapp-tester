// Shared spreadsheet helpers: fuzzy column matching, {ColumnName} template
// resolution, and CSV/formula-injection neutralization for generated
// exports. Every spreadsheet is treated as untrusted input.
const NAME_KEYS = ['name', 'contactname', 'fullname', 'contact'];
const NUMBER_KEYS = ['number', 'phone', 'mobile', 'phonenumber', 'contactnumber', 'whatsapp', 'whatsappnumber'];
const MESSAGE_KEYS = ['message', 'msg', 'text', 'content'];

const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;
const MAX_CELL_LEN = 4096;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickField(row, candidateKeys) {
  const normalizedEntries = Object.keys(row).map((k) => [normalizeKey(k), row[k]]);
  for (const candidate of candidateKeys) {
    const hit = normalizedEntries.find(([k]) => k === candidate);
    if (hit && String(hit[1]).trim()) return String(hit[1]).trim();
  }
  return '';
}

// Resolves {ColumnName} placeholders in a template against a row's raw spreadsheet
// columns (case/whitespace-insensitive match on the header). Unrecognized placeholders
// are left as-is so a typo shows up in the preview instead of silently vanishing.
// Deliberately regex-based substitution only — never eval/new Function.
function resolveTemplate(template, data) {
  if (!template) return '';
  return String(template).replace(/\{([^{}]+)\}/g, (match, key) => {
    const target = key.trim().toLowerCase();
    const foundKey = Object.keys(data || {}).find((k) => k.trim().toLowerCase() === target);
    return foundKey !== undefined ? String(data[foundKey] ?? '') : match;
  });
}

// Prevents CSV/formula injection when a generated sheet is opened in
// Excel/Sheets: a cell value starting with =, +, -, or @ can execute as a
// formula. Prefixing with a leading apostrophe forces it to render as text.
const DANGEROUS_PREFIXES = ['=', '+', '-', '@'];
function neutralizeFormula(value) {
  const str = String(value ?? '');
  if (DANGEROUS_PREFIXES.some((p) => str.startsWith(p))) return `'${str}`;
  return str;
}

function enforceSheetLimits(rawRows) {
  if (rawRows.length > MAX_ROWS) {
    const err = new Error(`Sheet has ${rawRows.length} rows, which exceeds the ${MAX_ROWS} row limit.`);
    err.name = 'SheetTooLargeError';
    throw err;
  }
  for (const row of rawRows) {
    const keys = Object.keys(row);
    if (keys.length > MAX_COLUMNS) {
      const err = new Error(`A row has ${keys.length} columns, which exceeds the ${MAX_COLUMNS} column limit.`);
      err.name = 'SheetTooLargeError';
      throw err;
    }
    for (const k of keys) {
      if (String(row[k]).length > MAX_CELL_LEN) {
        const err = new Error(`A cell exceeds the ${MAX_CELL_LEN} character limit.`);
        err.name = 'SheetTooLargeError';
        throw err;
      }
    }
  }
}

module.exports = {
  NAME_KEYS,
  NUMBER_KEYS,
  MESSAGE_KEYS,
  MAX_ROWS,
  MAX_COLUMNS,
  MAX_CELL_LEN,
  normalizeKey,
  pickField,
  resolveTemplate,
  neutralizeFormula,
  enforceSheetLimits
};
