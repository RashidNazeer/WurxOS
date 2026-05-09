/**
 * v1 verbatim-port shim for biWeeklyReportingService — re-exports the
 * v1-compat layer in lib/reportsApi.js. Keeps v1 import paths working.
 */

export {
  // Period helpers
  getBiWeeklyPeriodsFromAnchor,
  detectNextBiWeeklyPeriod,
  buildPeriodInfoFromRange,

  // Anchor CRUD
  getBiWeeklyAnchor,
  setBiWeeklyAnchor,

  // Empty template
  emptyBiWeeklyReport,

  // CRUD
  saveBiWeeklyReport,
  getBiWeeklyReport,
  getBiWeeklyReportsForBrand,
  getAllBiWeeklyReports,
  getBiWeeklyReportsForTL,
  deleteBiWeeklyReport,
  changeBiWeeklyReportPeriod,
  editBiWeeklyReportDates,
  updateReportStatus,

  // Status palette
  REPORT_STATUSES,
  getReportStatus,
} from '../lib/reportsApi';
