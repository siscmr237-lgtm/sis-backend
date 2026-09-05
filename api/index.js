/**
 * THE VERCEL ENTRYPOINT — and nothing else.
 *
 * Vercel's Node runtime wants a module that EXPORTS a request handler. An
 * Express app is one: `app(req, res)` is exactly the signature the runtime
 * invokes. So this file re-exports the app and stops.
 *
 * WHY IT LIVES IN api/ RATHER THAN BEING src/index.js.
 *
 * The rewrite in vercel.json used to point at /src/index.js, and a fresh build
 * began honouring that destination as a literal PATH REWRITE: every request,
 * whatever its URL, reached Express with req.url = '/src/index.js'. Nothing
 * matched — not /health, not /auth/login, not /cron — so every request fell
 * through to authMiddleware and came back 401 SESSION_INVALID, which read as
 * "login is broken" when in fact the whole API was unreachable.
 *
 * api/ is Vercel's own convention for functions, so the file is detected as one
 * on its own terms and the original request path survives to Express. That is
 * the whole fix: the routing table in src/app.js is unchanged and correct, it
 * simply has to be given the real URL.
 *
 * src/index.js is deliberately left alone. It still calls app.listen() and is
 * still what `npm run dev` and `npm start` use locally — this file is only ever
 * loaded by the serverless runtime, which never calls listen().
 */
const app = require('../src/app');

module.exports = app;
