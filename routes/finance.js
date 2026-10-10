const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/finance');
const payroll = require('../controllers/payroll');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const admin  = requireRole('school_admin');
const viewer = requireRole('school_admin','student','parent');

// Staff pay: salary history, allowances / bonuses / deductions, printable salary notices (admin only)
router.get('/salaries',                          admin, payroll.listSalaries);
router.get('/salaries/:id',                      admin, payroll.getStaffPay);
router.post('/salaries/:id/history',             admin, payroll.addSalaryRevision);
router.delete('/salaries/history/:historyId',    admin, payroll.deleteSalaryRevision);
router.post('/salaries/:id/adjustments',         admin, payroll.addAdjustment);
router.put('/salaries/adjustments/:adjId',       admin, payroll.updateAdjustmentEnd);
router.delete('/salaries/adjustments/:adjId',    admin, payroll.deleteAdjustment);
router.get('/salary-notice/:id/pdf',             admin, payroll.generateSalaryNoticePDF);
router.get('/payroll-list/pdf',                  admin, payroll.generatePayrollListPDF);

// Fee types
router.get('/fee-types',         admin,  ctrl.listFeeTypes);
router.post('/fee-types',        admin,  ctrl.createFeeType);
router.put('/fee-types/:id',     admin,  ctrl.updateFeeType);
router.delete('/fee-types/:id',  admin,  ctrl.deleteFeeType);

// Invoices
router.get('/invoices',          viewer, ctrl.listInvoices);
router.post('/invoices',         admin,  ctrl.createInvoice);
router.put('/invoices/:id',      admin,  ctrl.updateInvoice);
router.delete('/invoices/:id',   admin,  ctrl.deleteInvoice);
router.post('/invoices/:id/pay', admin,  ctrl.payInvoice);   // admin records a payment; students/parents pay through /initiate-payment
router.get('/invoice/:id/pdf',   viewer, ctrl.generateInvoicePDF);

// Payments
router.get('/payments',          admin,  ctrl.listPayments);
router.post('/payments',         admin,  ctrl.recordPayment);
router.get('/receipt/:paymentId/pdf', viewer, ctrl.generateReceiptPDF);

// Cash Flow
router.get('/cash-flow',         admin,  ctrl.listCashFlow);
router.post('/cash-flow',        admin,  ctrl.createCashFlow);
router.put('/cash-flow/:id',     admin,  ctrl.updateCashFlow);
router.delete('/cash-flow/:id',  admin,  ctrl.deleteCashFlow);
// Aliases without hyphen — older client builds call /cashflow
router.get('/cashflow',          admin,  ctrl.listCashFlow);
router.post('/cashflow',         admin,  ctrl.createCashFlow);
router.put('/cashflow/:id',      admin,  ctrl.updateCashFlow);
router.delete('/cashflow/:id',   admin,  ctrl.deleteCashFlow);

// Paystack initiation
router.post('/initiate-payment', viewer, ctrl.initiatePaystackPayment);
router.post('/webhook',                  ctrl.paystackWebhook);   // no auth – Paystack signed

module.exports = router;
