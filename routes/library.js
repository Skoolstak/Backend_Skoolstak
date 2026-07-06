const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/library');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const admin  = requireRole('school_admin');
const viewer = requireRole('school_admin','teacher','student','parent');

router.get('/books',           viewer, ctrl.listBooks);
router.post('/books',          admin,  ctrl.createBook);
router.put('/books/:id',       admin,  ctrl.updateBook);

router.get('/loans',           viewer, ctrl.listLoans);
router.post('/loans',          admin,  ctrl.issueBook);
router.patch('/loans/:id/return', admin, ctrl.returnBook);

module.exports = router;
