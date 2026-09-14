'use strict';
const supabase = require('../supabaseClient'); // service-role client
const { isValidUUID } = require('../middleware/sanitize');
const { resolvePhotoUrls } = require('../utils/photoUrls');
const crypto = require('crypto');

const ALLOWED_ROLES = ['teacher', 'school_admin'];

function resolveAuthEmail(email, role) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return normalizedEmail;
  return role === 'teacher' ? `teacher-${crypto.randomUUID()}@teacher.local` : null;
}

exports.list = async (req, res) => {
  const { data, error } = await supabase
    .from('staff')
    .select('id, staff_id, photo_url, department, designation, user_profiles!user_profile_id(id, first_name, last_name, role, phone)')
    .eq('school_id', req.schoolId);

  if (error) return res.status(500).json({ error: error.message });

  const staff = (await resolvePhotoUrls(supabase, 'staff-photos', data || [])).map(s => ({
      id:              s.id,
      staff_id:        s.staff_id || '',
      photo_url:       s.photo_url,
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
  const authEmail = resolveAuthEmail(email, role);

  if (!first_name || !last_name || !authEmail) {
    return res.status(400).json({ error: 'first_name and last_name are required. Email is required for school administrators.' });
  }
  // Basic email validation - allow most formats
  if (!/^[^\s@]+@[^\s@]+$/.test(authEmail)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ALLOWED_ROLES.join(', ')}.` });
  }

  // 1. Create the teacher profile after obtaining a staff ID for the initial password.
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: authEmail,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (authError) {
    const msg = authError.message?.toLowerCase().includes('already registered')
      ? 'A user with that email already exists.'
      : authError.message;
    return res.status(400).json({ error: msg });
  }

  const authUserId = authData.user.id;

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
  // Retry once on staff_id unique collision (trigger generates a fresh ID)
  async function insertStaff() {
    return supabase
      .from('staff')
      .insert({ school_id: req.schoolId, user_profile_id: profileRow.id, department: department || null, designation: designation || null })
      .select()
      .single();
  }
  let { data: staffRow, error: staffErr } = await insertStaff();
  if (staffErr && /staff_staff_id_key/.test(staffErr.message || '')) {
    ({ data: staffRow, error: staffErr } = await insertStaff());
  }

  if (staffErr) {
    await supabase.auth.admin.deleteUser(authUserId);
    await supabase.from('user_profiles').delete().eq('id', profileRow.id);
    return res.status(400).json({ error: staffErr.message });
  }

  const { error: passwordError } = await supabase.auth.admin.updateUserById(authUserId, {
    password: staffRow.staff_id,
  });
  if (passwordError) {
    await supabase.from('staff').delete().eq('id', staffRow.id);
    await supabase.auth.admin.deleteUser(authUserId);
    return res.status(500).json({ error: 'Unable to set the teacher login password.' });
  }

  res.status(201).json({
    staff: { id: staffRow.id, staff_id: staffRow.staff_id, user_profile_id: profileRow.id, first_name, last_name, role, phone, department: staffRow.department, designation: staffRow.designation },
    message: `Teacher created. Login ID and initial password: ${staffRow.staff_id}`,
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

exports.resetLogin = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  const { data: staffRow, error: staffError } = await supabase
    .from('staff')
    .select('staff_id, user_profiles!user_profile_id(auth_user_id, role)')
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .single();

  if (staffError || !staffRow) return res.status(404).json({ error: 'Staff member not found.' });
  if (staffRow.user_profiles?.role !== 'teacher' || !staffRow.staff_id) {
    return res.status(400).json({ error: 'Only teachers with a staff ID can use this login reset.' });
  }

  const { error } = await supabase.auth.admin.updateUserById(staffRow.user_profiles.auth_user_id, {
    password: staffRow.staff_id,
    email_confirm: true,
  });
  if (error) return res.status(500).json({ error: 'Unable to reset the teacher login password.' });

  res.json({ message: `Login reset. Initial password: ${staffRow.staff_id}` });
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  // DB trigger trg_staff_delete_cleanup removes the linked
  // user_profiles row and auth.users row automatically.
  const { error, count } = await supabase
    .from('staff')
    .delete({ count: 'exact' })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: 'Staff member not found.' });

  res.json({ success: true });
};

/**
 * POST /api/staff/bulk-delete
 * Delete multiple staff members in one request. Body: { ids: string[] }
 * DB trigger cleans up each member's user_profile + auth user.
 */
exports.bulkRemove = async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array.' });
  }
  if (ids.length > 1000) {
    return res.status(400).json({ error: 'Cannot delete more than 1000 records at once.' });
  }
  if (!ids.every(isValidUUID)) {
    return res.status(400).json({ error: 'All ids must be valid UUIDs.' });
  }

  const { error, count } = await supabase
    .from('staff')
    .delete({ count: 'exact' })
    .in('id', ids)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });

  res.json({ success: true, deleted: count ?? 0 });
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
      const matches = file.match(/^data:([^;,]+);base64,(.+)$/);
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

        // 1. Create the account with a temporary password until the generated staff ID is available.
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
          email,
          password: crypto.randomUUID(),
          email_confirm: true,
        });
        if (authError) {
          results.failed++;
          results.errors.push({ row, error: authError.message });
          continue;
        }

        const authUserId = authData.user.id;

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

        // 3. Create staff row (retry once on staff_id unique collision)
        const staffInsert = () => supabase
          .from('staff')
          .insert({
            school_id: req.schoolId,
            user_profile_id: profileRow.id,
            department: row.department ? String(row.department).trim() : null,
            designation: row.designation ? String(row.designation).trim() : null,
          })
          .select()
          .single();

        let { data: staffRow, error: staffErr } = await staffInsert();
        if (staffErr && /staff_staff_id_key/.test(staffErr.message || '')) {
          ({ data: staffRow, error: staffErr } = await staffInsert());
        }

        if (staffErr) {
          await supabase.auth.admin.deleteUser(authUserId);
          await supabase.from('user_profiles').delete().eq('id', profileRow.id);
          results.failed++;
          results.errors.push({ row, error: staffErr.message });
          continue;
        }

        const { error: passwordError } = await supabase.auth.admin.updateUserById(authUserId, {
          password: staffRow.staff_id,
        });
        if (passwordError) {
          await supabase.from('staff').delete().eq('id', staffRow.id);
          await supabase.auth.admin.deleteUser(authUserId);
          results.failed++;
          results.errors.push({ row, error: 'Unable to set the teacher login password.' });
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
