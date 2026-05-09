/**
 * v1 verbatim-port shim for `brandReportResources`. Every export name
 * and signature is identical between v1's utility and v2's
 * `lib/brandReportResourcesApi.js` — so this module is a pass-through.
 * Kept at this path so `import ... from '../../utils/brandReportResources'`
 * in ported v1 components resolves without modification.
 */

export {
  getBrandReportResources,
  addReportSection,
  renameReportSection,
  removeReportSection,
  addReportLink,
  updateReportLink,
  removeReportLink,
} from '../lib/brandReportResourcesApi';
