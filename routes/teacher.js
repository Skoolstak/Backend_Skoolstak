const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/teacher');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('teacher'));

router.get('/classes', ctrl.myClasses);

module.exports = router;
