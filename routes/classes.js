const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/classes');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',                requireRole('school_admin','teacher','student','parent'), ctrl.list);
router.post('/',               requireRole('school_admin'), ctrl.create);
router.put('/:id',             requireRole('school_admin'), ctrl.update);
router.delete('/:id',          requireRole('school_admin'), ctrl.remove);
router.get('/:id/students',    requireRole('school_admin','teacher'), ctrl.listStudents);

module.exports = router;
