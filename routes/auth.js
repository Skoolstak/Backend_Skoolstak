'use strict';
const express = require('express');
const router  = express.Router();
const { register } = require('../controllers/auth');

// POST /api/auth/register — public, no auth middleware
router.post('/register', register);

module.exports = router;
