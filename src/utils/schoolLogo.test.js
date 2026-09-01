const test = require('node:test');
const assert = require('node:assert');

const { signLogoUrls } = require('./schoolLogo');

/**
 * The avatar's data, and every way it can legitimately be absent.
 *
 * The one thing this must never do is fail. A missing logo is a placeholder on
 * screen, not an error, and an inbox that would not load because a signature
 * could not be produced would be a picture taking down a page of messages.
 *
 * These run with no Supabase credentials in the environment, which is itself
 * one of the cases under test: `supabase` is null and every storage path has to
 * come back as a null URL rather than a thrown call on nothing.
 */

test('a school with no logo resolves to null, not an error', async () => {
  const urls = await signLogoUrls([{ id: 2, logo: '' }, { id: 8, logo: null }]);
  assert.strictEqual(urls.get(2), null);
  assert.strictEqual(urls.get(8), null);
});

test('a logo already stored as an absolute URL is passed through unsigned', async () => {
  // Seeded rows and older uploads hold one. There is nothing to sign, and
  // signing it would produce a storage path that does not exist.
  const url = 'https://img.example.com/school.png';
  const urls = await signLogoUrls([{ id: 2, logo: url }]);
  assert.strictEqual(urls.get(2), url);
});

test('a storage path with no storage configured resolves to null', async () => {
  const urls = await signLogoUrls([{ id: 2, logo: 'schools/2/logo.png' }]);
  assert.strictEqual(urls.get(2), null);
});

test('every school asked about gets an entry, so a caller never reads undefined', async () => {
  const urls = await signLogoUrls([
    { id: 2, logo: 'schools/2/logo.png' },
    { id: 8, logo: '' },
    { id: 9, logo: 'https://img.example.com/9.png' },
  ]);
  assert.deepStrictEqual([...urls.keys()].sort(), [2, 8, 9]);
});

test('a school asked about twice is signed once', async () => {
  const urls = await signLogoUrls([{ id: 2, logo: 'schools/2/a.png' }, { id: 2, logo: 'schools/2/b.png' }]);
  assert.strictEqual(urls.size, 1);
});

test('rubbish in the list is skipped rather than throwing', async () => {
  const urls = await signLogoUrls([null, undefined, { id: 'nope', logo: 'x' }, { id: 2, logo: '' }]);
  assert.deepStrictEqual([...urls.keys()], [2]);
});

test('an empty list is an empty map', async () => {
  assert.strictEqual((await signLogoUrls([])).size, 0);
  assert.strictEqual((await signLogoUrls(undefined)).size, 0);
});
