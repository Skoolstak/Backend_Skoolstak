const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/student');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('student'));

router.get('/timetable',        ctrl.timetable);
router.get('/attendance',       ctrl.attendance);
router.get('/fees',             ctrl.fees);
router.get('/library',          ctrl.library);
router.get('/academic-history', ctrl.academicHistory);

module.exports = router;
