/**
 * v1 verbatim-port shim — re-exports the v1-compat layer from
 * `lib/reportsApi.js` (the layer was added in the Stage 2 commit) so
 * any ported v1 component that does:
 *
 *   import { saveReport, getReportsForBrand, ... } from '../../utils/reportingService';
 *
 * resolves without modification. The actual implementations all live in
 * lib/reportsApi.js — this module is just a path-alias.
 *
 * v1 weekly-only exports surface here. Bi-weekly and monthly have their
 * own shim files at the v1 paths (biWeeklyReportingService.js / monthlyReportingService.js).
 */

export {
  // Period helpers
  makeWeekFromStart,
  getWeeksForMonth,
  detectNextWeek,
  getAnchorDate,
  getFirstTimeWeekOptions,
  buildWeekInfoFromRange,

  // Empty template
  emptyReport,

  // CRUD
  saveReport,
  getReportV1 as getReport,
  getReportsForBrand,
  getAllReports,
  getReportsForTL,
  deleteReport,
  changeReportWeek,
  editReportDatesV1 as editReportDates,
  updateReportStatus,

  // Status helpers
  REPORT_STATUSES,
  getReportStatus,

  // Comparison helpers
  findPreviousReport,
  pctChange,
  num,
  cleanNumericInput,

  // User custom fields
  getUserCustomFields,
  saveUserCustomFields,

  // Legacy label repair (Boss-only utility)
  repairWeeklyLabels,
} from '../lib/reportsApi';
