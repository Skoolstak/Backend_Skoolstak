const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/parent');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('parent'));

router.get('/attendance', ctrl.attendance);
router.get('/fees',       ctrl.fees);

module.exports = router;
