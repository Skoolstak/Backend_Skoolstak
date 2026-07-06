'use strict';
const supabase = require('../supabaseClient'); // service-role client
const { isValidUUID } = require('../middleware/sanitize');

const ALLOWED_ROLES = ['teacher', 'school_admin'];

exports.list = async (req, res) => {
  const { data, error } = await supabase
    .from('staff')
    .select('id, department, designation, user_profiles!user_profile_id(id, first_name, last_name, role, phone)')
    .eq('school_id', req.schoolId);

  if (error) return res.status(500).json({ error: error.message });

  const staff = (data || [])
    .map(s => ({
      id:              s.id,
      user_profile_id: s.user_profiles?.id,
      first_name:      s.user_profiles?.first_name  || '',
      last_name:       s.user_profiles?.last_name   || '',
      role:            s.user_profiles?.role        || '',
      phone:           s.user_profiles?.phone       || '',
      department:      s.department  || '',
      designation:     s.designation || '',
    }))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  res.json({ staff });
};

exports.create = async (req, res) => {
  const { first_name, last_name, email, phone, role = 'teacher', department, designation } = req.body;

  if (!first_name || !last_name || !email) {
    return res.status(400).json({ error: 'first_name, last_name, and email are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}.` });
  }

  // 1. Invite user — they receive an email to set their password
  const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email);
  if (inviteErr) {
    const msg = inviteErr.message?.toLowerCase().includes('already registered')
      ? 'A user with that email already exists.'
      : inviteErr.message;
    return res.status(400).json({ error: msg });
  }

  const authUserId = inviteData.user.id;

  // 2. Create user_profile
  const { data: profileRow, error: profileErr } = await supabase
    .from('user_profiles')
    .insert({ auth_user_id: authUserId, school_id: req.schoolId, role, first_name, last_name, phone: phone || null })
    .select()
    .single();

  if (profileErr) {
    await supabase.auth.admin.deleteUser(authUserId);
    return res.status(400).json({ error: profileErr.message });
  }

  // 3. Create staff row
  const { data: staffRow, error: staffErr } = await supabase
    .from('staff')
    .insert({ school_id: req.schoolId, user_profile_id: profileRow.id, department: department || null, designation: designation || null })
    .select()
    .single();

  if (staffErr) {
    await supabase.auth.admin.deleteUser(authUserId);
    await supabase.from('user_profiles').delete().eq('id', profileRow.id);
    return res.status(400).json({ error: staffErr.message });
  }

  res.status(201).json({
    staff: { id: staffRow.id, user_profile_id: profileRow.id, first_name, last_name, role, phone, department: staffRow.department, designation: staffRow.designation },
    message: `Invitation sent to ${email}.`,
  });
};

exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  const { first_name, last_name, phone, role, department, designation } = req.body;

  const { data: staffRow } = await supabase
    .from('staff').select('user_profile_id').eq('id', req.params.id).eq('school_id', req.schoolId).single();
  if (!staffRow) return res.status(404).json({ error: 'Staff member not found.' });

  const profileUpdates = {};
  if (first_name) profileUpdates.first_name = first_name;
  if (last_name)  profileUpdates.last_name  = last_name;
  if (phone !== undefined) profileUpdates.phone = phone || null;
  if (role && ALLOWED_ROLES.includes(role)) profileUpdates.role = role;
  if (Object.keys(profileUpdates).length > 0) {
    await supabase.from('user_profiles').update(profileUpdates).eq('id', staffRow.user_profile_id);
  }

  const staffUpdates = {};
  if (department  !== undefined) staffUpdates.department  = department  || null;
  if (designation !== undefined) staffUpdates.designation = designation || null;

  const { data, error } = await supabase
    .from('staff')
    .update(staffUpdates)
    .eq('id', req.params.id).eq('school_id', req.schoolId)
    .select('id, department, designation, user_profiles!user_profile_id(first_name, last_name, role, phone)')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ staff: {
    id: data.id,
    first_name:  data.user_profiles?.first_name,
    last_name:   data.user_profiles?.last_name,
    role:        data.user_profiles?.role,
    phone:       data.user_profiles?.phone,
    department:  data.department,
    designation: data.designation,
  }});
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  const { data: staffRow } = await supabase
    .from('staff')
    .select('user_profile_id, user_profiles!user_profile_id(auth_user_id)')
    .eq('id', req.params.id).eq('school_id', req.schoolId).single();

  if (!staffRow) return res.status(404).json({ error: 'Staff member not found.' });

  const { error } = await supabase.from('staff').delete().eq('id', req.params.id).eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });

  const authUserId = staffRow.user_profiles?.auth_user_id;
  if (authUserId) await supabase.auth.admin.deleteUser(authUserId);

  res.json({ success: true });
};
