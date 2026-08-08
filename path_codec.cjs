/* =========================
 * Flight path codec — compact binary trails
 * =========================
 *
 * Why this exists
 * ---------------
 * Trails used to live in the database as a JSON array of arrays:
 *
 *   [[12.3456,-98.7654,35000,478,1712345678901,271], ...]
 *
 * which costs ~45-55 bytes per point, and — far worse — had to be re-parsed
 * and re-serialised in full on every poll, because appending one point meant
 * rewriting the whole column. A ten-hour flight reaches MAX_POINTS_PER_FLIGHT
 * and rewrites ~75 KB every fifteen seconds. Multiply by the number of
 * aircraft airborne and that write amplification, not disk price, is what kept
 * the retention window pinned at 48 hours.
 *
 * This module fixes the per-point cost. history.cjs fixes the per-poll cost by
 * only sealing a chunk occasionally (see "Chunks" below).
 *
 * Encoding
 * --------
 * Points are stored as zig-zag varint deltas against the previous point. The
 * quantities a trail records barely move between two samples fifteen seconds
 * apart, so the deltas are small and land in one or two bytes each where the
 * absolute values needed five to thirteen.
 *
 * Precision is deliberately identical to the JSON format it replaces:
 *
 *   lat/lon   1e-4 degrees (~11 m)   — same rounding the old packPoint applied
 *   alt       1 ft                    — same
 *   gs        1 kt                    — same
 *   hdg       1 degree                — same
 *   time      1 ms, exact             — same
 *
 * Nothing is thrown away, so this is a pure storage change: decode(encode(p))
 * returns exactly what the old readPath would have returned for the same
 * input. Timestamps in particular stay exact to the millisecond, because
 * getFlightPath() clamps trails with `p.time <= untilMs` to guarantee the tail
 * of a trail can never be drawn ahead of the live marker. Rounding them to
 * whole seconds would have saved about one byte per point and put that
 * invariant at risk for no meaningful gain.
 *
 * Chunks
 * ------
 * A stored blob is a plain concatenation of self-contained chunks:
 *
 *   blob  := chunk*
 *   chunk := magic u8 | version u8 | varint count | absolute point | delta*
 *
 * Each chunk restarts from an absolute point, which is the property that makes
 * appending cheap: sealing new points onto a trail is a Buffer.concat of the
 * existing blob and a freshly encoded chunk. The existing blob is never
 * decoded, re-encoded, or even inspected. Decoding walks chunks end to end.
 *
 * The cost of restarting is one absolute point per chunk (~20 bytes against
 * ~9 for a delta point), so chunks want to be big enough to amortise that and
 * small enough that the hot tail stays cheap to rewrite. history.cjs picks the
 * size; at its default of 48 points the overhead is under 3%.
 *
 * Deliberately not compressed
 * ---------------------------
 * Running deflate over sealed chunks buys roughly a further 30%, but every
 * read then pays an inflate — including the ATC replay sweep, which decodes
 * every flight in a window to build a session. Trading read CPU for
 * disk was the wrong side of the deal when the delta encoding had already
 * taken the bulk of the win. The chunk header carries a version byte, so a
 * compressed chunk type can be added later without breaking blobs on disk.
 */

'use strict';

const CHUNK_MAGIC = 0xb1;
const CHUNK_VERSION = 1;

/* ---------- varints ----------
 * Arithmetic rather than bit-shifts throughout: timestamps are ~1.7e12 and
 * JavaScript's bitwise operators truncate to 32 bits, which would silently
 * mangle them. Math.floor/% is exact for every integer up to 2^53.
 */

