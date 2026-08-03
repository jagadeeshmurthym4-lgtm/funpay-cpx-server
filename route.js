/**
 * One-line drop-in route for an EXISTING Express server (e.g. the
 * cashspark-cpx-server on Render).
 *
 * Usage — in your server's main file (after `app` and Firebase exist):
 *
 *   const { registerCpxPostback } = require('./route');
 *   registerCpxPostback(app, { db: <your firestore instance>, admin: <your admin import> });
 *
 * `db`     — your `admin.firestore()` instance
 * `admin`  — the `firebase-admin` module (for FieldValue + messaging)
 *
 * Env vars it reads:
 *   CPX_SECRET           — postback verification secret (required)
 *   CPX_ALLOW_UNSIGNED   — "true" only for dev (accepts unsigned postbacks)
 */

const express = require('express');
const { handleCpxPostback } = require('./cpx');

function registerCpxPostback(app, { db, admin }) {
  const router = express.Router();

  // NOTE: intentionally no x-api-key check — CPX calls this directly and the
  // postback `hash` (verified with CPX_SECRET) IS the authentication.
  router.all(['/cpx/postback', '/cpx-postback'], async (req, res) => {
    try {
      const result = await handleCpxPostback({
        req,
        db,
        getConfig: () => ({
          cpx: {
            secret: process.env.CPX_SECRET || '',
            allow_unsigned: process.env.CPX_ALLOW_UNSIGNED === 'true' ? 'true' : 'false',
          },
        }),
        fieldValue: admin.firestore.FieldValue,
        messaging: admin.messaging(),
      });
      res.status(result.statusCode).send(result.body);
    } catch (error) {
      // Express 4 doesn't catch rejected promises from async handlers —
      // always answer 500 so CPX retries (idempotency keeps retries safe).
      console.error('CPX: unhandled postback error:', error);
      res.status(500).send('Internal error');
    }
  });

  app.use(router);
}

module.exports = { registerCpxPostback };
