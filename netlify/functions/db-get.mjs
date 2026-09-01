// GET /api/db — returns the shared app data as JSON.
// On first-ever call (empty store) it seeds the store from seed-data.mjs so
// every device that opens the app afterwards sees the same starting data.
import { getStore } from '@netlify/blobs';
import seedData from './lib/seed-data.mjs';

const STORE_NAME = 'kaiteku-db';
const KEY = 'db';

export default async () => {
  try {
    const store = getStore(STORE_NAME);
    let data = await store.get(KEY, { type: 'json' });
    if (!data) {
      data = seedData;
      await store.setJSON(KEY, data);
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
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

