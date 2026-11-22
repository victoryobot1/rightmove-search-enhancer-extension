// Checks on URLs taken from listings (agent-written brochure links) before we fetch them.

const LOCAL_NAME_RE = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i;

// Hosts on the user's own machine or network. The URL parser already normalises IPv4
// tricks like "0x7f000001" or "127.1" to dotted form, so one pattern catches them.
function isLocalHost(hostname) {
  if (hostname.startsWith('[')) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4 literal (no brochure is hosted on a bare IP)
  if (!hostname.includes('.')) return true; // single-label intranet names
  return LOCAL_NAME_RE.test(hostname);
}

/**
 * Brochure links are written by agents, so check one before fetching it: https only
 * (http is upgraded), default port, no credentials, nothing on the local network.
 * @returns {URL | null}
 */
export function safeExternalUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (isLocalHost(url.hostname)) return null;
  return url;
}
