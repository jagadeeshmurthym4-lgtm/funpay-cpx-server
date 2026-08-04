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
 *
 * Accepted parameter aliases:
 *   transaction_id / trans_id / transactionId / id
 *   user_id / ext_user_id / userId / uid
 *   amount / payout / reward / verdienst_user_local_money
 *   status
 *   hash / secure_hash
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
    hash: get(['hash', 'secure_hash']),
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
  const { transactionId, userId, rawAmount, status, hash } = parsePostbackParams(body, query);

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

  // ── Status gate: only credit completed/approved surveys ──
  // CPX sends {status} in the postback. If the status explicitly indicates a
  // survey that should NOT be credited (pending/rejected/cancelled/etc.), we
  // acknowledge the postback (200 so CPX stops retrying) but skip the credit.
  // A later "completed" postback for the same trans_id is still credited
  // because no guard document is written for skipped postbacks.
  const NON_CREDITABLE_STATUSES = [
    'pending', 'rejected', 'cancelled', 'canceled', 'revoked', 'refunded',
    'fraud', 'fraudulent', 'declined', 'denied', 'failed', 'incomplete',
    'abandoned', 'expired', 'chargeback', 'not_completed', 'not-completed',
    '0', 'false', '2', '3', '4',
  ];
  if (status) {
    const s = String(status).trim().toLowerCase();
    if (NON_CREDITABLE_STATUSES.includes(s)) {
      logger.warn(
        `CPX: postback for tx ${transactionId} has non-credited status "${status}" — skipping credit.`
      );
      return { statusCode: 200, body: 'OK' };
    }
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
  // CPX may or may not send a hash depending on whether "secure hash" is
  // enabled in the CPX publisher dashboard. We handle three cases:
  //
  //   1. CPX_ALLOW_UNSIGNED=true → skip hash verification entirely. Never
  //      403/503 on hash grounds — the postback is trusted as-is (used while
  //      the CPX dashboard has secure hash disabled).
  //   2. No hash sent → accept without verification (the dashboard does not
  //      have secure hash enabled).
  //   3. Hash sent + CPX_SECRET exists → verify it; reject if invalid.
  //
  // When CPX eventually enables secure hash in their dashboard, they will
  // start sending a hash automatically and the verification path kicks in.
  let hashVerified = false;

  if (config.allowUnsigned) {
    // Requirement: CPX_ALLOW_UNSIGNED=true → skip hash verification entirely.
    // Do NOT return 403/503 even if a hash is present but invalid/missing.
    logger.log(
      `CPX: accepting postback for tx ${transactionId} WITHOUT hash verification ` +
        `(CPX_ALLOW_UNSIGNED=true). user=${userId}, amount=${amount}, ` +
        (hash ? 'hash param present but ignored' : 'no hash param sent')
    );
  } else if (hash) {
    // A hash was provided — verification is required.
    if (!config.secret) {
      logger.error(
        'CPX: hash provided but CPX_SECRET is not configured. ' +
          'Set the CPX_SECRET environment variable to match the secure hash in the CPX dashboard.'
      );
      return { statusCode: 503, body: 'Secret not configured for hash verification' };
    }

    const hashFormat = verifyCpxHash(
      { transactionId, userId, amount, hash },
      config.secret
    );

    if (hashFormat) {
      hashVerified = true;
      logger.log(
        `CPX: hash verified for tx ${transactionId} (format: ${hashFormat})`
      );
      // Debug: log the candidate string that matched
      const t = String(transactionId || '');
      const u = String(userId || '');
      const a = String(parseFloat(String(amount == null ? '' : amount)));
      const candidates = {
        'tx-secret': `${t}-${config.secret}`,
        'user-secret': `${u}-${config.secret}`,
        'amount-secret': `${a}-${config.secret}`,
        'tx+secret': `${t}${config.secret}`,
        'user+secret': `${u}${config.secret}`,
        'amount+secret': `${a}${config.secret}`,
        'tx+user+amount+secret': `${t}${u}${a}${config.secret}`,
        'tx-user-amount-secret': `${t}-${u}-${a}-${config.secret}`,
        'tx+user+secret': `${t}${u}${config.secret}`,
        'tx+amount+secret': `${t}${a}${config.secret}`,
        'user+amount+secret': `${u}${a}${config.secret}`,
      };
      const matchedString = candidates[hashFormat];
      logger.log(
        `CPX: hash debug — received=${hash}, calculated=${md5(matchedString)}, input="${matchedString}"`
      );
    } else {
      // Debug: log the exact string used to calculate the expected hash
      const t = String(transactionId || '');
      const u = String(userId || '');
      const a = String(parseFloat(String(amount == null ? '' : amount)));
      const bestGuess = `${t}-${config.secret}`;
      logger.warn(
        `CPX: postback rejected (invalid hash) for tx ${transactionId}, ` +
          `user ${userId}, amount ${amount}. ` +
          `Received hash: ${hash}, expected (best guess): ${md5(bestGuess)}, ` +
          `input string used for guess: "${bestGuess}"`
      );
      return { statusCode: 403, body: 'Invalid hash' };
    }
  } else {
    // No hash sent — accept without verification (CPX secure hash is not
    // enabled in the dashboard). Log so operators can monitor.
    logger.log(
      `CPX: accepting postback for tx ${transactionId} without hash verification ` +
        `(no hash parameter sent by CPX). user=${userId}, amount=${amount}`
    );
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
      hashVerified: hashVerified,
      fieldValue,
      messaging,
    });

    if (!credited) {
      logger.log(`CPX: tx ${transactionId} already credited (concurrent duplicate), skipping.`);
    } else {
      logger.log(
        `CPX: credited ${amount.toFixed(2)} pts to user ${userId} ` +
          `(tx ${transactionId}, hashVerified=${hashVerified})`
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
