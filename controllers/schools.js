const supabase = require('../supabaseClient');
const { isValidUUID } = require('../middleware/sanitize');

const VALID_SCHOOL_STATUSES = ['active', 'suspended'];

exports.list = async (req, res) => {
  const { data, error } = await supabase
    .from('schools')
    .select('*, user_profiles(count)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ schools: data });
};

exports.create = async (req, res) => {
  const { name, slug, plan = 'starter', admin_email, admin_first_name, admin_last_name } = req.body;

  if (!name || !slug || !admin_email) {
    return res.status(400).json({ error: 'name, slug, and admin_email are required.' });
  }
  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email)) {
    return res.status(400).json({ error: 'admin_email is not a valid email address.' });
  }
  // Slug: alphanumeric + hyphens only
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'slug may only contain lowercase letters, numbers, and hyphens.' });
  }

  // 1. Create school row
  const { data: school, error: schoolErr } = await supabase
    .from('schools')
    .insert({ name, slug, plan, status: 'active' })
    .select()
    .single();
  if (schoolErr) return res.status(400).json({ error: schoolErr.message });

  // 2. Invite admin user via Supabase Auth
  const { data: invited, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(admin_email);
  if (inviteErr) return res.status(400).json({ error: inviteErr.message });

  // 3. Create user_profile for new admin
  await supabase.from('user_profiles').insert({
    auth_user_id: invited.user.id,
    school_id: school.id,
    role: 'school_admin',
    first_name: admin_first_name,
    last_name: admin_last_name,
  });

  res.status(201).json({ school });
};

exports.updateStatus = async (req, res) => {
  const { status } = req.body;
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  if (!VALID_SCHOOL_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_SCHOOL_STATUSES.join(', ')}.` });
  }
  const { data, error } = await supabase
    .from('schools')
    .update({ status })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ school: data });
};
