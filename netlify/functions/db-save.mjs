// POST /api/db-save — overwrites the shared app data with the JSON body.
// Last-write-wins (no locking): fine for this prototype's scale and usage.
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'kaiteku-db';
const KEY = 'db';
const REQUIRED_ARRAYS = ['staff', 'units', 'jobTypes', 'admins', 'records'];

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  var isValid = body && typeof body === 'object' &&
    REQUIRED_ARRAYS.every(function (k) { return Array.isArray(body[k]); });
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'bad_request' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  try {
    const store = getStore(STORE_NAME);
    await store.setJSON(KEY, body);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
};

export const config = { path: '/api/db-save' };

