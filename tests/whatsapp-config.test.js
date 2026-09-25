const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAdminWhatsAppNumber,
  normalizeWhatsAppNumber,
  normalizeBookingPayload,
  createWhatsAppRequest,
  isValidTwilioTemplateSid,
  generateBookingId
} = require('../controllers/bookingController');

test('prefers ADMIN_WHATSAPP and falls back to WHATSAPP_TO', () => {
  const previousAdmin = process.env.ADMIN_WHATSAPP;
  const previousWhatsAppTo = process.env.WHATSAPP_TO;

  process.env.ADMIN_WHATSAPP = 'whatsapp:+918074695714';
  process.env.WHATSAPP_TO = 'whatsapp:+918074695714';

  try {
    assert.equal(resolveAdminWhatsAppNumber(), 'whatsapp:+918074695714');
  } finally {
    if (previousAdmin === undefined) delete process.env.ADMIN_WHATSAPP;
    else process.env.ADMIN_WHATSAPP = previousAdmin;

    if (previousWhatsAppTo === undefined) delete process.env.WHATSAPP_TO;
    else process.env.WHATSAPP_TO = previousWhatsAppTo;
  }
});

test('falls back to WHATSAPP_TO when ADMIN_WHATSAPP is missing', () => {
  const previousAdmin = process.env.ADMIN_WHATSAPP;
  const previousWhatsAppTo = process.env.WHATSAPP_TO;

  delete process.env.ADMIN_WHATSAPP;
  process.env.WHATSAPP_TO = 'whatsapp:+918074695714';

  try {
    assert.equal(resolveAdminWhatsAppNumber(), 'whatsapp:+918074695714');
  } finally {
    if (previousAdmin === undefined) delete process.env.ADMIN_WHATSAPP;
    else process.env.ADMIN_WHATSAPP = previousAdmin;

    if (previousWhatsAppTo === undefined) delete process.env.WHATSAPP_TO;
    else process.env.WHATSAPP_TO = previousWhatsAppTo;
  }
});

test('converts Indian mobile numbers to WhatsApp format', () => {
  assert.equal(normalizeWhatsAppNumber('9876543210'), 'whatsapp:+919876543210');
  assert.equal(normalizeWhatsAppNumber('+91 98765 43210'), 'whatsapp:+919876543210');
});

test('normalizes booking payment method and amount', () => {
  const booking = normalizeBookingPayload({
    name: 'Ravi',
    email: 'ravi@example.com',
    phone: '9876543210',
    service: 'installation',
    date: '2026-09-30',
    time: '10:00',
    city: 'Hyderabad',
    message: 'Need installation',
    paymentMethod: 'UPI',
    paymentAmount: '250'
  });

  assert.equal(booking.paymentMethod, 'UPI');
  assert.equal(Number(booking.paymentAmount), 250);

  const fallback = normalizeBookingPayload({
    name: 'Ravi',
    email: 'ravi@example.com',
    phone: '9876543210',
    service: 'installation',
    date: '2026-09-30',
    time: '10:00',
    city: 'Hyderabad'
  });

  assert.equal(fallback.paymentMethod, 'UPI');
  assert.equal(Number(fallback.paymentAmount), 250);
});

test('generates a unique booking ID for each service request', () => {
  const firstId = generateBookingId();
  const secondId = generateBookingId();

  assert.match(firstId, /^SP-\d{8}-\d{4}$/);
  assert.notEqual(firstId, secondId);
});

test('requires valid WhatsApp template IDs before sending a message', () => {
  const previousTemplate = process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
  const previousCustomerTemplate = process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID;
  const previousAllowPlainBody = process.env.ALLOW_TWILIO_WHATSAPP_PLAIN_BODY;

  delete process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
  delete process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID;
  delete process.env.ALLOW_TWILIO_WHATSAPP_PLAIN_BODY;

  try {
    assert.equal(isValidTwilioTemplateSid(''), false);
    assert.throws(() => createWhatsAppRequest({
      to: 'whatsapp:+918074695714',
      body: 'hello'
    }), /valid template SID/i);
  } finally {
    if (previousTemplate === undefined) delete process.env.TWILIO_WHATSAPP_TEMPLATE_SID;
    else process.env.TWILIO_WHATSAPP_TEMPLATE_SID = previousTemplate;

    if (previousCustomerTemplate === undefined) delete process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID;
    else process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID = previousCustomerTemplate;

    if (previousAllowPlainBody === undefined) delete process.env.ALLOW_TWILIO_WHATSAPP_PLAIN_BODY;
    else process.env.ALLOW_TWILIO_WHATSAPP_PLAIN_BODY = previousAllowPlainBody;
  }
});
