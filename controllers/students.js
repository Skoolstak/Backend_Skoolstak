const supabase = require('../supabaseClient');
const crypto = require('crypto');
const { pickFields, isValidUUID } = require('../middleware/sanitize');
const { resolvePhotoUrls } = require('../utils/photoUrls');

const STUDENT_FIELDS = ['first_name', 'last_name', 'dob', 'class_id', 'parent_id', 'photo_url', 'status'];
const VALID_STATUSES = ['active', 'graduated', 'withdrawn'];

// Creates a parent login account and returns its user_profile id, or null.
async function ensureParentProfile(schoolId, { parent_email, parent_first_name, parent_last_name, parent_phone }) {
  if (!parent_email) return null;
  const email = String(parent_email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Parent email is invalid.');
  }

  const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existingAuth = (authList?.users || []).find(u => u.email === email);

  let authUserId;
  const initialPassword = crypto.randomBytes(5).toString('hex'); // 10-char initial password
  if (existingAuth) {
    authUserId = existingAuth.id;
  } else {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password: initialPassword, email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    authUserId = authData.user.id;
  }

  const { data: profileByAuth } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (profileByAuth) return { id: profileByAuth.id, email, initialPassword: existingAuth ? null : initialPassword };

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .insert({
      auth_user_id: authUserId,
      school_id:    schoolId,
      role:         'parent',
      first_name:   parent_first_name || 'Parent',
      last_name:    parent_last_name  || '',
      phone:        parent_phone || null,
    })
    .select()
    .single();
  if (profileError) throw new Error(profileError.message);

  return { id: profile.id, email, initialPassword: existingAuth ? null : initialPassword };
}

exports.list = async (req, res) => {
  const schoolId = req.schoolId;
  const { search, class_id, status } = req.query;

  let query = supabase
    .from('students')
    .select('id, student_id, first_name, last_name, dob, photo_url, class_id, parent_id, status, classes(name)')
    .eq('school_id', schoolId)
    .order('last_name');

  if (search) {
    const safe = search.replace(/[%_\\]/g, '\\$&').slice(0, 100);
    query = query.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
  }
  if (class_id) query = query.eq('class_id', class_id);
  if (status)   query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const students = (await resolvePhotoUrls(supabase, 'student-photos', data || [])).map(s => ({
    ...s,
    class_name: s.classes?.name || null,
    classes:    undefined,
  }));

  res.json({ students });
};

exports.create = async (req, res) => {
  const fields = pickFields(req.body, STUDENT_FIELDS);
  const { parent_email, parent_first_name, parent_last_name, parent_phone } = req.body;
  if (!fields.first_name || !fields.last_name) {
    return res.status(400).json({ error: 'first_name and last_name are required.' });
  }
  if (fields.status && !VALID_STATUSES.includes(fields.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
  }
  if (!fields.class_id)  fields.class_id  = null;
  if (!fields.parent_id) fields.parent_id = null;

  // Create/link parent account first if an email was provided
  let parentInfo = null;
  if (parent_email && !fields.parent_id) {
    try {
      parentInfo = await ensureParentProfile(req.schoolId, { parent_email, parent_first_name, parent_last_name, parent_phone });
      fields.parent_id = parentInfo.id;
    } catch (e) {
      return res.status(400).json({ error: `Parent account: ${e.message}` });
    }
  }

  // 1. Create student record first to get student_id
  // Retry once on student_id unique collision (trigger generates a fresh ID)
  async function insertStudent() {
    return supabase
      .from('students')
      .insert({ ...fields, school_id: req.schoolId })
      .select()
      .single();
  }
  let { data: studentData, error } = await insertStudent();
  if (error && /students_student_id_key/.test(error.message || '')) {
    ({ data: studentData, error } = await insertStudent());
  }
  if (error) return res.status(400).json({ error: error.message });

  // 2. Provision the student's login account (reuses an existing one if present)
  const studentId = studentData.student_id; // e.g., STU-2026-001
  const tempEmail = `${studentId.toLowerCase()}@student.local`;

  let authUserId;
  const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existingAuth = (authList?.users || []).find(u => u.email === tempEmail);

  if (existingAuth) {
    authUserId = existingAuth.id;
  } else {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: tempEmail,
      password: studentId, // initial password = student ID
      email_confirm: true,
    });
    if (authError) {
      return res.status(201).json({
        student: studentData,
        warning: 'Student created but login account setup failed. Contact administrator.',
      });
    }
    authUserId = authData.user.id;
  }

  // 3. Reuse or create the user_profile for this auth account
  let profileId;
  const { data: existingProfile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (existingProfile) {
    profileId = existingProfile.id;
  } else {
    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        auth_user_id: authUserId,
        school_id: req.schoolId,
        role: 'student',
        first_name: fields.first_name,
        last_name: fields.last_name,
      })
      .select()
      .single();

    if (profileError) {
      return res.status(201).json({
        student: studentData,
        warning: 'Student created but login profile setup failed. Contact administrator.',
      });
    }
    profileId = profileData.id;
  }

  // 4. Link student to user_profile
  const { error: updateError } = await supabase
    .from('students')
    .update({ user_profile_id: profileId })
    .eq('id', studentData.id);

  if (updateError) {
    console.warn('Failed to link student to user_profile:', updateError.message);
  }

  res.status(201).json({
    student: { ...studentData, user_profile_id: profileId },
    message: `Student enrolled successfully. Login ID: ${studentId}, Initial Password: ${studentId}`,
    parent: parentInfo ? { email: parentInfo.email, initial_password: parentInfo.initialPassword } : null,
  });
};

exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const fields = pickFields(req.body, STUDENT_FIELDS);
  if (fields.status && !VALID_STATUSES.includes(fields.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
  }
  if (!fields.class_id)  fields.class_id  = null;
  if (!fields.parent_id) fields.parent_id = null;
  const { data, error } = await supabase
    .from('students')
    .update(fields)
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ student: data });
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  // Fetch linked profile/auth before deleting so we can clean them up
  const { data: studentRow } = await supabase
    .from('students')
    .select('id, user_profile_id')
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .maybeSingle();
  if (!studentRow) return res.status(404).json({ error: 'Student not found.' });

  const { error } = await supabase
    .from('students')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });

  await cleanupStudentProfile(studentRow.user_profile_id);

  res.json({ success: true });
};

/** Best-effort cleanup of a student's user_profile + auth user. */
async function cleanupStudentProfile(userProfileId) {
  if (!userProfileId) return;
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, auth_user_id')
      .eq('id', userProfileId)
      .maybeSingle();
    if (!profile) return;

    await supabase.from('user_profiles').delete().eq('id', profile.id);
    if (profile.auth_user_id) {
      await supabase.auth.admin.deleteUser(profile.auth_user_id);
    }
  } catch (e) {
    console.warn('Student profile cleanup failed:', e.message);
  }
}

/**
 * POST /api/students/bulk-delete
 * Delete multiple students in one request. Body: { ids: string[] }
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

  // Collect linked profiles before deleting
  const { data: rows } = await supabase
    .from('students')
    .select('id, user_profile_id')
    .in('id', ids)
    .eq('school_id', req.schoolId);

  const { error, count } = await supabase
    .from('students')
    .delete({ count: 'exact' })
    .in('id', ids)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });

  for (const row of rows || []) {
    await cleanupStudentProfile(row.user_profile_id);
  }

  res.json({ success: true, deleted: count ?? (rows || []).length });
};

/**
 * POST /api/students/import-excel
 * Bulk import students from Excel file
 * Expects base64 encoded Excel file in req.body.file
 * Install: npm install xlsx
 */
exports.importExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { file, class_id } = req.body;

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

    // Expected columns: first_name, last_name, dob (optional)
    for (const row of data) {
      try {
        if (!row.first_name || !row.last_name) {
          results.failed++;
          results.errors.push({ row, error: 'Missing first_name or last_name' });
          continue;
        }

        const studentData = {
          school_id: req.schoolId,
          first_name: String(row.first_name).trim(),
          last_name: String(row.last_name).trim(),
          dob: row.dob ? new Date(row.dob).toISOString().split('T')[0] : null,
          class_id: class_id || null,
          status: 'active',
        };

        // 1. Create student record (retry once on student_id unique collision)
        const insertStudentRow = () => supabase
          .from('students')
          .insert(studentData)
          .select()
          .single();

        let { data: student, error } = await insertStudentRow();
        if (error && /students_student_id_key/.test(error.message || '')) {
          ({ data: student, error } = await insertStudentRow());
        }

        if (error) {
          results.failed++;
          results.errors.push({ row, error: error.message });
          continue;
        }

        // 2. Create auth account for student
        const studentId = student.student_id;
        const tempEmail = `${studentId.toLowerCase()}@student.local`;
        const initialPassword = studentId;

        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
          email: tempEmail,
          password: initialPassword,
          email_confirm: true,
        });

        if (authError) {
          // Student created but auth failed - log and continue
          console.warn(`Auth creation failed for ${studentId}:`, authError.message);
          results.success++;
          continue;
        }

        // 3. Create user_profile
        const { data: profileData, error: profileError } = await supabase
          .from('user_profiles')
          .insert({
            auth_user_id: authData.user.id,
            school_id: req.schoolId,
            role: 'student',
            first_name: studentData.first_name,
            last_name: studentData.last_name,
          })
          .select()
          .single();

        if (profileError) {
          await supabase.auth.admin.deleteUser(authData.user.id);
          console.warn(`Profile creation failed for ${studentId}:`, profileError.message);
          results.success++;
          continue;
        }

        // 4. Link student to user_profile
        await supabase
          .from('students')
          .update({ user_profile_id: profileData.id })
          .eq('id', student.id);

        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push({ row, error: err.message });
      }
    }

    res.json({
      message: `Import completed. ${results.success} students added, ${results.failed} failed.`,
      ...results,
    });
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ 
        error: 'Excel library not installed. Run: npm install xlsx' 
      });
    }
    console.error('Excel import error:', err);
    res.status(500).json({ error: 'Failed to process Excel file.' });
  }
};
