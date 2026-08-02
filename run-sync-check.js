#!/usr/bin/env node
/**
 * COMPREHENSIVE SYNC CHECK
 * Verifies Backend, Database, and Frontend are all in sync before git commit
 */

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║       SKOOLSTAK - COMPREHENSIVE SYNC VERIFICATION             ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

async function runCheck(name, command, cwd) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔍 ${name}`);
  console.log(`${'─'.repeat(60)}`);
  
  const { spawn } = require('child_process');
  
  return new Promise((resolve) => {
    const proc = spawn(command, { 
      shell: true, 
      cwd,
      stdio: 'inherit'
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`\n✅ ${name} - PASSED\n`);
        resolve({ name, status: 'PASS' });
      } else {
        console.log(`\n❌ ${name} - FAILED (exit code ${code})\n`);
        resolve({ name, status: 'FAIL', code });
      }
    });
  });
}

async function main() {
  const path = require('path');
  const rootDir = path.join(__dirname, '..');
  const serverDir = path.join(rootDir, 'server');
  const clientDir = path.join(rootDir, 'client');
  
  const results = [];
  
  // 1. Backend Database Sync
  results.push(await runCheck(
    'Backend ↔ Database Sync',
    'node check-db-sync.js',
    serverDir
  ));
  
  // 2. Frontend API Connection
  results.push(await runCheck(
    'Frontend ↔ Backend Connection',
    'node check-api-connection.js',
    clientDir
  ));
  
  // Final Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 FINAL SYNC SUMMARY');
  console.log('═'.repeat(60));
  
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  
  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${r.name}`);
  });
  
  console.log('═'.repeat(60));
  console.log(`Total: ${results.length} checks | Passed: ${passed} | Failed: ${failed}`);
  console.log('═'.repeat(60));
  
  if (failed > 0) {
    console.log('\n❌ SYNC CHECK FAILED');
    console.log('   Please fix the issues above before committing to git\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL SYSTEMS GO!');
    console.log('   Backend, Database, and Frontend are in perfect sync');
    console.log('   Ready to commit and push to git 🚀\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\n💥 Unexpected error:', err);
  process.exit(1);
});
