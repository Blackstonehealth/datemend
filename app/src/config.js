// Product name (chosen 2026-10-18). NOTE: the product name must not contain "Snap".
export const PRODUCT_NAME = 'Datemend';
export const VERSION = '0.1.0-preview';

// Defaults used by the pipeline and the UI.
export const DEFAULTS = Object.freeze({
  layout: 'year-month', // 'year-month' | 'year' | 'flat'
  overlayMode: 'merge', // 'merge' | 'sidecar' | 'both'
  jpegQuality: 0.95,
  minPlausibleYear: 2010, // earlier dates (1970 epoch zero etc.) are treated as missing
  maxZipPartBytes: 1.5 * 1024 * 1024 * 1024, // Blob-download fallback: split output zips here
});
