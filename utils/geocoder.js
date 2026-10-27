/**
 * Nominatim geocoder utility for server-side address → pincode resolution.
 * Uses OpenStreetMap Nominatim — free, no API key, India-scoped.
 */

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "Sustainify/1.0 (scrap-recycling-platform)";

/**
 * Forward geocode: search an address string and return the best Indian match.
 * @param {string} addressQuery - Free-text address (e.g. "Sector 62 Noida")
 * @returns {Promise<{formattedAddress: string, pincode: string|null, lat: number, lng: number}|null>}
 */
async function nominatimSearch(addressQuery) {
  if (!addressQuery || addressQuery.trim().length < 3) return null;

  const url =
    `${NOMINATIM_BASE}/search?` +
    `q=${encodeURIComponent(addressQuery.trim())}` +
    `&countrycodes=in&format=json&addressdetails=1&limit=1`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const results = await res.json();
    if (!results || results.length === 0) return null;

    const best = results[0];
    return {
      formattedAddress: best.display_name || addressQuery,
      pincode: (best.address && best.address.postcode) || null,
      lat: parseFloat(best.lat),
      lng: parseFloat(best.lon),
    };
  } catch (err) {
    console.warn("[Geocoder] Nominatim lookup failed:", err.message);
    return null;
  }
}

module.exports = { nominatimSearch };