function writeVarint(out, n) {
  n = Math.floor(n);
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function readVarint(buf, state) {
  let result = 0;
  let scale = 1;
  for (;;) {
    if (state.i >= buf.length) throw new RangeError('varint runs past end of buffer');
    const b = buf[state.i++];
    result += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return result;
    scale *= 128;
  }
}

// Zig-zag: interleave negatives with positives so small magnitudes of either
// sign stay in one byte. -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4, ...
const zigzag = (n) => (n < 0 ? -n * 2 - 1 : n * 2);
const unzigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function writeSignedVarint(out, n) {
  writeVarint(out, zigzag(Math.round(n)));
}

function readSignedVarint(buf, state) {
  return unzigzag(readVarint(buf, state));
}

/* ---------- quantisation ----------
 * Matches the old packPoint() exactly, so migrated trails are bit-identical to
 * what the JSON format held.
 */

const toFixed4 = (v) => Math.round((Number(v) || 0) * 10000);
const fromFixed4 = (v) => v / 10000;
const toInt = (v) => Math.round(Number(v) || 0);

// Headings are integers on 0..359, so the shortest way round is never more
// than 180 — folding the delta into [-180, 180) keeps it inside a single byte
// even when the aircraft crosses north.
const foldHeading = (delta) => ((((delta % 360) + 540) % 360)) - 180;
const wrapHeading = (h) => ((h % 360) + 360) % 360;

/**
 * Encodes an array of {lat, lon, alt, gs, time, hdg} into one self-contained
 * chunk. Returns an empty Buffer for an empty input so callers can concat
 * unconditionally.
 */
function encodeChunk(points) {
  if (!Array.isArray(points) || points.length === 0) return Buffer.alloc(0);

  const out = [CHUNK_MAGIC, CHUNK_VERSION];
  writeVarint(out, points.length);

  const first = points[0];
  let lat = toFixed4(first.lat);
  let lon = toFixed4(first.lon);
  let alt = toInt(first.alt);
  let gs = toInt(first.gs);
  let time = Math.floor(Number(first.time) || 0);
  let hdg = wrapHeading(toInt(first.hdg));

  // The opening point of a chunk is absolute; everything after is a delta.
  writeSignedVarint(out, lat);
  writeSignedVarint(out, lon);
  writeSignedVarint(out, alt);
  writeSignedVarint(out, gs);
  writeVarint(out, time);
  writeVarint(out, hdg);

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const nLat = toFixed4(p.lat);
    const nLon = toFixed4(p.lon);
    const nAlt = toInt(p.alt);
    const nGs = toInt(p.gs);
    const nTime = Math.floor(Number(p.time) || 0);
    const nHdg = wrapHeading(toInt(p.hdg));

    writeSignedVarint(out, nLat - lat);
    writeSignedVarint(out, nLon - lon);
    writeSignedVarint(out, nAlt - alt);
    writeSignedVarint(out, nGs - gs);
    // Time only ever advances — shouldSkipPoint() drops any report that
    // doesn't — so this stays an unsigned varint. Guard anyway rather than
    // encode a negative as a huge unsigned value.
    writeVarint(out, Math.max(0, nTime - time));
    writeSignedVarint(out, foldHeading(nHdg - hdg));

    lat = nLat; lon = nLon; alt = nAlt; gs = nGs; hdg = nHdg;
    time = Math.max(time, nTime);
  }

  return Buffer.from(out);
}

/**
 * Decodes a blob of one or more concatenated chunks back into
 * {lat, lon, alt, gs, time, hdg} objects.
 *
 * A truncated or corrupt blob yields everything decoded up to the damage
 * rather than throwing: a partially readable trail is worth more to a replay
 * than an exception, and a torn write should never take out the whole flight.
 */
function decodeBlob(buf) {
  if (!buf || buf.length === 0) return [];
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

  const points = [];
  const state = { i: 0 };

  try {
    while (state.i < buf.length) {
      if (buf[state.i] !== CHUNK_MAGIC) break;
      const version = buf[state.i + 1];
      if (version !== CHUNK_VERSION) break;
      state.i += 2;

      const count = readVarint(buf, state);
      if (count <= 0) break;

      let lat = readSignedVarint(buf, state);
      let lon = readSignedVarint(buf, state);
      let alt = readSignedVarint(buf, state);
      let gs = readSignedVarint(buf, state);
      let time = readVarint(buf, state);
      let hdg = readVarint(buf, state);

      points.push({ lat: fromFixed4(lat), lon: fromFixed4(lon), alt, gs, time, hdg });

      for (let n = 1; n < count; n++) {
        lat += readSignedVarint(buf, state);
        lon += readSignedVarint(buf, state);
        alt += readSignedVarint(buf, state);
        gs += readSignedVarint(buf, state);
        time += readVarint(buf, state);
        hdg = wrapHeading(hdg + readSignedVarint(buf, state));

        points.push({ lat: fromFixed4(lat), lon: fromFixed4(lon), alt, gs, time, hdg });
      }
    }
  } catch (e) {
    // Fall through with whatever decoded cleanly.
  }

  return points;
}

/** Appends an encoded chunk to an existing blob without decoding either. */
function appendChunk(existingBlob, points) {
  const chunk = encodeChunk(points);
  if (chunk.length === 0) return existingBlob || Buffer.alloc(0);
  if (!existingBlob || existingBlob.length === 0) return chunk;
  return Buffer.concat([Buffer.isBuffer(existingBlob) ? existingBlob : Buffer.from(existingBlob), chunk]);
}

/** Re-encodes a whole trail as a single chunk. Used when trimming rewrites it. */
function encodeAll(points) {
  return encodeChunk(points);
}

module.exports = {
  encodeChunk,
  encodeAll,
  decodeBlob,
  appendChunk,
  CHUNK_MAGIC,
  CHUNK_VERSION,
  // Exported for tests.
  _internals: { writeVarint, readVarint, zigzag, unzigzag, foldHeading, wrapHeading }
};
