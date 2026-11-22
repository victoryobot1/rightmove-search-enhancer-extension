// The sites the extension works on. Adding one: see "Adding a site" in CLAUDE.md.
import rightmove from './rightmove.js';

export const SITES = { [rightmove.id]: rightmove };

/** The site a page URL belongs to, or null. Chrome hides URLs of sites we lack access to, so `url` may be undefined. */
export function siteForUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return Object.values(SITES).find((site) => site.matches(parsed)) ?? null;
}

/**
 * Checks a listing that arrived in a message: a known site, and exactly the fields that
 * site uses. Messages come from our own content scripts, but the values in them were read
 * off a web page.
 * @returns {object | null} the listing, or null if it's malformed
 */
export function parseListing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const site = Object.hasOwn(SITES, raw.site) ? SITES[raw.site] : null;
  return site?.isListing(raw) ? raw : null;
}
