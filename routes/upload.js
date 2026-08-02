const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/upload');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// Upload student photo (school_admin only)
router.post('/student-photo/:studentId', requireRole('school_admin'), ctrl.uploadStudentPhoto);

// Upload staff photo (school_admin only)
router.post('/staff-photo/:staffId', requireRole('school_admin'), ctrl.uploadStaffPhoto);

module.exports = router;
