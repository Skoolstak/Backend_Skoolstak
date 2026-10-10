'use strict';
const supabase = require('../supabaseClient');

/**
 * Which students the caller is allowed to see.
 *   - student: only themselves
 *   - parent:  only their own children
 *   - anyone else (school admin, teacher, super admin): null, meaning no restriction
 * Returns an array of student ids (possibly empty) for restricted roles. Cached on the request.
 */
async function allowedStudentIds(req) {
  if (req._allowedStudentIds !== undefined) return req._allowedStudentIds;

  let ids = null;
  if (req.role === 'student' || req.role === 'parent') {
    const column = req.role === 'student' ? 'user_profile_id' : 'parent_id';
    const { data } = await supabase
      .from('students')
      .select('id')
      .eq('school_id', req.schoolId)
      .eq(column, req.profile?.id);
    ids = (data || []).map((s) => s.id);
  }
  req._allowedStudentIds = ids;
  return ids;
}

/**
 * The classes a teacher works with: classes they are class teacher of, plus classes where they
 * are assigned a subject or have a timetable slot. Returns an array of class ids.
 */
async function teacherClassIds(req) {
  if (req._teacherClassIds) return req._teacherClassIds;
  const profileId = req.profile?.id;
  const ids = new Set();

  const sources = [
    supabase.from('classes').select('id').eq('school_id', req.schoolId).eq('teacher_id', profileId),
    supabase.from('subjects').select('class_id').eq('school_id', req.schoolId).eq('teacher_id', profileId),
    supabase.from('timetable_slots').select('class_id').eq('school_id', req.schoolId).eq('teacher_id', profileId),
  ];
  const results = await Promise.all(sources);
  results.forEach((r, i) => {
    for (const row of r.data || []) {
      const id = i === 0 ? row.id : row.class_id;
      if (id) ids.add(id);
    }
  });

  req._teacherClassIds = [...ids];
  return req._teacherClassIds;
}

/**
 * The parent's children, oldest record first. `req.query.student_id` picks one of them;
 * an id that isn't theirs is ignored, so a parent can never select someone else's child.
 */
async function parentChildren(req, select = 'id, class_id, first_name, last_name') {
  const { data } = await supabase
    .from('students')
    .select(select)
    .eq('school_id', req.schoolId)
    .eq('parent_id', req.profile?.id)
    .order('created_at', { ascending: true });
  return data || [];
}

async function pickChild(req, select) {
  const children = await parentChildren(req, select);
  const wanted = req.query?.student_id;
  return children.find((c) => c.id === wanted) || children[0] || null;
}

module.exports = { allowedStudentIds, teacherClassIds, parentChildren, pickChild };
