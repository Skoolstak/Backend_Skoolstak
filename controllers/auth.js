'use strict';
const supabase = require('../supabaseClient'); // service-role client
const { isValidEmail, isSafeText, cleanString } = require('../middleware/sanitize');

/**
 * POST /api/auth/register
 * Public endpoint — registers a new school + its first admin account.
 * Body: { email, password, first_name, last_name, school_name, slug }
 */
exports.register = async (req, res) => {
  const { email, password, first_name, last_name, school_name, slug } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!email || !password || !first_name || !last_name || !school_name || !slug) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (email.length > 254) {
    return res.status(400).json({ error: 'Email address is too long.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (password.length > 128) {
    return res.status(400).json({ error: 'Password is too long.' });
  }
  if (!isSafeText(first_name, 100) || !isSafeText(last_name, 100)) {
    return res.status(400).json({ error: 'Name fields must be between 1 and 100 characters.' });
  }
  if (!isSafeText(school_name, 200)) {
    return res.status(400).json({ error: 'School name must be between 1 and 200 characters.' });
  }
  if (!/^[a-z0-9-]+$/.test(slug) || slug.length > 60) {
    return res.status(400).json({ error: 'Slug may only contain lowercase letters, numbers, and hyphens (max 60 chars).' });
  }

  // ── Check slug is not already taken ────────────────────────────────────────
  const { data: existing } = await supabase
    .from('schools')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'That school URL slug is already taken. Choose another.' });
  }

  // ── Create Supabase auth user (service-role — no email confirmation needed) ─
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // auto-confirm so user can log in immediately
  });

  if (authError) {
    // Surface duplicate-email error clearly
    if (authError.message?.toLowerCase().includes('already registered')) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    return res.status(400).json({ error: authError.message });
  }

  const authUserId = authData.user.id;

  // ── Create school row ───────────────────────────────────────────────────────
  const { data: school, error: schoolError } = await supabase
    .from('schools')
    .insert({ name: school_name, slug, plan: 'free', status: 'active' })
    .select()
    .single();

  if (schoolError) {
    // Roll back auth user so the same email can be retried
    await supabase.auth.admin.deleteUser(authUserId);
    return res.status(400).json({ error: schoolError.message });
  }

  // ── Create user_profile row ─────────────────────────────────────────────────
  const { error: profileError } = await supabase
    .from('user_profiles')
    .insert({
      auth_user_id: authUserId,
      school_id:    school.id,
      role:         'school_admin',
      first_name,
      last_name,
    });

  if (profileError) {
    await supabase.auth.admin.deleteUser(authUserId);
    await supabase.from('schools').delete().eq('id', school.id);
    return res.status(400).json({ error: profileError.message });
  }

  res.status(201).json({ message: 'School registered successfully. You can now sign in.' });
};
