// Régénère le catalogue utilisé par le mode démo (?demo) à partir du catalogue de départ de Code.gs.
import fs from 'node:fs';
import { createGas, plain } from '../test/support/gas.js';

const { gas } = createGas();
gas.setupSheet();
const catalogue = plain(gas.getCatalogue());
fs.writeFileSync(new URL('../fixtures/catalogue.json', import.meta.url), `${JSON.stringify(catalogue, null, 2)}\n`);
console.log(`fixtures/catalogue.json : ${catalogue.products.length} produits`);
