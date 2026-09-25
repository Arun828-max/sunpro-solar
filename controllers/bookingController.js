const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const DEFAULT_PAYMENT_AMOUNT = 250;

const isValidTwilioTemplateSid = (templateSid) => {
  const value = String(templateSid || '').trim();
  return !!value && !['your_approved_template_sid_here', 'your_customer_template_sid_here'].includes(value);
};

const normalizeBookingPayload = (payload = {}) => {
  const paymentMethod = String(payload.paymentMethod || 'UPI').trim() || 'UPI';
  const amountValue = Number(payload.paymentAmount ?? DEFAULT_PAYMENT_AMOUNT);
  const validAmount = Number.isFinite(amountValue) && amountValue > 0 ? amountValue : DEFAULT_PAYMENT_AMOUNT;

  return {
    ...payload,
    bookingId: String(payload.bookingId || '').trim(),
    name: String(payload.name || '').trim(),
    email: String(payload.email || '').trim().toLowerCase(),
    phone: String(payload.phone || '').trim(),
    service: String(payload.service || payload.serviceType || '').trim(),
    serviceType: String(payload.serviceType || payload.service || '').trim(),
    date: String(payload.date || '').trim(),
    time: String(payload.time || '').trim(),
    city: String(payload.city || '').trim(),
    message: String(payload.message || '').trim(),
    paymentMethod,
    paymentAmount: String(validAmount)
  };
};

const generateBookingId = (prefix = 'SP') => {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const sequence = String(Math.floor(Math.random() * 9000) + 1000);
  return `${prefix}-${dateStamp}-${sequence}`;
};

const resolveAdminWhatsAppNumber = () => {
  return (process.env.ADMIN_WHATSAPP || process.env.WHATSAPP_TO || '').trim();
};

// Helper function to normalize phone numbers for WhatsApp.
const normalizeWhatsAppNumber = (phone) => {
  if (!phone) {
    return null;
  }

  let cleaned = String(phone).replace(/\D/g, '');

  // India format conversion: 10-digit mobile -> +91xxxxxxxxxx
  if (cleaned.length === 10) {
    cleaned = `91${cleaned}`;
  }

  return `whatsapp:+${cleaned}`;
};

const createWhatsAppRequest = ({ to, body, templateSid, templateVars }) => {
  const payload = {
    from: process.env.TWILIO_WHATSAPP_FROM,
    to
  };

  if (isValidTwilioTemplateSid(templateSid)) {
    payload.contentSid = templateSid;
    if (templateVars && Object.keys(templateVars).length) {
      payload.contentVariables = JSON.stringify(templateVars);
    }
    return payload;
  }

  const allowPlainBody = String(process.env.ALLOW_TWILIO_WHATSAPP_PLAIN_BODY || '').toLowerCase() === 'true';

  if (allowPlainBody) {
    payload.body = body;
    return payload;
  }

  throw new Error('Twilio WhatsApp is not configured with a valid template SID. Set TWILIO_WHATSAPP_TEMPLATE_SID and TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID in your .env file using approved WhatsApp template IDs from Twilio.');
};

// Send the admin WhatsApp message with the full booking details.
const sendAdminWhatsApp = async (booking) => {
  try {
    const adminNumber = resolveAdminWhatsAppNumber();
    const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
    const templateSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID;

    if (!adminNumber || !fromNumber) {
      console.log('Admin WhatsApp configuration missing.');
      return;
    }

    if (!isValidTwilioTemplateSid(templateSid)) {
      console.log('Admin WhatsApp skipped: TWILIO_WHATSAPP_TEMPLATE_SID is not configured with a valid approved WhatsApp template.');
      return;
    }

    const messageBody = [
      'New Booking Request',
      `Name: ${booking.name}`,
      `Email: ${booking.email}`,
      `Phone: ${booking.phone}`,
      `Service: ${booking.service}`,
      `Date: ${booking.date}`,
      `Time: ${booking.time}`,
      `Message: ${booking.message || 'No message provided'}`
    ].join('\n');

    const requestPayload = createWhatsAppRequest({
      to: adminNumber,
      body: messageBody,
      templateSid,
      templateVars: {
        1: String(booking.name || ''),
        2: String(booking.service || ''),
        3: String(booking.phone || ''),
        4: String(booking.date || ''),
        5: String(booking.time || ''),
        6: String(booking.message || 'No message provided')
      }
    });

    const response = await client.messages.create(requestPayload);

    console.log('Admin WhatsApp sent successfully:', response.sid);
    return response;
  } catch (error) {
    console.log('Error sending admin WhatsApp:', error.message);
    throw error;
  }
};

