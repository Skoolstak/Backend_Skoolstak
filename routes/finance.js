const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/finance');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const admin  = requireRole('school_admin');
const viewer = requireRole('school_admin','student','parent');

// Fee types
router.get('/fee-types',         admin,  ctrl.listFeeTypes);
router.post('/fee-types',        admin,  ctrl.createFeeType);
router.put('/fee-types/:id',     admin,  ctrl.updateFeeType);

// Invoices
router.get('/invoices',          viewer, ctrl.listInvoices);
router.post('/invoices',         admin,  ctrl.createInvoice);
router.post('/invoices/:id/pay', viewer, ctrl.payInvoice);

// Payments
router.get('/payments',          admin,  ctrl.listPayments);
router.post('/payments',         admin,  ctrl.recordPayment);

// Cash Flow
router.get('/cash-flow',         admin,  ctrl.listCashFlow);
router.post('/cash-flow',        admin,  ctrl.createCashFlow);
router.delete('/cash-flow/:id',  admin,  ctrl.deleteCashFlow);

// Paystack initiation
router.post('/initiate-payment', viewer, ctrl.initiatePaystackPayment);
router.post('/webhook',                  ctrl.paystackWebhook);   // no auth – Paystack signed

module.exports = router;
