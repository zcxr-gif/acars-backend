/* =========================
 * Airport coordinates, and the distance between two points
 * =========================
 * Both of these were private to `push.cjs`, where they existed to work out how
 * far a Live Activity's aeroplane still had to run. The "thirty minutes out"
 * notice needs exactly the same two things — where the arrival field is, and
 * how far away it is — and a second copy of a haversine is a second copy that
 * can be wrong on its own.
 *
 * `airports.json` is ~12 MB and is parsed once, lazily: a process that never
 * asks for a coordinate never pays for it.
 */

const fs = require('fs');
const path = require('path');

const EARTH_RADIUS_NM = 3440.065;

let airportsIndex = null;

/** `{ lat, lon, … }` for an ICAO, or null for one the dataset doesn't carry. */
function airportCoords(icao) {
  if (!airportsIndex) {
    try {
      airportsIndex = JSON.parse(fs.readFileSync(path.join(__dirname, 'airports.json'), 'utf8'));
    } catch (e) {
      console.error('[geo] ❌ Could not load airports.json:', e.message);
      airportsIndex = {};
    }
  }
  const a = airportsIndex[String(icao || '').toUpperCase()];
  return a && typeof a.lat === 'number' && typeof a.lon === 'number' ? a : null;
}

/** Great-circle distance in nautical miles. */
function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * How far a flight still has to run, in nautical miles, or null when either
 * end of that sum is missing.
 *
 * Test seam as much as anything: `airportCoords` reads a 12 MB file, and a
 * test that wants to assert what happens 200 miles out should be able to say
 * so without one.
 */
function distanceToArrivalNm(flight, coords = airportCoords) {
  const pos = flight?.position;
  if (typeof pos?.lat !== 'number' || typeof pos?.lon !== 'number') return null;
  const dest = coords(flight?.arrivalIcao);
  if (!dest) return null;
  return haversineNm(pos.lat, pos.lon, dest.lat, dest.lon);
}

module.exports = {
  airportCoords,
  haversineNm,
  distanceToArrivalNm,
  EARTH_RADIUS_NM,
};
