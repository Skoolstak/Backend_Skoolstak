const express = require('express');
const router  = express.Router();
const supabase = require('../supabaseClient');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Record offline sync failures so admins can audit data loss
router.post('/', async (req, res) => {
  const { action_type, errors } = req.body;
  if (!action_type || !Array.isArray(errors) || errors.length === 0) {
    return res.status(400).json({ error: 'action_type and errors[] are required.' });
  }

  const rows = errors.slice(0, 100).map(e => ({
    school_id:   req.schoolId,
    user_id:     req.profile?.id || null,
    action_type: String(action_type).slice(0, 50),
    payload:     { error: String(e?.error || e || 'Unknown sync error').slice(0, 500), item: e?.item || null },
    synced_at:   new Date().toISOString(),
  }));

  const { error } = await supabase.from('sync_log').insert(rows);
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ logged: rows.length });
});

module.exports = router;
