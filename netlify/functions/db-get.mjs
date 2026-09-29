// GET /api/db — returns the shared app data as JSON.
// On first-ever call (empty store) it seeds the store from seed-data.mjs so
// every device that opens the app afterwards sees the same starting data.
// The response carries an ETag (see db-save.mjs) identifying this exact
// version of the data, so the client can save back safely later with a
// conditional write instead of blindly overwriting whatever is newest.
// The read uses strong consistency: Netlify Blobs' default (eventual)
// consistency can serve a cached ETag for up to ~60 seconds after an
// update, which would make every conditional save fail with 409 even
// when nothing actually conflicts.
import { getStore } from '@netlify/blobs';
import seedData from './lib/seed-data.mjs';

const STORE_NAME = 'kaiteku-db';
const KEY = 'db';

export default async () => {
  try {
    const store = getStore(STORE_NAME);
    let entry = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
    let data = entry && entry.data;
    let etag = entry && entry.etag;
    if (!data) {
      data = seedData;
      const seeded = await store.setJSON(KEY, data);
      etag = seeded && seeded.etag;
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'etag': etag || '',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
};

export const config = { path: '/api/db' };

