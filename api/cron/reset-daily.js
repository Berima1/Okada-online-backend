// /api/cron/reset-daily.js
// Replaces: Firebase pubsub.schedule('0 0 * * *').timeZone('Africa/Accra')
// Vercel calls this automatically at midnight UTC (= midnight Ghana time, GMT+0)
// Vercel Hobby plan: cron jobs are FREE

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  // Vercel cron sends GET — reject anything else for security
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const [drivers, owners] = await Promise.all([
      db.collection('drivers').get(),
      db.collection('owners').get(),
    ]);
    const batch = db.batch();
    drivers.forEach(doc => batch.update(doc.ref, { 'earnings.today': 0 }));
    owners.forEach(doc  => batch.update(doc.ref, { 'earnings.today': 0 }));
    await batch.commit();

    console.log(`[Cron] Reset daily earnings — ${drivers.size} drivers, ${owners.size} owners`);
    res.status(200).json({ success: true, driversReset: drivers.size, ownersReset: owners.size });
  } catch (e) {
    console.error('[Cron] Failed:', e.message);
    res.status(500).json({ error: e.message });
  }
};
