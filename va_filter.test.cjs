/**
 * va_filter.test.cjs — which live callsigns count as a given VA's.
 *
 * Run with: npm test   (or: node va_filter.test.cjs)
 *
 * This is the gate in front of every VA's Discord feed and every VA embed, and
 * both of its failure modes are visible to a paying VA: a member who doesn't
 * appear reads as "the map is broken", and a stranger who does appear reads as
 * "you posted somebody else's flight to our channel". The rule is therefore
 * pinned here rather than left to be re-derived.
 *
 * The three modes a VA can choose between are the subject:
 *
 *   exact  — "<prefix><number><tag>" and nothing else. Nothing that isn't
 *            theirs gets through; a loosely typed callsign doesn't either.
 *   strict — (default) the tag may sit on either of the last two tokens, so a
 *            pilot may append a division/event code after the VA tag.
 *   broad  — the airline name alone is enough.
 *
 * The same three rules are implemented a second time, in the widget
 * (tracker/embed.js callsignMatches). If this file changes, that one has to.
 */

const assert = require('assert');
const {
  normalizeConfig, callsignMatches, matchMode, setVaConfigs, setRosterWatch, isWatchedPilot,
} = require('./va_filter.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The shape a va-ads listing arrives in: a callsign mask plus the chosen mode.
const va = (callsign, callsignMatch, extra = {}) =>
  normalizeConfig({ callsign, callsignMatch, ...extra });

// Assert a whole table of callsigns against one config in one go, so a failure
// names the exact callsign rather than "expected false, got true".
const expect = (cfg, table) => {
  for (const [callsign, want] of table) {
    assert.strictEqual(
      callsignMatches(callsign, cfg), want,
      `${JSON.stringify(callsign)} should ${want ? 'match' : 'NOT match'} ` +
      `[${cfg.match}] prefixes=${JSON.stringify(cfg.prefixes)} suffixes=${JSON.stringify(cfg.suffixes)}`,
    );
  }
};

/* =========================
 * Mask parsing
 * ========================= */

test('a callsign mask splits into the whole airline name and the tag', () => {
  const cfg = va('Air Canada ##VA');
  assert.deepStrictEqual(cfg.prefixes, ['AIRCANADA']);
  assert.deepStrictEqual(cfg.suffixes, ['VA']);
});

test('every callsign a VA flies under contributes a prefix', () => {
  // A listing with a parent brand and a sub-fleet used to match only the first,
  // silently dropping half its pilots.
  const cfg = normalizeConfig({ callsigns: ['OCEAN ##VA', 'SHAMROCK ###EX'] });
  assert.deepStrictEqual(cfg.prefixes, ['OCEAN', 'SHAMROCK']);
  assert.deepStrictEqual(cfg.suffixes, ['VA', 'EX']);
});

test('a listing with an EMPTY callsigns[] still matches on its legacy callsign', () => {
  // Older documents carry the single `callsign` with `callsigns` left empty, and
  // an empty array is truthy — so a plain `q.callsigns || q.callsign` resolves
  // to [] here and the VA silently stops matching anything at all.
  const cfg = normalizeConfig({ name: 'Ocean', callsign: 'OCEAN ##VA', callsigns: [] });
  assert.deepStrictEqual(cfg.prefixes, ['OCEAN']);
  assert.deepStrictEqual(cfg.suffixes, ['VA']);
  assert.strictEqual(callsignMatches('Ocean 12VA', cfg), true);
});

test('a VA with no callsign at all is dropped, not left matching everything', () => {
  const kept = setVaConfigs([
    { name: 'Ocean', callsign: 'OCEAN ##VA', callsigns: [] },
    { name: 'Ghost', callsign: null, callsigns: [] },
  ]);
  assert.strictEqual(kept, 1);
});

/* =========================
 * Several callsigns, and they need not work alike
 * ========================= */

test('exact holds each airline to ITS OWN tag, not the cross-product', () => {
  // "OCEAN ##VA" + "SHAMROCK ###EX" is two registered shapes, not four. Testing
  // every prefix against every suffix would let "Ocean 12EX" through.
  const cfg = normalizeConfig({ callsigns: ['OCEAN ##VA', 'SHAMROCK ###EX'], callsignMatch: 'exact' });
  expect(cfg, [
    ['Ocean 12VA', true],
    ['Shamrock 004EX', true],
    ['Shamrock 004EX Heavy', true],
    ['Ocean 12EX', false],
    ['Shamrock 4VA', false],
    ['Ocean 12', false],
  ]);
});

test('a tagless callsign alongside a tagged one keeps working', () => {
  // "BAW ###" declares no tag; "SPEEDBIRD ##VA" declares one. Flattening both
  // into a single suffix list demands "VA" from BAW too and drops every BAW
  // flight — so the pairs are what the tag rule is applied against.
  const strict = normalizeConfig({ callsigns: ['BAW ###', 'SPEEDBIRD ##VA'] });
  expect(strict, [
    ['BAW 123', true],
    ['Speedbird 12VA', true],
    ['Speedbird 12', false],   // this one DID declare a tag
    ['Ryanair 4VA', false],
  ]);
  const exact = normalizeConfig({ callsigns: ['BAW ###', 'SPEEDBIRD ##VA'], callsignMatch: 'exact' });
  expect(exact, [
    ['BAW 123', true],
    ['Speedbird 12VA', true],
    ['BAW 123VA', false],      // BAW declared no tag, so nothing may follow
  ]);
});

test('one tag shared across several airlines still works', () => {
  const cfg = normalizeConfig({ callsigns: ['AIR CANADA ##VA', 'JAZZ ##VA'] });
  expect(cfg, [
    ['Air Canada 001VA', true],
    ['Jazz 44VA', true],
    ['Air Canada 001', false],
    ['Air France 1VA', false],
  ]);
});

test('independent prefix/suffix lists keep their cross-product', () => {
  // An embed config supplies these as two separate lists — there are no pairs to
  // preserve and running one tag across several airlines is the documented setup,
  // so every combination is meant to match.
  const cfg = normalizeConfig({
    callsignPrefixes: 'Air Canada, Jazz', callsignSuffixes: 'VA, EX', callsignMatch: 'exact',
  });
  assert.deepStrictEqual(cfg.patterns, []);
  expect(cfg, [
    ['Air Canada 001VA', true],
    ['Air Canada 001EX', true],
    ['Jazz 44EX', true],
    ['Air France 1VA', false],
  ]);
});

test('an unknown or missing mode is strict, never the loosest one', () => {
  assert.strictEqual(matchMode(undefined), 'strict');
  assert.strictEqual(matchMode(''), 'strict');
  assert.strictEqual(matchMode('loose'), 'strict');
  assert.strictEqual(matchMode('EXACT'), 'exact');
  assert.strictEqual(va('OCEAN ##VA').match, 'strict');
});

/* =========================
 * The three modes
 * ========================= */

test('exact takes the registered shape and stops there', () => {
  expect(va('Air Canada ##VA', 'exact'), [
    ['Air Canada 001VA', true],
    ['AirCanada 1VA', true],          // spacing is not part of the shape
    ['Air Canada 001VA Heavy', true], // weight-class words are peeled off first
    ['Air Canada 001VA CX', false],   // a second trailing tag
    ['Air Canada 001 VA EX', false],  // the tag has to be glued to the number
    ['Air Canada 001', false],        // no tag
    ['Air Canada VA', false],         // no number
    ['Air Canada 00X1VA', false],     // the number has to be a number
    ['Air Force 001VA', false],       // whole airline name, so no "AIR" collision
    ['Air France 045VA', false],
  ]);
});

test('strict allows a second trailing tag but still needs the airline', () => {
  expect(va('Air Canada ##VA', 'strict'), [
    ['Air Canada 001VA', true],
    ['Air Canada 001VA CX', true],
    ['Air Canada 001 VA EX', true],
    ['Air Canada 001', false],
    ['Air France 045VA', false],
  ]);
});

// The codeshare case. Norwegian registers "Red Nose ##NV" and its pilots keep
// the "NV" on a partner's metal. Every other mode tests the PREFIX first and
// returns early, so this matcher — the gate the whole feed runs through —
// dropped the leg before the tag was ever read, and nothing downstream could
// recover it.
test('tag mode lets a distinctive tag claim a flight on any airline', () => {
  expect(va('Red Nose ##NV', 'tag'), [
    ['Red Nose 12NV', true],        // own metal
    ['Shamrock 12NV', true],        // codeshare, still wearing the tag
    ['Shamrock 12NV Heavy', true],  // …and a weight class does not hide it
    ['Shamrock 12NV Cargo', true],  // …nor a trailing word
    ['Shamrock 12', false],         // no tag: nothing says it is theirs
    ['Shamrock 12EX', false],       // somebody else's tag
    ['Red Nose 12', false],         // our airline still owes us the tag
  ]);
});

// The tag written as its OWN token — "000 NV" rather than "000NV". Pilots type
// it both ways and tokenHasSuffixTag accepts a standalone tag, but the tail
// window is only two tokens wide, so anything appended after it has to be
// peeled off first or the tag falls out of range.
test('the tag counts when it is a separate token, "000 NV"', () => {
  expect(va('Red Nose ##NV', 'tag'), [
    ['Red Nose 000 NV', true],              // own metal, spaced tag
    ['Shamrock 000 NV', true],              // codeshare, spaced tag
    ['Shamrock 000 NV Heavy', true],        // …behind a weight class
    ['Shamrock 000 NV Cargo Heavy', true],  // …behind a word AND a weight class
    ['Shamrock 000 EX', false],             // somebody else's tag, spaced
    ['Shamrock 000', false],                // no tag at all
  ]);
  // strict is the same rule on the VA's own airline, so it has to agree.
  expect(va('Red Nose ##NV', 'strict'), [
    ['Red Nose 000 NV', true],
    ['Red Nose 000 NV Heavy', true],
    ['Red Nose 000', false],
  ]);
});

test('strict and broad both reject that codeshare — tag mode is the only answer', () => {
  expect(va('Red Nose ##NV', 'strict'), [['Shamrock 12NV', false]]);
  expect(va('Red Nose ##NV', 'broad'), [['Shamrock 12NV', false]]);
  expect(va('Red Nose ##NV', 'exact'), [['Shamrock 12NV', false]]);
});

// A tag may only claim a flight alone when it identifies ONE VA. "VA" does not.
test('tag mode will not let the generic "VA" tag claim another airline', () => {
  expect(va('Ocean ##VA', 'tag'), [
    ['Ocean 12VA', true],       // their own airline is unaffected
    ['Shamrock 12VA', false],   // …but "VA" names no one
  ]);
});

test('broad waives the tag entirely, and only the tag', () => {
  expect(va('Air Canada ##VA', 'broad'), [
    ['Air Canada 001', true],
    ['Air Canada 001VA', true],
    ['Air Canada 001XY', true],
    ['Air France 045VA', false],  // still not somebody else's airline
  ]);
});

test('a VA with no tag at all matches on the airline in every mode', () => {
  expect(va('BAW ###', 'exact'), [['BAW 123', true], ['BAW 123VA', false]]);
  expect(va('BAW ###', 'strict'), [['BAW 123', true], ['BAW 123VA', true]]);
  expect(va('BAW ###', 'broad'), [['BAW 123', true], ['BAW 123VA', true]]);
});

test('a bare tag never matches on its own', () => {
  // "VA" ends a huge number of unrelated callsigns; the airline is what makes a
  // flight the VA's, in every mode.
  for (const mode of ['exact', 'strict', 'broad']) {
    expect(va('Air Canada ##VA', mode), [['Moskva 12VA', false], ['Nova 001VA', false]]);
  }
});

/* =========================
 * Regular (untagged) callsigns
 * ========================= */

test('regular callsigns are always included and never need a tag', () => {
  const cfg = va('OCEAN ##VA', 'strict', { regularCallsigns: 'OCEAN STAFF, Shamrock' });
  expect(cfg, [
    ['Ocean Staff', true],
    ['Ocean Staff 7', true],
    ['Shamrock 44', true],
    ['Ocean 12', false],   // the tagged prefix still wants its tag
    ['Ocean 12VA', true],
  ]);
});

test('exact holds regular callsigns to the whole callsign too', () => {
  const cfg = va('OCEAN ##VA', 'exact', { regularCallsigns: 'OCEAN STAFF' });
  expect(cfg, [
    ['Ocean Staff', true],
    ['Ocean Staff 7', true],
    ['Ocean Staff Alpha', false], // not the name, and not the name plus a number
  ]);
});

/* =========================
 * Roster watch list — the pilots forwarded on membership alone
 * ========================= */

test('a watched pilot is recognised however their name is punctuated', () => {
  // The published list is pre-expanded by the other backend, so what this side
  // owns is only the trim/lowercase/@ normalisation of the LIVE username.
  setRosterWatch(['john doe', 'john_doe', 'john-doe', 'john.doe', 'johndoe']);
  for (const live of ['John_Doe', ' john doe ', '@JohnDoe', 'JOHN.DOE']) {
    assert.strictEqual(isWatchedPilot(live), true, `${JSON.stringify(live)} should be watched`);
  }
  assert.strictEqual(isWatchedPilot('Jane Doe'), false);
  assert.strictEqual(isWatchedPilot(''), false);
  assert.strictEqual(isWatchedPilot(null), false);
});

test('an empty watch list watches nobody', () => {
  // The endpoint returning nothing must not turn into "forward everything".
  setRosterWatch([]);
  assert.strictEqual(isWatchedPilot('John Doe'), false);
  setRosterWatch(null);
  assert.strictEqual(isWatchedPilot('John Doe'), false);
});

/* =========================
 * Runner
 * ========================= */
(() => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);
  process.exit(failed === 0 ? 0 : 1);
})();
