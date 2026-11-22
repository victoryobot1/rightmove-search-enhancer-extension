// Rightmove's track, background side: what the lookup pipeline needs to know about
// rightmove.co.uk. The content side (where sizes appear on its pages) is src/content/rightmove.js.
import { extractPageModel } from '../pageModel.js';

const ORIGIN = 'https://www.rightmove.co.uk';
const isId = (id) => typeof id === 'string' && /^\d+$/.test(id);

export default {
  id: 'rightmove',
  name: 'Rightmove',
  homeUrl: `${ORIGIN}/`,

  /** @param {URL} url */
  matches: (url) => url.protocol === 'https:' && /(^|\.)rightmove\.co\.uk$/i.test(url.hostname),

  // { site: 'rightmove', id: '95556576' } and nothing else.
  isListing: (listing) => Object.keys(listing).length === 2 && isId(listing.id),

  listingUrl: (listing) => `${ORIGIN}/properties/${listing.id}`,

  /**
   * A property page's HTML → the fields the lookup pipeline reads, or null if the page
   * has no readable model.
   */
  readListing(html) {
    const pd = extractPageModel(html)?.propertyData;
    if (!pd) return null;
    const urls = (items) => (Array.isArray(items) ? items : []).map((item) => item?.url).filter((url) => typeof url === 'string');
    return {
      sizings: pd.sizings,
      description: typeof pd.text?.description === 'string' ? pd.text.description : '',
      keyFeatures: Array.isArray(pd.keyFeatures) ? pd.keyFeatures : [],
      floorplans: urls((pd.floorplans || []).filter((f) => !f?.type || f.type === 'IMAGE')),
      brochures: urls(pd.brochures),
      bedrooms: pd.bedrooms,
    };
  },

  /**
   * Where to fetch the results a search page shows, or null if we can't for this page.
   * The map view (…/map.html) fetches its pins from this endpoint with its own query
   * string, so the same query gives the same pins. List pages have no such endpoint;
   * their first page of results is embedded in the page instead.
   */
  searchApiUrl(pageUrl) {
    const url = new URL(pageUrl);
    return url.pathname.endsWith('/map.html') ? `${ORIGIN}/api/property-search/map/search${url.search}` : null;
  },

  /**
   * Search results, as a search page embeds them (list: `properties`; map:
   * `geoJsonProperties`) → one entry per listing. Entries with a malformed id are dropped.
   * @returns {{ listing: object, lat: number|null, lng: number|null, displaySize: string }[]}
   */
  readSearch(json) {
    const items = json?.geoJsonProperties?.features?.map((feature) => feature?.properties) ?? json?.properties;
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item?.id ?? '');
      if (!isId(id)) continue;
      const lat = item.location?.latitude;
      const lng = item.location?.longitude;
      out.push({
        listing: { site: 'rightmove', id },
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        displaySize: typeof item.displaySize === 'string' ? item.displaySize : '',
      });
    }
    return out;
  },
};
