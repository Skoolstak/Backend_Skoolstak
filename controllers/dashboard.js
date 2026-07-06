const supabase = require('../supabaseClient');

/* ─ Admin summary ─ */
exports.adminSummary = async (req, res) => {
  const schoolId = req.schoolId;

  const [students, staff, classes, paymentsData, invoicesData] = await Promise.all([
    supabase.from('students').select('*', { count:'exact', head:true }).eq('school_id', schoolId).eq('status','active'),
    supabase.from('staff').select('*', { count:'exact', head:true }).eq('school_id', schoolId),
    supabase.from('classes').select('*', { count:'exact', head:true }).eq('school_id', schoolId),
    supabase.from('fee_payments').select('amount').eq('school_id', schoolId),
    supabase.from('fee_invoices').select('amount').eq('school_id', schoolId),
  ]);

  const fees_collected  = (paymentsData.data || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const total_invoiced  = (invoicesData.data || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const fees_outstanding = Math.max(0, total_invoiced - fees_collected);
  const collection_rate  = total_invoiced > 0 ? Math.round((fees_collected / total_invoiced) * 100) : 0;

  res.json({
    total_students:      students.count,
    total_staff:         staff.count,
    total_classes:       classes.count,
    fees_collected_term: fees_collected,
    fees_outstanding,
    collection_rate,
  });
};

/* ─ Monthly revenue chart (Jan–Dec of current year) ─ */
exports.monthlyRevenue = async (req, res) => {
  const schoolId  = req.schoolId;
  const year      = new Date().getFullYear();
  const startDate = `${year}-01-01`;
  const endDate   = `${year + 1}-01-01`;

  const { data, error } = await supabase
    .from('fee_payments')
    .select('amount, paid_at')
    .eq('school_id', schoolId)
    .gte('paid_at', startDate)
    .lt('paid_at', endDate);

  if (error) return res.status(500).json({ error: error.message });

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const totals  = MONTHS.map(month => ({ month, revenue: 0 }));

  (data || []).forEach(p => {
    const idx = new Date(p.paid_at).getMonth(); // 0-based
    totals[idx].revenue = Math.round(totals[idx].revenue + Number(p.amount || 0));
  });

  res.json({ year, monthly_revenue: totals });
};

/* ─ Teacher summary ─ */
exports.teacherSummary = async (req, res) => {
  const schoolId        = req.schoolId;
  const teacherProfileId = req.profile?.id;  // classes.teacher_id references user_profiles.id
  const dayNames   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayName  = dayNames[new Date().getDay()];
  const today      = new Date().toISOString().split('T')[0];

  // Classes assigned to this teacher
  const { data: classes } = await supabase.from('classes').select('id, name').eq('school_id', schoolId).eq('teacher_id', teacherProfileId);
  const classIds = (classes || []).map(c => c.id);

  let student_count = 0;
  if (classIds.length > 0) {
    const { count } = await supabase.from('students').select('*', { count:'exact', head:true }).in('class_id', classIds).eq('status','active');
    student_count = count || 0;
  }

  // Today's slots for this teacher
  const { data: today_slots } = await supabase.from('timetable_slots').select('subject, classes(name)')
    .eq('school_id', schoolId)
    .eq('teacher_id', teacherProfileId)
    .eq('day', todayName);

  const slots = (today_slots || []).map(s => ({ ...s, subject_name: s.subject, class_name: s.classes?.name }));

  // Attendance done today for each class
  const pendingAtt = [];
  for (const cls of (classes || [])) {
    const { count } = await supabase.from('attendance').select('*', { count:'exact', head:true }).eq('school_id', schoolId).eq('class_id', cls.id).eq('date', today);
    if (!count) pendingAtt.push(cls);
  }

  res.json({
    class_count:         (classes||[]).length,
    student_count,
    attendance_done_today: pendingAtt.length === 0 && (classes||[]).length > 0,
    today_slots:         slots,
    pending_attendance:  pendingAtt,
    next_period:         slots[0]?.subject || '—',
  });
};

/* ─ Student summary ─ */
exports.studentSummary = async (req, res) => {
  const schoolId  = req.schoolId;
  const profileId = req.profile?.id;

  const { data: student } = await supabase.from('students').select('id, first_name, last_name, class_id').eq('school_id', schoolId).eq('user_profile_id', profileId).single();
  if (!student) return res.json({});

  const today     = new Date().toISOString().split('T')[0];
  const dayNames  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayName = dayNames[new Date().getDay()];

  const [attData, invoices, loans, slots] = await Promise.all([
    supabase.from('attendance').select('status').eq('school_id', schoolId).eq('student_id', student.id),
    supabase.from('fee_invoices').select('amount, amount_paid').eq('school_id', schoolId).eq('student_id', student.id),
    supabase.from('book_loans').select('*', { count:'exact', head:true }).eq('school_id', schoolId).eq('student_id', student.id).is('returned_at', null),
    supabase.from('timetable_slots').select('subject, user_profiles!teacher_id(first_name,last_name)').eq('school_id', schoolId).eq('class_id', student.class_id).eq('day', todayName),
  ]);

  const total   = attData.data?.length || 0;
  const present = attData.data?.filter(r=>r.status==='present').length || 0;
  const outstanding_fees = (invoices.data||[]).reduce((s,i)=>s+Math.max(0,Number(i.amount)-Number(i.amount_paid||0)),0);

  const recent_invoices = (invoices.data||[]).slice(0,4).map(i=>({
    fee_type_name: 'Fee',
    balance: Math.max(0,Number(i.amount)-Number(i.amount_paid||0)),
  }));

  const today_slots = (slots.data||[]).map(s=>({ ...s, subject_name: s.subject, teacher_name: s.user_profiles?`${s.user_profiles.first_name} ${s.user_profiles.last_name}`:null }));

  res.json({
    name:            `${student.first_name} ${student.last_name}`,
    attendance_rate: total>0 ? Math.round((present/total)*100) : 0,
    outstanding_fees,
    books_on_loan:   loans.count || 0,
    today_slots,
    recent_invoices,
    next_period: today_slots[0]?.subject || '—',
  });
};

/* ─ Parent summary ─ */
exports.parentSummary = async (req, res) => {
  const schoolId  = req.schoolId;
  const profileId = req.profile?.id;

  const { data: student } = await supabase.from('students').select('id, first_name, last_name, class_id, classes(name)').eq('school_id', schoolId).eq('parent_id', profileId).single();
  if (!student) return res.json({ child_name: 'your child' });

  const [attData, invoicesRes, loansCount] = await Promise.all([
    supabase.from('attendance').select('date,status').eq('school_id', schoolId).eq('student_id', student.id).order('date', {ascending:false}).limit(10),
    supabase.from('fee_invoices').select('amount, amount_paid, fee_types(name)').eq('school_id', schoolId).eq('student_id', student.id).limit(20),
    supabase.from('book_loans').select('*', { count:'exact', head:true }).eq('school_id', schoolId).eq('student_id', student.id).is('returned_at', null),
  ]);

  const allAtt = attData.data || [];
  const present = allAtt.filter(r=>r.status==='present').length;
  const attendance_rate = allAtt.length > 0 ? Math.round((present/allAtt.length)*100) : 0;

  const invs = invoicesRes.data || [];
  const outstanding_fees = invs.reduce((s,i)=>s+Math.max(0,Number(i.amount)-Number(i.amount_paid||0)),0);
  const recent_invoices  = invs.slice(0,4).map(i=>({ fee_type_name: i.fee_types?.name||'Fee', balance: Math.max(0,Number(i.amount)-Number(i.amount_paid||0)) }));

  res.json({
    child_name:        `${student.first_name} ${student.last_name}`,
    class_name:        student.classes?.name || '—',
    attendance_rate,
    outstanding_fees,
    books_on_loan:     loansCount.count || 0,
    recent_attendance: allAtt,
    recent_invoices,
  });
};
