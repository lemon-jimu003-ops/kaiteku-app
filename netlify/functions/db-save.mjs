// POST /api/db-save — overwrites the shared app data with the JSON body.
// Uses an optimistic-concurrency conditional write: the client must send
// the ETag of the version it last read (as an If-Match header). If someone
// else has saved in the meantime, the ETag no longer matches and this
// write is rejected with 409 instead of silently overwriting their change
// (the previous "last write wins" behavior could make an on-duty record
// disappear when two people checked in/out within moments of each other).
// The client is expected to re-fetch and retry its change on conflict.
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
  var ifMatch = req.headers.get('if-match') || undefined;
  try {
    const store = getStore(STORE_NAME);
    const result = await store.setJSON(KEY, body, ifMatch ? { onlyIfMatch: ifMatch } : undefined);
    if (!result || result.modified === false) {
      return new Response(JSON.stringify({ error: 'conflict' }), {
        status: 409,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return new Response(JSON.stringify({ ok: true, etag: result.etag || '' }), {
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

