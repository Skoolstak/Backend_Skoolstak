const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/schools');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
router.use(requireRole('super_admin'));

router.get('/',    ctrl.list);
router.post('/',   ctrl.create);
router.patch('/:id/status', ctrl.updateStatus);

module.exports = router;
