require('dotenv').config();
const supabase = require('./supabaseClient');

async function checkDatabaseSync() {
  console.log('🔍 Checking Backend-Database Sync...\n');
  
  const checks = [];
  
  // 1. Check students table columns
  console.log('1️⃣ Checking students table...');
  const studentsCheck = await supabase
    .from('students')
    .select('id, student_id, photo_url, user_profile_id')
    .limit(1);
  
  if (studentsCheck.error) {
    console.log('   ❌ ERROR:', studentsCheck.error.message);
    checks.push({ name: 'students table', status: 'FAIL', error: studentsCheck.error.message });
  } else {
    console.log('   ✅ students table has student_id, photo_url, user_profile_id columns');
    checks.push({ name: 'students table', status: 'PASS' });
  }
  
  // 2. Check staff table columns
  console.log('\n2️⃣ Checking staff table...');
  const staffCheck = await supabase
    .from('staff')
    .select('id, staff_id, photo_url')
    .limit(1);
  
  if (staffCheck.error) {
    console.log('   ❌ ERROR:', staffCheck.error.message);
    checks.push({ name: 'staff table', status: 'FAIL', error: staffCheck.error.message });
  } else {
    console.log('   ✅ staff table has staff_id, photo_url columns');
    checks.push({ name: 'staff table', status: 'PASS' });
  }
  
  // 3. Check user_profiles table columns
  console.log('\n3️⃣ Checking user_profiles table...');
  const userProfilesCheck = await supabase
    .from('user_profiles')
    .select('id, reset_token, reset_token_expires')
    .limit(1);
  
  if (userProfilesCheck.error) {
    console.log('   ❌ ERROR:', userProfilesCheck.error.message);
    checks.push({ name: 'user_profiles table', status: 'FAIL', error: userProfilesCheck.error.message });
  } else {
    console.log('   ✅ user_profiles table has reset_token columns');
    checks.push({ name: 'user_profiles table', status: 'PASS' });
  }
  
  // 4. Check storage buckets
  console.log('\n4️⃣ Checking Supabase Storage buckets...');
  const { data: buckets, error: bucketsError } = await supabase
    .storage
    .listBuckets();
  
  if (bucketsError) {
    console.log('   ❌ ERROR:', bucketsError.message);
    checks.push({ name: 'storage buckets', status: 'FAIL', error: bucketsError.message });
  } else {
    const bucketNames = buckets.map(b => b.name);
    const hasStudentPhotos = bucketNames.includes('student-photos');
    const hasStaffPhotos = bucketNames.includes('staff-photos');
    
    console.log('   Available buckets:', bucketNames.join(', '));
    
    if (hasStudentPhotos && hasStaffPhotos) {
      console.log('   ✅ Both student-photos and staff-photos buckets exist');
      checks.push({ name: 'storage buckets', status: 'PASS' });
    } else {
      console.log('   ⚠️  Missing buckets:');
      if (!hasStudentPhotos) console.log('      - student-photos (REQUIRED)');
      if (!hasStaffPhotos) console.log('      - staff-photos (REQUIRED)');
      checks.push({ 
        name: 'storage buckets', 
        status: 'WARN', 
        message: 'Photo upload buckets missing - create manually in Supabase Dashboard'
      });
    }
  }
  
  // 5. Test authentication (service role)
  console.log('\n5️⃣ Testing authentication with service role...');
  try {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1 });
    if (error) {
      console.log('   ❌ ERROR:', error.message);
      checks.push({ name: 'auth service', status: 'FAIL', error: error.message });
    } else {
      console.log('   ✅ Service role authentication working');
      checks.push({ name: 'auth service', status: 'PASS' });
    }
  } catch (e) {
    console.log('   ❌ ERROR:', e.message);
    checks.push({ name: 'auth service', status: 'FAIL', error: e.message });
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SYNC CHECK SUMMARY');
  console.log('='.repeat(60));
  
  const passed = checks.filter(c => c.status === 'PASS').length;
  const failed = checks.filter(c => c.status === 'FAIL').length;
  const warnings = checks.filter(c => c.status === 'WARN').length;
  
  checks.forEach(check => {
    const icon = check.status === 'PASS' ? '✅' : check.status === 'FAIL' ? '❌' : '⚠️';
    console.log(`${icon} ${check.name.padEnd(30)} ${check.status}`);
    if (check.error) console.log(`   └─ ${check.error}`);
    if (check.message) console.log(`   └─ ${check.message}`);
  });
  
  console.log('\n' + '='.repeat(60));
  
  if (failed > 0) {
    console.log('❌ CRITICAL: Database migration required!');
    console.log('   Run migration 006 using Supabase CLI or Dashboard\n');
    process.exit(1);
  } else if (warnings > 0) {
    console.log('⚠️  WARNING: Some features may not work (see above)');
    console.log('   Photo uploads require storage buckets\n');
    process.exit(0);
  } else {
    console.log('✅ All checks passed! Backend-Database sync is healthy\n');
    process.exit(0);
  }
}

checkDatabaseSync().catch(err => {
  console.error('\n💥 Unexpected error:', err);
  process.exit(1);
});
