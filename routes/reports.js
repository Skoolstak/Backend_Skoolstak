const router = require('express').Router();
const ctrl   = require('../controllers/reports');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',                           ctrl.list);
router.get('/:id',                        ctrl.getOne);
router.get('/:id/pdf',                    ctrl.pdf);

router.post('/generate',       requireRole('school_admin'), ctrl.generate);
router.post('/generate-class', requireRole('school_admin'), ctrl.generateClass);
router.put('/:id',             requireRole('school_admin'), ctrl.update);
router.put('/:id/publish',     requireRole('school_admin'), ctrl.publish);
router.put('/:id/unpublish',   requireRole('school_admin'), ctrl.unpublish);

module.exports = router;
