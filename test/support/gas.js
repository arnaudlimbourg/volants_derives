// Charge apps-script/Code.gs dans un contexte vm avec des faux services Google en mémoire.
import fs from 'node:fs';
import vm from 'node:vm';

const CODE = fs.readFileSync(new URL('../../apps-script/Code.gs', import.meta.url), 'utf8');

const isDate = (value) => Object.prototype.toString.call(value) === '[object Date]';

/** Une feuille réduite à ce que Code.gs utilise. Les lignes sont des tableaux de valeurs. */
class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.formulas = {};
    this.frozenRows = 0;
    this.formats = {}; // 'ligne,colonne' → (valeur) => texte affiché, comme un format de cellule

  }

  getLastRow() {
    return this.rows.length;
  }

  getDataRange() {
    const width = Math.max(1, ...this.rows.map((row) => row.length));
    const grid = (this.rows.length ? this.rows : [[]]).map((row) =>
      Array.from({ length: width }, (_, i) => (row[i] === undefined ? '' : row[i])));
    return {
      getValues: () => grid.map((row) => [...row]),
      getDisplayValues: () => grid.map((row, r) => row.map((v, c) => {
        const format = this.formats[`${r + 1},${c + 1}`];
        if (format) return format(v);
        return isDate(v) ? v.toISOString() : String(v);
      })),
    };
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return {
      getValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numColumns }, (__, j) => {
        const value = (this.rows[row - 1 + i] || [])[column - 1 + j];
        return value === undefined ? '' : value;
      })),
      setValues: (values) => {
        if (values.length !== numRows || values.some((v) => v.length !== numColumns)) {
          throw new Error(`Dimensions invalides : ${values.length}×${values[0]?.length} pour ${numRows}×${numColumns}`);
        }
        values.forEach((rowValues, i) => {
          const target = this.rows[row - 1 + i] || (this.rows[row - 1 + i] = []);
          rowValues.forEach((value, j) => {
            // Comme Sheets : l'apostrophe de tête force le texte et n'est pas affichée.
            target[column - 1 + j] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
          });
        });
      },
      setFormula: (formula) => {
        this.formulas[`${row},${column}`] = formula;
      },
    };
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }
}

export function createGas() {
  const sheets = new Map();
  const properties = new Map();
  const mails = [];
  const warnings = [];
  const cache = new Map();
  let mailFails = false;

  const spreadsheet = {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const sheet = new FakeSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
  };

  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cache.has(key) ? cache.get(key) : null),
        put: (key, value) => cache.set(key, String(value)),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => properties.set(key, String(value)),
      }),
    },
    MailApp: {
      sendEmail: (message) => {
        if (mailFails) throw new Error('Quota email dépassé');
        mails.push(message);
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    console: { log() {}, warn: (m) => warnings.push(String(m)), error() {} },
  });
  vm.runInContext(CODE, context, { filename: 'Code.gs' });

  return {
    gas: context,
    sheets,
    sheet: (name) => sheets.get(name),
    mails,
    warnings,
    setMailFailure: (fails) => { mailFails = fails; },
    expireCache: () => cache.clear(),
  };
}

/** Les objets créés dans le vm ont d'autres prototypes : on les normalise avant deepEqual. */
export const plain = (value) => JSON.parse(JSON.stringify(value));
