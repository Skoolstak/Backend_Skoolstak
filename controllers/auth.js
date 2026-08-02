'use strict';
const supabase = require('../supabaseClient'); // service-role client
const { isValidEmail, isSafeText, cleanString } = require('../middleware/sanitize');
const crypto = require('crypto');

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

/**
 * POST /api/auth/login-with-id
 * Public endpoint — login for students/teachers using their ID + password
 * Body: { id, password } where id is student_id or staff_id
 */
exports.loginWithId = async (req, res) => {
  const { id, password } = req.body;

  if (!id || !password) {
    return res.status(400).json({ error: 'ID and password are required.' });
  }

  // Check if it's a student ID
  if (id.startsWith('STU-')) {
    const { data: student, error } = await supabase
      .from('students')
      .select('*, user_profile_id')
      .eq('student_id', id)
      .maybeSingle();

    if (error || !student) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    if (!student.user_profile_id) {
      return res.status(401).json({ error: 'Student account not activated. Contact your administrator.' });
    }

    // Get user profile to find auth_user_id
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('auth_user_id')
      .eq('id', student.user_profile_id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    // Get auth user email
    const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(profile.auth_user_id);

    if (authError || !authUser.user) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    // Sign in with email and password
    const { data: session, error: signInError } = await supabase.auth.signInWithPassword({
      email: authUser.user.email,
      password,
    });

    if (signInError) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    return res.json({ 
      message: 'Login successful',
      session: session.session,
      user: session.user,
      role: 'student',
      id: student.student_id
    });
  }

  // Check if it's a teacher/staff ID
  if (id.startsWith('TEA-')) {
    const { data: staff, error } = await supabase
      .from('staff')
      .select('*, user_profile_id')
      .eq('staff_id', id)
      .maybeSingle();

    if (error || !staff) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    // Get user profile to find auth_user_id
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('auth_user_id, role')
      .eq('id', staff.user_profile_id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    // Get auth user email
    const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(profile.auth_user_id);

    if (authError || !authUser.user) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    // Sign in with email and password
    const { data: session, error: signInError } = await supabase.auth.signInWithPassword({
      email: authUser.user.email,
      password,
    });

    if (signInError) {
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }

    return res.json({ 
      message: 'Login successful',
      session: session.session,
      user: session.user,
      role: profile.role,
      id: staff.staff_id
    });
  }

  return res.status(400).json({ error: 'Invalid ID format. Must start with STU- or TEA-' });
};

/**
 * POST /api/auth/forgot-password
 * Public endpoint — initiates password reset flow
 * Body: { email }
 */
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email address is required.' });
  }

  // Use Supabase's built-in password reset
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.CLIENT_URL}/reset-password`,
  });

  // Always return success to prevent email enumeration
  res.json({ message: 'If that email exists, a password reset link has been sent.' });
};

/**
 * POST /api/auth/reset-password
 * Public endpoint — completes password reset with token
 * Body: { token, password }
 */
exports.resetPassword = async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  if (password.length > 128) {
    return res.status(400).json({ error: 'Password is too long.' });
  }

  // Update password using the access token from the reset email
  const { data, error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }

  res.json({ message: 'Password updated successfully. You can now sign in.' });
};
