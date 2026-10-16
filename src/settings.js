export const DEFAULT_SETTINGS = {
  enabled: true,
  unit: 'sqft', // 'sqft' | 'sqm' | 'both'
  showPricePerSqft: true,
  ocrFloorplans: true,
  scanBrochures: true,
  externalBrochures: false, // agent websites outside rightmove.co.uk; needs an optional host permission
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}