// Send a WhatsApp confirmation message to the customer after successful booking.
const sendCustomerWhatsAppConfirmation = async (booking) => {
  try {
    const customerPhone = normalizeWhatsAppNumber(booking.phone);
    const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
    const templateSid = process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID;

    if (!customerPhone || !fromNumber) {
      console.log('Customer WhatsApp confirmation skipped: missing phone or sender number.');
      return;
    }

    if (!isValidTwilioTemplateSid(templateSid)) {
      console.log('Customer WhatsApp skipped: TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID is not configured with a valid approved WhatsApp template.');
      return;
    }

    const messageBody = [
      'Thank you for booking with us!',
      `Hello ${booking.name},`,
      `Your ${booking.service} booking has been received.`,
      `Date: ${booking.date}`,
      `Time: ${booking.time}`,
      'We will contact you shortly.'
    ].join('\n');

    const requestPayload = createWhatsAppRequest({
      to: customerPhone,
      body: messageBody,
      templateSid,
      templateVars: {
        1: String(booking.name || ''),
        2: String(booking.service || ''),
        3: String(booking.date || ''),
        4: String(booking.time || '')
      }
    });

    const response = await client.messages.create(requestPayload);

    console.log('Customer WhatsApp confirmation sent:', response.sid);
    return response;
  } catch (error) {
    console.log('Error sending customer WhatsApp confirmation:', error.message);
    throw error;
  }
};

// Create a new booking and trigger admin + customer WhatsApp notifications.
const createBooking = async (req, res) => {
  try {
    const { name, email, phone, service, date, time, message } = req.body;

    // Validate required fields.
    if (!name || !email || !phone || !service || !date || !time) {
      console.log('Booking validation failed: required fields missing.');
      return res.status(400).json({
        success: false,
        message: 'Please fill in all required fields.'
      });
    }

    // Validate phone format.
    const phoneRegex = /^[0-9+\-\s()]{10,20}$/;
    if (!phoneRegex.test(phone)) {
      console.log('Booking validation failed: invalid phone format.');
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid phone number.'
      });
    }

    const bookingData = {
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      phone: String(phone).trim(),
      service: String(service).trim(),
      date: String(date).trim(),
      time: String(time).trim(),
      message: String(message || '').trim(),
      status: 'pending'
    };

    const newBooking = new Booking(bookingData);
    const savedBooking = await newBooking.save();

    console.log('Booking saved successfully:', savedBooking);

    // Send admin WhatsApp after the booking is successfully stored.
    try {
      await sendAdminWhatsApp(savedBooking);
    } catch (adminError) {
      console.log('Admin WhatsApp failed but booking was saved:', adminError.message);
    }

    // Send customer confirmation WhatsApp after the booking is successfully stored.
    try {
      await sendCustomerWhatsAppConfirmation(savedBooking);
    } catch (customerError) {
      console.log('Customer confirmation WhatsApp failed but booking was saved:', customerError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Booking created successfully.',
      data: savedBooking
    });
  } catch (error) {
    console.log('Error creating booking:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while creating the booking.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all bookings.
const getAllBookings = async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    console.log('Fetched all bookings:', bookings.length);

    return res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings
    });
  } catch (error) {
    console.log('Error fetching bookings:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to fetch bookings.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get one booking by ID.
const getBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id);

    if (!booking) {
      console.log('Booking not found for ID:', id);
      return res.status(404).json({
        success: false,
        message: 'Booking not found.'
      });
    }

    console.log('Fetched booking by ID:', id);

    return res.status(200).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.log('Error fetching booking by ID:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to fetch booking.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  createBooking,
  getAllBookings,
  getBookingById,
  resolveAdminWhatsAppNumber,
  normalizeWhatsAppNumber,
  normalizeBookingPayload,
  generateBookingId,
  createWhatsAppRequest,
  isValidTwilioTemplateSid
};
