const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/staff');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('school_admin'));

router.get('/',      ctrl.list);
router.post('/',     ctrl.create);
router.post('/import-excel', ctrl.importExcel);
router.put('/:id',   ctrl.update);
router.delete('/:id',ctrl.remove);

module.exports = router;
