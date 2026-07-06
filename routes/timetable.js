const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/timetable');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',    requireRole('school_admin','teacher','student','parent'), ctrl.list);
router.post('/',   requireRole('school_admin'), ctrl.upsert);
router.delete('/:id', requireRole('school_admin'), ctrl.remove);

module.exports = router;
