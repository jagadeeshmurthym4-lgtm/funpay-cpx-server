/**
 * CPX Research offer wall — pure postback handling logic.
 *
 * Shared by the Firebase Cloud Function (functions/cpx.js) and the standalone
 * Render server (cpx-server/server.js). All external dependencies (Firestore,
 * config, FCM, logging) are injected, so the module only requires Node's
 * built-in `crypto`.
 */

const crypto = require('crypto');

function md5(input) {
  return crypto.createHash('md5').update(String(input), 'utf8').digest('hex');
}

/**
 * Reads the postback secret + dev flag from a config object shaped like
 * `functions.config()` (i.e. `{ cpx: { secret, allow_unsigned } }`).
 */
function normalizeCpxConfig(config) {
  return {
    secret: config?.cpx?.secret || '',
    allowUnsigned: config?.cpx?.allow_unsigned === 'true',
  };
}

/**
 * Pulls the postback parameters out of a request body (POST) and query
 * string (GET), accepting CPX's parameter names plus common aliases.
 */
function parsePostbackParams(body, query) {
  const get = (names) => {
    for (const name of names) {
      const value = body[name] !== undefined ? body[name] : query[name];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return null;
  };

  return {
    transactionId: get(['transaction_id', 'trans_id', 'transactionId', 'id']),
    userId: get(['user_id', 'ext_user_id', 'userId', 'uid']),
    rawAmount: get(['amount', 'payout', 'reward', 'verdienst_user_local_money']),
    status: get(['status']),
    hash: get(['hash']),
  };
}

/**
 * Verifies the postback `hash` (MD5) against the configured secret.
 *
 * CPX documents its signature style as `md5("{value}-{secret}")` for entry
 * links, but postback signature combinations vary per publisher account, so we
 * accept any of the common concatenations of (transaction_id, user_id, amount)
 * with the secret. The amount is normalised (trailing zeros stripped) before
 * hashing to tolerate `0.86` vs `0.8600`. Returns the matched format string on
 * success (for debugging) or null when the hash is missing/invalid.
 */
function verifyCpxHash({ transactionId, userId, amount, hash }, secret) {
  if (!hash || !secret) return null;

  const t = String(transactionId || '');
  const u = String(userId || '');
  // Normalise the amount the same way we parse it: 0.8600 -> "0.86".
  const a = String(parseFloat(String(amount == null ? '' : amount)));

  const candidates = {
    'tx-secret': `${t}-${secret}`,
    'user-secret': `${u}-${secret}`,
    'amount-secret': `${a}-${secret}`,
    'tx+secret': `${t}${secret}`,
    'user+secret': `${u}${secret}`,
    'amount+secret': `${a}${secret}`,
    'tx+user+amount+secret': `${t}${u}${a}${secret}`,
    'tx-user-amount-secret': `${t}-${u}-${a}-${secret}`,
    'tx+user+secret': `${t}${u}${secret}`,
    'tx+amount+secret': `${t}${a}${secret}`,
    'user+amount+secret': `${u}${a}${secret}`,
  };

  const provided = String(hash).toLowerCase();
  for (const [label, raw] of Object.entries(candidates)) {
    if (md5(raw) === provided) {
      return label;
    }
  }
  return null;
}

/**
 * Credits a wallet atomically (create-or-increment) and stamps the CPX
 * transaction guard document inside the SAME Firestore transaction, so a
 * retried or concurrent duplicate postback can never double-credit the user.
 *
 * `db` must expose Firestore's `collection().doc()` and `runTransaction()`
 * API; `fieldValue` is the FieldValue factory; `messaging` is the FCM client
 * used for the best-effort push.
 *
 * Returns `true` when the reward was credited, `false` when the guard already
 * existed (already credited by an earlier/concurrent postback).
 */
async function creditCpxReward({
  db,
  userId,
  amount,
  transactionId,
  hashVerified,
  fieldValue,
  messaging,
}) {
  const walletRef = db.collection('wallets').doc(userId);
  const cpxTransactionRef = db.collection('cpx_transactions').doc(transactionId);
  const transactionRef = db.collection('transactions').doc();
  const notificationRef = db.collection('notifications').doc();

  const description = `CPX Research survey reward: ${amount.toFixed(2)} pts`;
  const notifTitle = '🎉 Survey Reward Earned!';
  const notifMessage = `You earned ${amount.toFixed(2)} pts from a CPX Research survey. They're in your wallet now!`;

  let credited = false;

  await db.runTransaction(async (transaction) => {
    // ── Idempotency guard INSIDE the transaction (race-safe): if a concurrent
    // postback already committed the guard, Firestore re-runs this callback
    // with fresh data and we skip the credit entirely. ──
    const guardSnap = await transaction.get(cpxTransactionRef);
    if (guardSnap.exists) return;

    const walletSnap = await transaction.get(walletRef);
    if (!walletSnap.exists) {
      transaction.set(walletRef, {
        userId,
        walletBalance: amount,
        totalEarnings: amount,
        totalWithdrawn: 0,
        updatedAt: fieldValue.serverTimestamp(),
      });
    } else {
      transaction.update(walletRef, {
        walletBalance: fieldValue.increment(amount),
        totalEarnings: fieldValue.increment(amount),
        updatedAt: fieldValue.serverTimestamp(),
      });
    }

    // Guard doc — created atomically with the wallet credit.
    transaction.set(cpxTransactionRef, {
      transactionId,
      userId,
      amount,
      status: 'completed',
      hashVerified: hashVerified === true,
      creditedAt: fieldValue.serverTimestamp(),
    });

    credited = true;
  });

  if (!credited) return false;

  // Wallet record + notification (outside the transaction for simplicity).
  await transactionRef.set({
    transactionId: transactionRef.id,
    userId,
    type: 'credit',
    amount,
    source: 'offerwall',
    status: 'completed',
    description,
    createdAt: fieldValue.serverTimestamp(),
  });

  await notificationRef.set({
    notificationId: notificationRef.id,
    userId,
    title: notifTitle,
    message: notifMessage,
    type: 'reward',
    isRead: false,
    createdAt: fieldValue.serverTimestamp(),
  });

  // Best-effort FCM push to the user's topic.
  if (messaging && typeof messaging.send === 'function') {
    try {
      await messaging.send({
        notification: { title: notifTitle, body: notifMessage },
        data: { type: 'reward', click_action: 'FLUTTER_NOTIFICATION_CLICK' },
        topic: `user_${userId}`,
      });
    } catch (e) {
      console.warn(`CPX: FCM push to user_${userId} failed (non-fatal): ${e.message}`);
    }
  }

  return true;
}

/**
 * Handles one CPX postback request. Pure in the sense that it takes injected
 * dependencies and returns `{ statusCode, body }` — the HTTP transport lives
 * in the caller (Cloud Function wrapper or Express route).
 *
 * Injected:
 *   req         — Express-style request ({ method, query, body })
 *   db          — Firestore instance
 *   getConfig   — () => { cpx: { secret, allow_unsigned } }
 *   fieldValue  — admin.firestore.FieldValue
 *   messaging   — admin.messaging()
 *   logger      — { log, warn, error }, defaults to console
 */
async function handleCpxPostback({
  req,
  db,
  getConfig,
  fieldValue,
  messaging,
  logger = console,
}) {
  // CPX postbacks arrive as GET (query string) or POST (JSON / form-encoded).
  if (req.method !== 'GET' && req.method !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = req.body || {};
  const query = req.query || {};
  const { transactionId, userId, rawAmount, hash } = parsePostbackParams(body, query);

  if (!transactionId || !userId || rawAmount === null) {
    logger.warn('CPX: postback missing required params', {
      transactionId: !!transactionId,
      userId: !!userId,
      amount: rawAmount,
    });
    return { statusCode: 400, body: 'Missing required params' };
  }

  const amount = parseFloat(String(rawAmount));
  if (!isFinite(amount) || amount <= 0) {
    logger.warn(`CPX: postback has invalid amount ${rawAmount}`);
    return { statusCode: 400, body: 'Invalid amount' };
  }

  const config = normalizeCpxConfig(getConfig());

  // ── Idempotency fast-path: already processed → acknowledge so CPX stops
  // retrying. (The authoritative guard lives inside the credit transaction.) ──
  const cpxTransactionRef = db.collection('cpx_transactions').doc(transactionId);
  const existing = await cpxTransactionRef.get();
  if (existing.exists) {
    logger.log(`CPX: postback for tx ${transactionId} already processed, skipping.`);
    return { statusCode: 200, body: 'OK' };
  }

  // ── Secure server-side verification ──
  if (!config.secret) {
    // Distinct message so operators know the secret isn't set (vs. a bad hash).
    logger.error('CPX: postback secret not configured. Set CPX_SECRET env var.');
    return { statusCode: 503, body: 'Secret not configured' };
  }

  const hashFormat = verifyCpxHash(
    { transactionId, userId, amount, hash },
    config.secret
  );

  if (!hashFormat && !config.allowUnsigned) {
    logger.warn(
      `CPX: postback rejected (invalid or missing hash) for tx ${transactionId}, ` +
        `user ${userId}, amount ${amount}`
    );
    return { statusCode: 403, body: 'Invalid hash' };
  }

  if (!hashFormat && config.allowUnsigned) {
    logger.warn(
      `CPX: accepting unsigned postback for tx ${transactionId} because allowUnsigned=true. ` +
        'Set CPX_SECRET and a postback hash in the CPX dashboard for production.'
    );
  } else if (hashFormat) {
    logger.log(`CPX: hash verified for tx ${transactionId} (format: ${hashFormat})`);
  }

  // ── Reward callback: credit the user's wallet ──
  try {
    // Only credit real users (avoids creating phantom wallets from forged ids).
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) {
      logger.warn(`CPX: user ${userId} not found — ignoring postback ${transactionId}`);
      // Return 200 so CPX does not retry forever for a non-existent user.
      return { statusCode: 200, body: 'OK' };
    }

    const credited = await creditCpxReward({
      db,
      userId,
      amount,
      transactionId,
      hashVerified: !!hashFormat,
      fieldValue,
      messaging,
    });

    if (!credited) {
      logger.log(`CPX: tx ${transactionId} already credited (concurrent duplicate), skipping.`);
    } else {
      logger.log(
        `CPX: credited ${amount.toFixed(2)} pts to user ${userId} ` +
          `(tx ${transactionId}, hashVerified=${!!hashFormat})`
      );
    }
    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    logger.error(`CPX: failed to credit user ${userId} for tx ${transactionId}:`, error);
    // 500 → CPX will retry; the idempotency guard keeps retries safe.
    return { statusCode: 500, body: 'Internal error' };
  }
}

module.exports = {
  md5,
  normalizeCpxConfig,
  parsePostbackParams,
  verifyCpxHash,
  creditCpxReward,
  handleCpxPostback,
};
