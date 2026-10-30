// Every non-2xx in the API uses one shape:
//   { "error": { "code": "...", "message": "..." } }
// Handlers throw these; the error handler in app.js renders them.

export function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

export const badRequest   = (code, msg) => httpError(400, code, msg);
export const unauthorized = (code = 'unauthorized', msg = 'Missing or invalid credentials.') =>
  httpError(401, code, msg);
export const forbidden    = (code = 'forbidden', msg = 'This resource does not belong to you.') =>
  httpError(403, code, msg);
export const notFound     = (code, msg) => httpError(404, code, msg);
export const conflict     = (code, msg) => httpError(409, code, msg);
export const unprocessable = (code, msg) => httpError(422, code, msg);
