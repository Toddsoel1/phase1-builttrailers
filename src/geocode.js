// Geocode a US address to { lat, lng } via OpenStreetMap / Nominatim — free, no API key.
// Best-effort: returns null on any failure (network, no match, timeout) so saving a dealer never
// blocks on geocoding; the office can set coordinates manually instead. Nominatim requires a
// descriptive User-Agent and asks for light, non-bulk use, which fits geocoding-on-save here.
// Disabled in tests (GEOCODE_DISABLED=1) so the suite never touches an external service.
export async function geocodeAddress({ address, city, state, zip } = {}) {
  if (process.env.GEOCODE_DISABLED === '1') return null;
  const query = [address, city, state, zip].map(s => (s || '').trim()).filter(Boolean).join(', ');
  if (!query) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'BuiltTrailers/1.0 (dealer locator)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const hit = (await r.json())?.[0];
    if (!hit) return null;
    const lat = Number(hit.lat), lng = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch { return null; }
}
