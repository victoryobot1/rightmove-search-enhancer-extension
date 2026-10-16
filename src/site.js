export const RIGHTMOVE_URL = 'https://www.rightmove.co.uk/';

// Chrome only exposes tab URLs for hosts we have permission for, so any other
// site arrives here as `undefined` — which is correctly treated as "not Rightmove".
export function isRightmoveUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && /(^|\.)rightmove\.co\.uk$/i.test(hostname);
  } catch {
    return false;
  }
}
