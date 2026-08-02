'use strict';
const express = require('express');
const router  = express.Router();
const { register, loginWithId, forgotPassword, resetPassword } = require('../controllers/auth');

// POST /api/auth/register — public, no auth middleware
router.post('/register', register);

// POST /api/auth/login-with-id — student/teacher ID login
router.post('/login-with-id', loginWithId);

// POST /api/auth/forgot-password — initiate password reset
router.post('/forgot-password', forgotPassword);

// POST /api/auth/reset-password — complete password reset
router.post('/reset-password', resetPassword);

module.exports = router;
