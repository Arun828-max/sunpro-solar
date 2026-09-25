const express = require('express');
const router = express.Router();

const {
  createBooking,
  getAllBookings,
  getBookingById
} = require('../controllers/bookingController');

// POST /api/book
router.post('/book', createBooking);

// GET /api/bookings
router.get('/bookings', getAllBookings);

// GET /api/booking/:id
router.get('/booking/:id', getBookingById);

module.exports = router;
