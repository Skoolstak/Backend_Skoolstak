const router = require('express').Router();
const ctrl   = require('../controllers/grades');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// All authenticated roles can read grades (RLS restricts what they see)
router.get('/',                      ctrl.list);
router.get('/student/:student_id',   ctrl.studentHistory);

// Teachers post grades
router.post('/',       requireRole('teacher', 'school_admin'), ctrl.upsert);
router.post('/bulk',   requireRole('teacher', 'school_admin'), ctrl.bulkUpsert);
router.post('/sync',   requireRole('teacher', 'school_admin'), ctrl.syncOffline);
router.put('/:id',     requireRole('teacher', 'school_admin'), ctrl.update);
router.delete('/:id',  requireRole('school_admin'),            ctrl.remove);

module.exports = router;
