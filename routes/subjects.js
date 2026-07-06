const router  = require('express').Router();
const ctrl    = require('../controllers/subjects');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');

router.use(authMiddleware);

// Cache subject list 2 minutes — subjects don't change often
router.get('/',     cacheMiddleware(120), ctrl.list);
router.post('/',    requireRole('school_admin'), ctrl.create);
router.put('/:id',  requireRole('school_admin'), ctrl.update);
router.delete('/:id', requireRole('school_admin'), ctrl.remove);

module.exports = router;
