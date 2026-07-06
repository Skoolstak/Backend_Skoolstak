const router = require('express').Router();
const ctrl   = require('../controllers/alumni');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
router.use(requireRole('school_admin', 'super_admin'));

router.get('/',              ctrl.list);
router.get('/years',         ctrl.years);
router.get('/:id',           ctrl.getOne);
router.post('/graduate',     ctrl.graduate);
router.put('/:id',           ctrl.update);

module.exports = router;
