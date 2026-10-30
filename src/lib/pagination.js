// Keyset pagination, shared by every list route that can grow without bound.
//
// The cursor is the sort key itself -- a timestamp and the id that breaks ties
// -- rather than an offset. Offsets are wrong for feeds that change while
// someone is scrolling: a row inserted above the current page shifts everything
// down by one, so the reader silently sees an entry twice and misses another.
// A key says "carry on from exactly here", which stays true whatever else moved.

import { badRequest } from '../errors.js';

export const encodeCursor = (at, id) => Buffer.from(`${at}|${id}`).toString('base64url');

/**
 * Cursors are opaque to clients, which means a client cannot construct one, and
 * a malformed one is a bug rather than a range worth guessing at. Reject it.
 */
export function decodeCursor(cursor) {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(new Date(at).getTime())) {
    throw badRequest('validation_failed', '`cursor` is not a cursor this API issued.');
  }
  return { at, id };
}

/**
 * Split an over-fetched result into a page plus the cursor that follows it.
 * Callers ask for `limit + 1` rows; the extra one is never returned, it only
 * answers "is there more?" without a second count query.
 */
export function paginate(rows, limit, keyOf) {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return { kept, next_cursor: hasMore ? encodeCursor(...keyOf(last)) : null };
}
