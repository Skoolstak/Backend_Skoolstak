const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/teacher');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('teacher'));

router.get('/classes', ctrl.myClasses);
router.get('/class-stats/:id', ctrl.classStats);
router.get('/assignments', ctrl.listAssignments);
router.post('/assignments', ctrl.createAssignment);
router.delete('/assignments/:id', ctrl.deleteAssignment);

module.exports = router;
