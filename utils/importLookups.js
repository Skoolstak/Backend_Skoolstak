'use strict';
const crypto = require('crypto');
const supabase = require('../supabaseClient');
const { normName, splitFullName } = require('./excel');

/**
 * "Find or create" resolvers used by the Excel imports, so a class or teacher
 * named in one import that does not exist yet is created instead of failing the row.
 *
 * Matching is by exact name (ignoring case and extra spaces) or by id. A name that matches
 * more than one record is never guessed. Everything created is pushed onto `autoCreated`
 * so the import result can tell the admin exactly what was added.
 *
 * Each resolver returns { id } or { error } (a user-facing message).
 */

async function createClassResolver(schoolId, autoCreated) {
  const { data, error } = await supabase
    .from('classes')
    .select('id, name')
    .eq('school_id', schoolId);
  if (error) throw new Error(error.message);

  const ids = new Set(data.map((c) => c.id));
  const byName = new Map();
  for (const c of data) {
    const key = normName(c.name);
    byName.set(key, byName.has(key) ? 'ambiguous' : c.id);
  }

  return async (raw) => {
    const value = String(raw).trim();
    if (ids.has(value)) return { id: value };

    const key = normName(value);
    const found = byName.get(key);
    if (found === 'ambiguous') {
      return { error: `More than one class is named "${value}". Rename or delete the duplicate in Classes, then import again.` };
    }
    if (found) return { id: found };

    const name = value.replace(/\s+/g, ' ');
    const { data: created, error: createErr } = await supabase
      .from('classes')
      .insert({ school_id: schoolId, name, level: name, capacity: null, teacher_id: null }) // level is required, so it defaults to the class name
      .select('id')
      .single();
    if (createErr) return { error: `Class "${value}" was not found and could not be created: ${createErr.message}` };

    ids.add(created.id);
    byName.set(key, created.id);
    autoCreated.push({ type: 'class', name });
    return { id: created.id };
  };
}

// Creates the login account, profile and staff record for a teacher, undoing partial work on failure.
async function createTeacherAccount(schoolId, firstName, lastName) {
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: `teacher-${crypto.randomUUID()}@teacher.local`,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (authError) return { error: authError.message };
  const authUserId = authData.user.id;

  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .insert({ auth_user_id: authUserId, school_id: schoolId, role: 'teacher', first_name: firstName, last_name: lastName })
    .select('id')
    .single();
  if (profileErr) {
    await supabase.auth.admin.deleteUser(authUserId);
    return { error: profileErr.message };
  }

  const insertStaff = () => supabase
    .from('staff')
    .insert({ school_id: schoolId, user_profile_id: profile.id })
    .select('id, staff_id')
    .single();
  let { data: staffRow, error: staffErr } = await insertStaff();
  if (staffErr && /staff_staff_id_key/.test(staffErr.message || '')) {
    ({ data: staffRow, error: staffErr } = await insertStaff());
  }
  if (staffErr) {
    await supabase.auth.admin.deleteUser(authUserId);
    await supabase.from('user_profiles').delete().eq('id', profile.id);
    return { error: staffErr.message };
  }

  const { error: passwordErr } = await supabase.auth.admin.updateUserById(authUserId, { password: staffRow.staff_id });
  if (passwordErr) {
    await supabase.from('staff').delete().eq('id', staffRow.id);
    await supabase.auth.admin.deleteUser(authUserId);
    await supabase.from('user_profiles').delete().eq('id', profile.id);
    return { error: 'Unable to set the teacher login password.' };
  }

  return { profileId: profile.id, loginId: staffRow.staff_id };
}

async function createTeacherResolver(schoolId, autoCreated) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name')
    .eq('school_id', schoolId)
    .eq('role', 'teacher');
  if (error) throw new Error(error.message);

  const ids = new Set(data.map((t) => t.id));
  const byName = new Map();
  for (const t of data) {
    const key = normName(`${t.first_name || ''} ${t.last_name || ''}`);
    byName.set(key, byName.has(key) ? 'ambiguous' : t.id);
  }

  return async (raw) => {
    const value = String(raw).trim();
    if (ids.has(value)) return { id: value };

    const key = normName(value);
    const found = byName.get(key);
    if (found === 'ambiguous') return { error: `Teacher "${value}" matches more than one teacher.` };
    if (found) return { id: found };

    const { first, last } = splitFullName(value);
    if (!first || !last) {
      return { error: `Teacher "${value}" was not found. Use their first and last name so they can be added to Staff automatically.` };
    }

    const created = await createTeacherAccount(schoolId, first, last);
    if (created.error) return { error: `Teacher "${value}" was not found and could not be created: ${created.error}` };

    ids.add(created.profileId);
    byName.set(key, created.profileId);
    autoCreated.push({ type: 'teacher', name: `${first} ${last}`, login_id: created.loginId });
    return { id: created.profileId };
  };
}

module.exports = { createClassResolver, createTeacherResolver };
