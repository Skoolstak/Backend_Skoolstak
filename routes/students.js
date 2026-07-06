const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/students');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',      requireRole('school_admin','super_admin','teacher','parent'), ctrl.list);
router.post('/',     requireRole('school_admin'), ctrl.create);
router.put('/:id',   requireRole('school_admin'), ctrl.update);
router.delete('/:id',requireRole('school_admin'), ctrl.remove);

module.exports = router;
