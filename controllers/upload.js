const supabase = require('../supabaseClient');
const crypto = require('crypto');

/**
 * POST /api/upload/student-photo/:studentId
 * Upload student photo to Supabase Storage
 */
exports.uploadStudentPhoto = async (req, res) => {
  const { studentId } = req.params;
  const schoolId = req.schoolId;

  // Verify student belongs to school
  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id, student_id')
    .eq('id', studentId)
    .eq('school_id', schoolId)
    .single();

  if (studentError || !student) {
    return res.status(404).json({ error: 'Student not found.' });
  }

  // Get file from request body (base64 or buffer)
  const { file, fileName, contentType } = req.body;

  if (!file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  // Convert base64 to buffer if needed
  let buffer;
  if (typeof file === 'string' && file.startsWith('data:')) {
    // Extract base64 data
    const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid base64 format.' });
    }
    buffer = Buffer.from(matches[2], 'base64');
  } else if (Buffer.isBuffer(file)) {
    buffer = file;
  } else {
    return res.status(400).json({ error: 'Invalid file format.' });
  }

  // Validate file size (max 5MB)
  if (buffer.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
  }

  // Generate unique filename
  const ext = contentType?.split('/')[1] || fileName?.split('.').pop() || 'jpg';
  const uniqueName = `${student.student_id}-${Date.now()}.${ext}`;
  const filePath = `${schoolId}/${uniqueName}`;

  // Upload to Supabase Storage
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('student-photos')
    .upload(filePath, buffer, {
      contentType: contentType || 'image/jpeg',
      upsert: true,
    });

  if (uploadError) {
    console.error('Upload error:', uploadError);
    return res.status(500).json({ error: 'Failed to upload photo.' });
  }

  // Update student record
  const { error: updateError } = await supabase
    .from('students')
    .update({ photo_url: filePath })
    .eq('id', studentId);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to update student record.' });
  }

  res.json({ photo_path: filePath, message: 'Photo uploaded successfully.' });
};

/**
 * POST /api/upload/staff-photo/:staffId
 * Upload staff/teacher photo to Supabase Storage
 */
exports.uploadStaffPhoto = async (req, res) => {
  const { staffId } = req.params;
  const schoolId = req.schoolId;

  // Verify staff belongs to school
  const { data: staff, error: staffError } = await supabase
    .from('staff')
    .select('id, staff_id')
    .eq('id', staffId)
    .eq('school_id', schoolId)
    .single();

  if (staffError || !staff) {
    return res.status(404).json({ error: 'Staff member not found.' });
  }

  // Get file from request body (base64 or buffer)
  const { file, fileName, contentType } = req.body;

  if (!file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  // Convert base64 to buffer if needed
  let buffer;
  if (typeof file === 'string' && file.startsWith('data:')) {
    // Extract base64 data
    const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid base64 format.' });
    }
    buffer = Buffer.from(matches[2], 'base64');
  } else if (Buffer.isBuffer(file)) {
    buffer = file;
  } else {
    return res.status(400).json({ error: 'Invalid file format.' });
  }

  // Validate file size (max 2MB)
  if (buffer.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large. Maximum size is 2MB.' });
  }

  // Generate unique filename
  const ext = contentType?.split('/')[1] || fileName?.split('.').pop() || 'jpg';
  const uniqueName = `${staff.staff_id}-${Date.now()}.${ext}`;
  const filePath = `${schoolId}/${uniqueName}`;

  // Upload to Supabase Storage
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('staff-photos')
    .upload(filePath, buffer, {
      contentType: contentType || 'image/jpeg',
      upsert: true,
    });

  if (uploadError) {
    console.error('Upload error:', uploadError);
    return res.status(500).json({ error: 'Failed to upload photo.' });
  }

  // Update staff record
  const { error: updateError } = await supabase
    .from('staff')
    .update({ photo_url: filePath })
    .eq('id', staffId);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to update staff record.' });
  }

  res.json({ photo_path: filePath, message: 'Photo uploaded successfully.' });
};

/**
 * POST /api/upload/receipt/:invoiceId
 * Upload a payment receipt and return its private storage path.
 */
exports.uploadReceipt = async (req, res) => {
  const { invoiceId } = req.params;
  const { file, fileName, contentType } = req.body;

  const { data: invoice, error: invoiceError } = await supabase
    .from('fee_invoices')
    .select('id')
    .eq('id', invoiceId)
    .eq('school_id', req.schoolId)
    .single();
  if (invoiceError || !invoice) return res.status(404).json({ error: 'Invoice not found.' });

  if (typeof file !== 'string' || !file.startsWith('data:')) {
    return res.status(400).json({ error: 'A base64-encoded receipt file is required.' });
  }

  const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return res.status(400).json({ error: 'Invalid base64 format.' });

  const buffer = Buffer.from(matches[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const resolvedContentType = contentType || matches[1];
  if (!allowedTypes.includes(resolvedContentType)) {
    return res.status(400).json({ error: 'Receipt must be a JPG, PNG, WEBP, or PDF file.' });
  }

  const ext = fileName?.split('.').pop() || resolvedContentType.split('/')[1];
  const filePath = `${req.schoolId}/${invoiceId}-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(filePath, buffer, { contentType: resolvedContentType, upsert: false });
  if (uploadError) return res.status(500).json({ error: 'Failed to upload receipt.' });

  res.status(201).json({ path: filePath });
};
