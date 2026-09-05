// Quick API Health Check Script
// Run this after both servers are running to verify endpoints

const BASE_URL = 'http://localhost:5000/api';

async function testEndpoints() {
  console.log('\n🔍 Testing Backend API Endpoints...\n');
  
  const tests = [
    { name: 'Health Check', method: 'GET', url: 'http://localhost:5000/health' },
    { name: 'School Registration Route', method: 'POST', url: `${BASE_URL}/auth/register` },
    { name: 'Login with ID Route', method: 'POST', url: `${BASE_URL}/auth/login-with-id` },
    { name: 'Forgot Password Route', method: 'POST', url: `${BASE_URL}/auth/forgot-password` },
    { name: 'Subjects Route', method: 'GET', url: `${BASE_URL}/subjects` },
    { name: 'Student Photo Upload Route', method: 'POST', url: `${BASE_URL}/upload/student-photo/00000000-0000-0000-0000-000000000000` },
    { name: 'Receipt Upload Route', method: 'POST', url: `${BASE_URL}/upload/receipt/00000000-0000-0000-0000-000000000000` },
    { name: 'Students Import Route', method: 'POST', url: `${BASE_URL}/students/import-excel` },
  ];

  for (const test of tests) {
    try {
      const response = await fetch(test.url, {
        method: test.method,
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.status === 200) {
        console.log(`✅ ${test.name}: OK (200)`);
      } else if ([400, 401, 403, 422].includes(response.status)) {
        console.log(`✅ ${test.name}: Endpoint exists (${response.status})`);
      } else if (response.status === 404) {
        console.log(`❌ ${test.name}: Not Found (404)`);
      } else {
        console.log(`⚠️  ${test.name}: Status ${response.status}`);
      }
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') {
        console.log(`❌ ${test.name}: Server not running`);
      } else {
        console.log(`❌ ${test.name}: ${error.message}`);
      }
    }
  }
  
  console.log('\n📊 Testing complete!\n');
}

testEndpoints().catch(console.error);
