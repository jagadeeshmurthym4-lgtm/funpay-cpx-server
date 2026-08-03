// CPX Server — Minimal backend with FCM push notification support
// Deploy: Render free tier (configured in render.yaml)

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');

// ─── Firebase Admin Initialization ───────────────────────────────
// Loads the service account from:
//   1. GOOGLE_APPLICATION_CREDENTIALS env var (path to JSON file)
//   2. SERVICE_ACCOUNT_JSON env var (inline JSON string — for Render secret files)
//   3. The default service-account.json secret file path used by Render
function initFirebaseAdmin() {
  // Option 1: Render secret file (mounted as file)
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (serviceAccountPath) {
    try {
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS');
      return;
    } catch (e) {
      console.warn('GOOGLE_APPLICATION_CREDENTIALS failed:', e.message);
    }
  }

  // Option 2: Inline JSON from env var
  const inlineJson = process.env.SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    try {
      const serviceAccount = JSON.parse(inlineJson);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('Firebase Admin initialized via SERVICE_ACCOUNT_JSON');
      return;
    } catch (e) {
      console.warn('SERVICE_ACCOUNT_JSON failed:', e.message);
    }
  }

  // Option 3: Application default credentials (local dev with gcloud SDK)
  try {
    admin.initializeApp();
    console.log('Firebase Admin initialized via application default credentials');
  } catch (e) {
    console.warn('Firebase Admin could not be initialized:', e.message);
    console.warn('FCM endpoints will return 503 until a service account is configured.');
  }
}

initFirebaseAdmin();

// ─── Simple API Key Auth ─────────────────────────────────────────
// Set FCM_API_KEY in the environment (Render dashboard → Environment Variables)
// The Flutter app sends this key in the x-api-key header.
function requireApiKey(req, res, next) {
  const expectedKey = process.env.FCM_API_KEY;
  if (!expectedKey) {
    // No key configured — allow requests in dev mode only
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    return res.status(500).json({ error: 'FCM_API_KEY not configured on server' });
  }

  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ─── Express app ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    firebaseInitialized: !!admin.apps.length,
    timestamp: new Date().toISOString(),
  });
});

// ─── FCM Endpoints ───────────────────────────────────────────────

/**
 * POST /fcm/broadcast
 * Sends an FCM push notification to the all_users topic.
 *
 * Body: { title, message, type }
 * Headers: x-api-key: <FCM_API_KEY>
 */
app.post('/fcm/broadcast', requireApiKey, async (req, res) => {
  if (!admin.apps.length) {
    return res.status(503).json({ error: 'Firebase not initialized' });
  }

  const { title, message, type } = req.body;

  if (!title || !message) {
    return res.status(400).json({ error: 'Both title and message are required' });
  }

  try {
    const payload = {
      notification: {
        title: title,
        body: message,
      },
      data: {
        type: type || 'announcement',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      topic: 'all_users',
    };

    const response = await admin.messaging().send(payload);
    console.log(`FCM broadcast sent to all_users topic: "${title}" — messageId: ${response}`);
    res.json({ success: true, messageId: response });
  } catch (error) {
    console.error('Error sending FCM broadcast:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /fcm/targeted
 * Sends an FCM push notification to a specific user's user_{userId} topic.
 *
 * Body: { userId, title, message, type }
 * Headers: x-api-key: <FCM_API_KEY>
 *
 * Note: The Flutter app subscribes each user to user_{userId} on sign-in.
 */
app.post('/fcm/targeted', requireApiKey, async (req, res) => {
  if (!admin.apps.length) {
    return res.status(503).json({ error: 'Firebase not initialized' });
  }

  const { userId, title, message, type } = req.body;

  if (!userId || !title || !message) {
    return res.status(400).json({ error: 'userId, title, and message are required' });
  }

  try {
    const payload = {
      notification: {
        title: title,
        body: message,
      },
      data: {
        type: type || 'reward',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      topic: `user_${userId}`,
    };

    const response = await admin.messaging().send(payload);
    console.log(`FCM targeted push sent to user_${userId}: "${title}" — messageId: ${response}`);
    res.json({ success: true, messageId: response });
  } catch (error) {
    console.error(`Error sending FCM targeted push to user_${userId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ─── CPX Research Postback ────────────────────────────────
const { registerCpxPostback } = require("./route");
registerCpxPostback(app, { db: admin.firestore(), admin });

// ─── Start server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CPX server running on port ${PORT}`);
  console.log(`Firebase Admin initialized: ${!!admin.apps.length}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
