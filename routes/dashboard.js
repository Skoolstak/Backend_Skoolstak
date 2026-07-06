const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/dashboard');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');

router.use(authMiddleware);

// Cache admin summary 60s — KPI cards don't need real-time precision
router.get('/summary',          requireRole('school_admin'), cacheMiddleware(60),  ctrl.adminSummary);
// Cache revenue chart 5 minutes — monthly data changes rarely
router.get('/revenue-chart',    requireRole('school_admin'), cacheMiddleware(300), ctrl.monthlyRevenue);
// Teacher/student/parent summaries: 30s cache — balance freshness vs DB load
router.get('/teacher-summary',  requireRole('teacher'),      cacheMiddleware(30),  ctrl.teacherSummary);
router.get('/student-summary',  requireRole('student'),      cacheMiddleware(30),  ctrl.studentSummary);
router.get('/parent-summary',   requireRole('parent'),       cacheMiddleware(30),  ctrl.parentSummary);

module.exports = router;
