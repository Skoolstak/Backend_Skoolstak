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

/**
 * POST /api/staff/import-excel
 * Bulk import staff members from Excel file
 * Expects base64 encoded Excel file in req.body.file
 * Required columns: first_name, last_name, email
 * Optional columns: phone, role, department, designation
 */
exports.importExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { file } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    // Decode base64
    let buffer;
    if (typeof file === 'string' && file.startsWith('data:')) {
      const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid base64 format.' });
      }
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      return res.status(400).json({ error: 'File must be base64 encoded.' });
    }

    // Parse Excel
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty.' });
    }

    const results = { success: 0, failed: 0, errors: [] };

    // Process each row
    for (const row of data) {
      try {
        if (!row.first_name || !row.last_name || !row.email) {
          results.failed++;
          results.errors.push({ row, error: 'Missing first_name, last_name, or email' });
          continue;
        }

        const email = String(row.email).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          results.failed++;
          results.errors.push({ row, error: 'Invalid email address' });
          continue;
        }

        const role = row.role && ALLOWED_ROLES.includes(row.role) ? row.role : 'teacher';

        // 1. Invite user
        const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email);
        if (inviteErr) {
          results.failed++;
          results.errors.push({ row, error: inviteErr.message });
          continue;
        }

        const authUserId = inviteData.user.id;

        // 2. Create user_profile
        const { data: profileRow, error: profileErr } = await supabase
          .from('user_profiles')
          .insert({
            auth_user_id: authUserId,
            school_id: req.schoolId,
            role,
            first_name: String(row.first_name).trim(),
            last_name: String(row.last_name).trim(),
            phone: row.phone ? String(row.phone).trim() : null,
          })
          .select()
          .single();

        if (profileErr) {
          await supabase.auth.admin.deleteUser(authUserId);
          results.failed++;
          results.errors.push({ row, error: profileErr.message });
          continue;
        }

        // 3. Create staff row
        const { error: staffErr } = await supabase
          .from('staff')
          .insert({
            school_id: req.schoolId,
            user_profile_id: profileRow.id,
            department: row.department ? String(row.department).trim() : null,
            designation: row.designation ? String(row.designation).trim() : null,
          });

        if (staffErr) {
          await supabase.auth.admin.deleteUser(authUserId);
          await supabase.from('user_profiles').delete().eq('id', profileRow.id);
          results.failed++;
          results.errors.push({ row, error: staffErr.message });
          continue;
        }

        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push({ row, error: err.message });
      }
    }

    res.json({
      message: `Import completed. ${results.success} staff members added, ${results.failed} failed.`,
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
