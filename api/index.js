// ══════════════════════════════════════════════════════════════════
// OKADA ONLINE — VERCEL BACKEND v2.0
// Exact port of Firebase Cloud Functions → Vercel Serverless
// FREE to run • No billing account needed • Same Firestore DB
//
// Env vars needed in Vercel Dashboard → Settings → Environment Variables:
//   FIREBASE_PROJECT_ID      ← your Firebase project ID
//   FIREBASE_CLIENT_EMAIL    ← from serviceAccountKey.json
//   FIREBASE_PRIVATE_KEY     ← from serviceAccountKey.json (include \n)
//   TWILIO_SID               ← Twilio Account SID
//   TWILIO_TOKEN             ← Twilio Auth Token
//   TWILIO_PHONE             ← your Twilio phone number e.g. +1234567890
//   PAYSTACK_SECRET          ← sk_live_... or sk_test_...
// ══════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const twilio = require('twilio');
const axios  = require('axios');

// ── Firebase singleton init ───────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel stores \n as literal \\n in env — fix it:
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ── Twilio lazy init ──────────────────────────────────────────────
let _sms;
const getSms = () => {
  if (!_sms) _sms = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  return _sms;
};
const smsTo = async (phone, msg) => {
  try {
    await getSms().messages.create({
      body: msg,
      from: process.env.TWILIO_PHONE,
      to:   phone,
    });
  } catch (e) { console.error('SMS failed:', e.message); }
};

// ── Config (identical to Firebase version) ───────────────────────
const CFG = {
  splits: { platform:0.15, owner:0.70, driver:0.10, fuel:0.03, maintenance:0.02 },
  fare:   { base:3.0, okada:2.5, car:4.0, tricycle:3.0, bicycle:1.5, min:5.0 },
  currency: 'GHS',
};

// ── Haversine distance (km) ───────────────────────────────────────
const toRad = d => d * Math.PI / 180;
const dist  = (la1,lo1,la2,lo2) => {
  const dLa=toRad(la2-la1), dLo=toRad(lo2-lo1);
  const a=Math.sin(dLa/2)**2+Math.cos(toRad(la1))*Math.cos(toRad(la2))*Math.sin(dLo/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
};

// ── Fare calculator ───────────────────────────────────────────────
const calcFare = (rideType, km) => {
  const rate  = CFG.fare[rideType] || CFG.fare.okada;
  const total = Math.max(CFG.fare.base + km*rate, CFG.fare.min);
  return {
    total:       +total.toFixed(2),
    owner:       +(total*CFG.splits.owner).toFixed(2),
    driver:      +(total*CFG.splits.driver).toFixed(2),
    fuel:        +(total*CFG.splits.fuel).toFixed(2),
    maintenance: +(total*CFG.splits.maintenance).toFixed(2),
    platform:    +(total*CFG.splits.platform).toFixed(2),
  };
};

// ── CORS headers ──────────────────────────────────────────────────
const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
};

// ── Tiny response helpers ─────────────────────────────────────────
const ok  = (res, data)      => res.status(200).json({ success:true,  ...data });
const fail = (res, code, msg) => res.status(code).json({ success:false, error: msg });

