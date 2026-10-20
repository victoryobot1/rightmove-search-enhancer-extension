import { DEFAULT_SETTINGS, getSettings } from './settings.js';
import { RIGHTMOVE_URL, isRightmoveUrl } from './site.js';

const EXTERNAL_ORIGINS = { origins: ['https://*/*'] }; // brochure links are upgraded to https

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isRightmoveUrl(tab?.url)) {
    document.getElementById('unsupported').hidden = false;
    document.getElementById('openRightmove').addEventListener('click', () => {
      chrome.tabs.create({ url: RIGHTMOVE_URL });
      window.close();
    });
    return;
  }
  document.getElementById('settings').hidden = false;

  const settings = await getSettings();

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
    else el.value = settings[key];
    el.addEventListener('change', () => save(key, el));
  }

  // The permission may have been revoked from chrome://extensions.
  if (settings.externalBrochures && !(await chrome.permissions.contains(EXTERNAL_ORIGINS))) {
    document.getElementById('externalBrochures').checked = false;
    await chrome.storage.sync.set({ externalBrochures: false });
  }

  document.getElementById('clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    refreshStats();
  });
  refreshStats();
}

async function save(key, el) {
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (key === 'externalBrochures') {
    value = value
      ? await chrome.permissions.request(EXTERNAL_ORIGINS)
      : !(await chrome.permissions.remove(EXTERNAL_ORIGINS));
    el.checked = value;
  }
  await chrome.storage.sync.set({ [key]: value });
}

async function refreshStats() {
  const stats = await chrome.runtime.sendMessage({ type: 'cacheStats' });
  document.getElementById('stats').textContent = stats
    ? `${stats.found} of ${stats.total} cached listings have a size`
    : '';
}

init();
