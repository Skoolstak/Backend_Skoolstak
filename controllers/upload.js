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

  // Validate file size (max 2MB)
  if (buffer.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large. Maximum size is 2MB.' });
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

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('student-photos')
    .getPublicUrl(filePath);

  const photoUrl = urlData.publicUrl;

  // Update student record
  const { error: updateError } = await supabase
    .from('students')
    .update({ photo_url: photoUrl })
    .eq('id', studentId);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to update student record.' });
  }

  res.json({ photo_url: photoUrl, message: 'Photo uploaded successfully.' });
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

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('staff-photos')
    .getPublicUrl(filePath);

  const photoUrl = urlData.publicUrl;

  // Update staff record
  const { error: updateError } = await supabase
    .from('staff')
    .update({ photo_url: photoUrl })
    .eq('id', staffId);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to update staff record.' });
  }

  res.json({ photo_url: photoUrl, message: 'Photo uploaded successfully.' });
};