// ════════════════════════════════════════════════════════════════════
// MAIN ROUTER  —  Vercel calls this for every request to /api
// ════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse clean path: strip leading /api and trailing slash
  const raw  = req.url.split('?')[0];
  const path = raw.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const { method } = req;
  const body = req.body || {};

  console.log(`[OkadaOnline] ${method} ${path}`);

  try {

    // ══════════════════════════════════════════════════
    // AUTH
    // ══════════════════════════════════════════════════

    // POST /auth/send-otp
    if (method==='POST' && path==='/auth/send-otp') {
      const { phone, role } = body;
      if (!phone?.startsWith('+233'))
        return fail(res, 400, 'Invalid Ghana phone number. Must start with +233');
      const otp = Math.floor(100000+Math.random()*900000).toString();
      await db.collection('otps').doc(phone).set({
        otp, role,
        expiresAt: new Date(Date.now()+5*60*1000),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await smsTo(phone, `Okada Online OTP: ${otp}\nValid 5 mins. DO NOT share. 🇬🇭`);
      return ok(res, {});
    }

    // POST /auth/verify-otp
    if (method==='POST' && path==='/auth/verify-otp') {
      const { phone, otp, role, name, ownerCode } = body;
      const doc = await db.collection('otps').doc(phone).get();
      if (!doc.exists || doc.data().otp !== otp)
        return fail(res, 400, 'Invalid OTP');
      if (doc.data().expiresAt.toDate() < new Date()) {
        await doc.ref.delete();
        return fail(res, 400, 'OTP expired');
      }
      if (role==='driver' && !ownerCode)
        return fail(res, 400, 'Owner code required for drivers');
      if (role==='driver') {
        const ow = await db.collection('owners').where('ownerCode','==',ownerCode).get();
        if (ow.empty) return fail(res, 400, 'Invalid owner code');
      }
      const col = { driver:'drivers', owner:'owners', admin:'admins' }[role] || 'users';
      const q   = await db.collection(col).where('phone','==',phone).get();
      let user;
      if (q.empty) {
        const base = {
          phone, name: name||'', role,
          rating: 5.0, totalRides: 0, isActive: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (role==='driver') Object.assign(base, {
          ownerCode, isOnline: false, isVerified: false,
          earnings: { total:0, today:0, week:0 }, location: null,
        });
        if (role==='owner') Object.assign(base, {
          ownerCode: 'OWN'+Math.random().toString(36).substr(2,6).toUpperCase(),
          vehicles: [], earnings: { total:0, today:0, week:0 },
          pools: { fuel:0, maintenance:0 },
        });
        const ref = await db.collection(col).add(base);
        user = { id:ref.id, ...base };
      } else {
        user = { id:q.docs[0].id, ...q.docs[0].data() };
      }
      const token = await admin.auth().createCustomToken(user.id);
      await doc.ref.delete();
      return ok(res, { token, user });
    }

    // ══════════════════════════════════════════════════
    // RIDES
    // ══════════════════════════════════════════════════

    // POST /rides/request
    if (method==='POST' && path==='/rides/request') {
      const { userId, pickupLocation, destination, rideType } = body;
      const user = await db.collection('users').doc(userId).get();
      if (!user.exists) return fail(res, 404, 'User not found');
      const km   = dist(pickupLocation.latitude, pickupLocation.longitude, destination.latitude, destination.longitude);
      const fare = calcFare(rideType, km);
      const ride = {
        userId, userName: user.data().name, userPhone: user.data().phone,
        pickupLocation, destination, rideType: rideType||'okada',
        status: 'requested', fare,
        distance: +km.toFixed(2),
        estimatedDuration: Math.ceil(km*3),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const ref     = await db.collection('rides').add(ride);
      const drivers = await db.collection('drivers')
        .where('isOnline','==',true)
        .where('isVerified','==',true)
        .get();
      let notified = 0;
      for (const d of drivers.docs) {
        const loc = d.data().location;
        if (!loc) continue;
        if (dist(pickupLocation.latitude,pickupLocation.longitude,loc.latitude,loc.longitude)>5) continue;
        await smsTo(d.data().phone,
          `🏍️ New ride!\n${pickupLocation.address} → ${destination.address}\nFare: ₵${fare.total}  You earn: ₵${fare.driver}`);
        await db.collection('notifications').add({
          driverId: d.id, type: 'new_ride', rideId: ref.id,
          read: false, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        notified++;
      }
      return ok(res, { rideId:ref.id, fare, nearbyDriversNotified:notified });
    }

    // POST /rides/:rideId/accept
    const acceptMatch = path.match(/^\/rides\/([^/]+)\/accept$/);
    if (method==='POST' && acceptMatch) {
      const rideRef = db.collection('rides').doc(acceptMatch[1]);
      const ride    = await rideRef.get();
      if (!ride.exists)                        return fail(res, 404, 'Ride not found');
      if (ride.data().status !== 'requested')  return fail(res, 400, 'Ride no longer available');
      const driver = await db.collection('drivers').doc(body.driverId).get();
      if (!driver.exists)                      return fail(res, 404, 'Driver not found');
      await rideRef.update({
        driverId:    body.driverId,
        driverName:  driver.data().name,
        driverPhone: driver.data().phone,
        status:      'accepted',
        acceptedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      await smsTo(ride.data().userPhone, `Driver ${driver.data().name} is on the way! Track in app. 🏍️`);
      return ok(res, {});
    }

    // POST /rides/:rideId/complete
    const completeMatch = path.match(/^\/rides\/([^/]+)\/complete$/);
    if (method==='POST' && completeMatch) {
      const rideRef = db.collection('rides').doc(completeMatch[1]);
      const ride    = await rideRef.get();
      if (!ride.exists || ride.data().status==='completed')
        return fail(res, 400, 'Invalid ride');
      const driver    = await db.collection('drivers').doc(ride.data().driverId).get();
      const ownerSnap = await db.collection('owners')
        .where('ownerCode','==',driver.data().ownerCode).get();
      const fare = ride.data().fare;
      await rideRef.update({ status:'completed', completedAt:admin.firestore.FieldValue.serverTimestamp() });
      // Driver split
      await db.collection('drivers').doc(ride.data().driverId).update({
        'earnings.total': admin.firestore.FieldValue.increment(fare.driver),
        'earnings.today': admin.firestore.FieldValue.increment(fare.driver),
        'earnings.week':  admin.firestore.FieldValue.increment(fare.driver),
        totalRides:       admin.firestore.FieldValue.increment(1),
      });
      // Owner split + pools
      if (!ownerSnap.empty) {
        await ownerSnap.docs[0].ref.update({
          'earnings.total':    admin.firestore.FieldValue.increment(fare.owner),
          'earnings.today':    admin.firestore.FieldValue.increment(fare.owner),
          'pools.fuel':        admin.firestore.FieldValue.increment(fare.fuel),
          'pools.maintenance': admin.firestore.FieldValue.increment(fare.maintenance),
          totalRides:          admin.firestore.FieldValue.increment(1),
        });
      }
      return ok(res, { splits: fare });
    }

    // GET /rides/history/:userId
    const historyMatch = path.match(/^\/rides\/history\/([^/]+)$/);
    if (method==='GET' && historyMatch) {
      const snap = await db.collection('rides')
        .where('userId','==',historyMatch[1])
        .orderBy('createdAt','desc')
        .limit(20)
        .get();
      return ok(res, { rides: snap.docs.map(d=>({id:d.id,...d.data()})) });
    }

    // ══════════════════════════════════════════════════
    // DRIVERS
    // ══════════════════════════════════════════════════

    // PUT /drivers/:id/location
    const driverLocMatch = path.match(/^\/drivers\/([^/]+)\/location$/);
    if (method==='PUT' && driverLocMatch) {
      const { latitude, longitude, heading } = body;
      await db.collection('drivers').doc(driverLocMatch[1]).update({
        location: { latitude, longitude, heading:heading||0,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp() },
      });
      return ok(res, {});
    }

    // PUT /drivers/:id/status
    const driverStatusMatch = path.match(/^\/drivers\/([^/]+)\/status$/);
    if (method==='PUT' && driverStatusMatch) {
      await db.collection('drivers').doc(driverStatusMatch[1]).update({
        isOnline:    body.isOnline,
        vehicleType: body.vehicleType||'okada',
      });
      return ok(res, {});
    }

    // ══════════════════════════════════════════════════
    // OWNERS
    // ══════════════════════════════════════════════════

    // GET /owners/:id/dashboard
    const ownerDashMatch = path.match(/^\/owners\/([^/]+)\/dashboard$/);
    if (method==='GET' && ownerDashMatch) {
      const owner = await db.collection('owners').doc(ownerDashMatch[1]).get();
      if (!owner.exists) return fail(res, 404, 'Owner not found');
      const drivers = await db.collection('drivers')
        .where('ownerCode','==',owner.data().ownerCode).get();
      return ok(res, { data: {
        ...owner.data().earnings,
        pools:         owner.data().pools,
        ownerCode:     owner.data().ownerCode,
        totalDrivers:  drivers.size,
        activeDrivers: drivers.docs.filter(d=>d.data().isOnline).length,
      }});
    }

    // GET /owners/:id/vehicles
    const ownerVehiclesMatch = path.match(/^\/owners\/([^/]+)\/vehicles$/);
    if (method==='GET' && ownerVehiclesMatch) {
      const owner = await db.collection('owners').doc(ownerVehiclesMatch[1]).get();
      return ok(res, { vehicles: owner.data()?.vehicles||[] });
    }

    // ══════════════════════════════════════════════════
    // PAYMENTS
    // ══════════════════════════════════════════════════

    // POST /payments/initialize
    if (method==='POST' && path==='/payments/initialize') {
      const { rideId, amount, email, phone } = body;
      const r = await axios.post('https://api.paystack.co/transaction/initialize', {
        email:        email||`${phone.replace('+','')}@okadaonline.com`,
        amount:       Math.round(amount*100),
        currency:     'GHS',
        reference:    `ride_${rideId}_${Date.now()}`,
        callback_url: 'https://okada-online.vercel.app/payment/callback',
        metadata:     { rideId, phone },
      }, { headers: { Authorization:`Bearer ${process.env.PAYSTACK_SECRET}` } });
      await db.collection('payments').add({
        rideId, amount, currency:'GHS', provider:'paystack',
        reference: r.data.data.reference,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return ok(res, {
        authorizationUrl: r.data.data.authorization_url,
        reference:        r.data.data.reference,
      });
    }

    // POST /payments/webhook
    if (method==='POST' && path==='/payments/webhook') {
      if (req.body.event==='charge.success') {
        const { reference, metadata } = req.body.data;
        const q = await db.collection('payments').where('reference','==',reference).get();
        if (!q.empty) {
          await q.docs[0].ref.update({
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        if (metadata?.rideId) {
          await db.collection('rides').doc(metadata.rideId).update({
            paymentStatus: 'paid', status: 'completed',
          });
        }
      }
      return ok(res, {});
    }

    // ══════════════════════════════════════════════════
    // USSD  (*711#)
    // ══════════════════════════════════════════════════

    // POST /ussd/callback
    if (method==='POST' && path==='/ussd/callback') {
      const { phoneNumber, text } = body;
      const parts = (text||'').split('*');
      let response = '';

      if (text==='') {
        response = `CON Welcome to Okada Online 🇬🇭\n1. Book Okada (₵2.50/km)\n2. Book Car (₵4.00/km)\n3. My Rides\n4. Driver earnings\n5. Help`;
      } else if (parts[0]==='1' && parts.length===1) {
        response = `CON Enter pickup area:\n1. Akosombo\n2. Atimpoku\n3. Senchi\n4. Kpong\n5. Odumase`;
      } else if (parts[0]==='1' && parts.length===2) {
        response = `CON Enter destination:\n1. Akosombo\n2. Atimpoku\n3. Senchi\n4. Kpong\n5. Odumase`;
      } else if (parts[0]==='1' && parts.length===3) {
        const fare = (Math.random()*10+5).toFixed(2);
        response = `END Okada booked! A driver will call you shortly.\nEstimated fare: ₵${fare}\nTrack via app or wait for SMS. 🏍️`;
        smsTo(phoneNumber, `Ride booked via USSD! Driver will call you.\nEst. fare: ₵${fare} 🏍️`).catch(()=>{});
      } else if (parts[0]==='2' && parts.length===1) {
        response = `CON Enter pickup area:\n1. Akosombo\n2. Atimpoku\n3. Senchi\n4. Kpong\n5. Odumase`;
      } else if (parts[0]==='2' && parts.length===2) {
        response = `CON Enter destination:\n1. Akosombo\n2. Atimpoku\n3. Senchi\n4. Kpong\n5. Odumase`;
      } else if (parts[0]==='2' && parts.length===3) {
        const fare = (Math.random()*15+8).toFixed(2);
        response = `END Car booked! A driver will call you shortly.\nEstimated fare: ₵${fare}\nTrack via app or wait for SMS. 🚗`;
        smsTo(phoneNumber, `Car booked via USSD! Driver will call you.\nEst. fare: ₵${fare} 🚗`).catch(()=>{});
      } else if (parts[0]==='3') {
        response = `END Visit the Okada Online app to view your ride history.\nokada-online.vercel.app\nOr call: +233549315691`;
      } else if (parts[0]==='4') {
        response = `END Driver Earnings Info:\n• You earn 10% per ride\n• Owner earns 70%\n• Fuel pool: 3% (auto)\n• Maintenance: 2% (auto)\n• Platform: 15%\nFair & transparent! 🇬🇭`;
      } else if (parts[0]==='5') {
        response = `END Okada Online Support:\nCall: +233549315691\nWhatsApp: +233500664679\nHours: 6am-10pm daily\n🇬🇭 FOR GHANA WITH LOVE`;
      } else {
        response = `END Invalid option. Dial *711# to try again.`;
      }

      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(response);
    }

    // ══════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════

    // GET /admin/stats
    if (method==='GET' && path==='/admin/stats') {
      const [rides, drivers, users, owners] = await Promise.all([
        db.collection('rides').get(),
        db.collection('drivers').get(),
        db.collection('users').get(),
        db.collection('owners').get(),
      ]);
      const revenue = rides.docs.reduce((s,d)=>s+(d.data().fare?.total||0), 0);
      return ok(res, { data: {
        totalRides:    rides.size,
        activeRides:   rides.docs.filter(d=>['requested','accepted','ongoing'].includes(d.data().status)).length,
        totalDrivers:  drivers.size,
        onlineDrivers: drivers.docs.filter(d=>d.data().isOnline).length,
        users:         users.size,
        owners:        owners.size,
        revenue:       +revenue.toFixed(2),
        commission:    +(revenue*0.15).toFixed(2),
      }});
    }

    // GET /  — home page
if (method === 'GET' && path === '/') {
  return res.status(200).json({
    name:    "Okada Online API",
    version: "2.0",
    status:  "🟢 Live",
    docs:    "https://github.com/Berima1/Okada-online-backend",
    endpoints: [
      "POST /api/auth/send-otp",
      "POST /api/auth/verify-otp",
      "POST /api/rides/request",
      "POST /api/rides/:id/accept",
      "POST /api/rides/:id/complete",
      "GET  /api/rides/history/:userId",
      "PUT  /api/drivers/:id/location",
      "PUT  /api/drivers/:id/status",
      "GET  /api/owners/:id/dashboard",
      "POST /api/payments/initialize",
      "POST /api/ussd/callback",
      "GET  /api/admin/stats",
      "GET  /api/health",
    ]
  });
    }
    
    // GET /health  — useful for uptime checks
    if (method==='GET' && path==='/health') {
      return ok(res, { status:'ok', version:'2.0', platform:'Vercel', timestamp: new Date().toISOString() });
    }

    // ── 404 fallthrough ───────────────────────────────
    return fail(res, 404, `Route not found: ${method} ${path}`);

  } catch (e) {
    console.error('[OkadaOnline] Error:', e);
    return fail(res, 500, e.message);
  }
};
