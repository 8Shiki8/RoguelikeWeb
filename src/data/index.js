/**
 * Public entry point for the data layer.
 *
 * Import from here (not from the individual modules) so callers depend on one
 * seam: `loadGameData('excel')` for the authored workbook, `loadGameData('json')`
 * for the generated files, with no change in src/core. Both bundled sources are
 * registered exactly once, here, at module load.
 */

import { excelSource } from './excelSource.js';
import { jsonSource } from './jsonSource.js';
import { registerSource } from './source.js';

export { DATA_VERSION, createGameData, freezeGameData } from './model.js';
export { DataError, ITEM_SLOTS, ANY_ENEMY, LIMITS, validateGameData } from './schema.js';
export { getSource, listSources, loadGameData, registerSource } from './source.js';
export { jsonSource } from './jsonSource.js';
export { excelSource } from './excelSource.js';

registerSource(jsonSource);
registerSource(excelSource);
