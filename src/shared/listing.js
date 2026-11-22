// A listing is an object: the site it's on, plus whatever fields identify it there.
// Rightmove's are { site: 'rightmove', id: '95556576' }; a site with a composite identity
// adds its own fields. listingKey() turns one into the string used for Map keys and the
// cache: the site, then the other fields' values in field-name order, each URI-encoded so
// an id containing ":" or "/" (a URL, say) can't collide with another listing's.
//
// Loaded as a plain script by the content scripts (see manifest.json) and imported for its
// side effect by background.js, so both share this one definition.
globalThis.listingKey = function listingKey(listing) {
  const fields = Object.keys(listing)
    .filter((name) => name !== 'site')
    .sort();
  return [listing.site, ...fields.map((name) => encodeURIComponent(listing[name]))].join(':');
};
