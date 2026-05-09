/**
 * v1 verbatim-port shim for monthlyReportingService — re-exports the
 * v1-compat layer in lib/reportsApi.js. Keeps v1 import paths working.
 */

export {
  // Period helpers
  makeMonthInfo,
  detectNextMonth,
  getFirstTimeMonthOptions,
  buildMonthInfo,

  // Sections (the 15-section monthly toggle)
  MONTHLY_SECTIONS,
  resolveSectionsEnabled,

  // Empty template
  emptyMonthlyReport,

  // CRUD
  saveMonthlyReport,
  getMonthlyReport,
  getMonthlyReportsForBrand,
  getAllMonthlyReports,
  getMonthlyReportsForTL,
  deleteMonthlyReport,
  changeMonthlyReportMonth,
  editMonthlyReportMonth,
  updateReportStatus,

  // Comparison
  findPreviousMonthlyReport,

  // Status palette
  REPORT_STATUSES,
  getReportStatus,

  // User custom fields (shared with weekly/biweekly forms)
  getUserCustomFields,
  saveUserCustomFields,

  // Numeric helpers (used by MonthlyReportView for delta math)
  num,
  pctChange,
  cleanNumericInput,
} from '../lib/reportsApi';
