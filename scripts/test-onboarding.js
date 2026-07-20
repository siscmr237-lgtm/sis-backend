require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();
const BASE = 'http://localhost:4000';

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const TEST_PHONE = '+2370000000001';

  // ── 1. Clean up any leftover test data from a previous run ────────────────
  const existing = await prisma.adminUser.findUnique({ where: { phoneNumber: TEST_PHONE } });
  if (existing) {
    const school = await prisma.school.findFirst({ where: { adminUserId: existing.id } });
    if (school) {
      await prisma.class.deleteMany({ where: { schoolId: school.id } });
      await prisma.school.delete({ where: { id: school.id } });
    }
    await prisma.adminUser.delete({ where: { id: existing.id } });
    console.log('[1] Cleaned up leftover test data');
  }

  // ── 2. Verify new columns exist on all non-test schools ────────────────────
  console.log('\n[2] Checking existing schools have onboardingCompleted = true...');
  const schools = await prisma.school.findMany({
    select: { id: true, name: true, onboardingCompleted: true, schoolType: true },
  });
  for (const s of schools) {
    if (!s.onboardingCompleted) throw new Error(`School "${s.name}" (id ${s.id}) has onboardingCompleted=false — expected true for existing rows`);
    console.log(`  ✓ ${s.name}: onboardingCompleted=${s.onboardingCompleted}, schoolType=${s.schoolType}`);
  }

  // ── 3. Sign up a new account — onboardingCompleted should be false ─────────
  console.log('\n[3] Signing up test account...');
  const signup = await req('POST', '/auth/signup', {
    phoneNumber: TEST_PHONE,
    password: 'testpass123',
    schoolName: 'Test Onboarding School',
  });
  const token = signup.token;
  const newSchool = signup.user.School[0];
  console.log(`  ✓ Signed up. onboardingCompleted=${newSchool.onboardingCompleted}`);
  if (newSchool.onboardingCompleted !== false) {
    throw new Error(`Expected onboardingCompleted=false for new signup, got ${newSchool.onboardingCompleted}`);
  }

  // ── 4. Fetch the class catalog ─────────────────────────────────────────────
  console.log('\n[4] Fetching class catalog (filtered by type)...');
  const allClasses = await req('GET', '/onboarding/class-catalog', null, token);
  console.log(`  ✓ Full catalog: ${allClasses.map(c => c.name).join(', ')}`);

  const primaryClasses = await req('GET', '/onboarding/class-catalog?schoolType=DAYCARE_NURSERY_PRIMARY', null, token);
  console.log(`  ✓ Primary type (${primaryClasses.length} classes): ${primaryClasses.map(c => c.name).join(', ')}`);

  const nurseryClasses = await req('GET', '/onboarding/class-catalog?schoolType=DAYCARE_NURSERY', null, token);
  console.log(`  ✓ Nursery type (${nurseryClasses.length} classes): ${nurseryClasses.map(c => c.name).join(', ')}`);
  if (nurseryClasses.some(c => c.name.startsWith('Class '))) {
    throw new Error('Class 1–6 should NOT appear for DAYCARE_NURSERY type');
  }

  // ── 5. POST to /onboarding ─────────────────────────────────────────────────
  console.log('\n[5] Completing onboarding...');
  const result = await req('POST', '/onboarding', {
    schoolType: 'DAYCARE_NURSERY_PRIMARY',
    classNames: ['Pre-Nursery', 'Nursery 1', 'Nursery 2', 'Class 1', 'Class 2'],
    motto: 'Excellence in Education',
    address: '123 Test Street, Buea',
    uniformColors: ['#ffffff', '#003366'],
  }, token);

  console.log(`  ✓ School updated: onboardingCompleted=${result.school.onboardingCompleted}, schoolType=${result.school.schoolType}`);
  console.log(`  ✓ Classes created: ${result.classes.map(c => c.name).join(', ')}`);

  if (!result.school.onboardingCompleted) throw new Error('onboardingCompleted should be true after onboarding');
  if (result.classes.length !== 5) throw new Error(`Expected 5 classes, got ${result.classes.length}`);

  // ── 6. Verify classes actually exist in the DB ─────────────────────────────
  console.log('\n[6] Verifying class records in DB...');
  const dbClasses = await prisma.class.findMany({
    where: { schoolId: newSchool.id },
    orderBy: { name: 'asc' },
  });
  console.log(`  ✓ DB classes: ${dbClasses.map(c => c.name).join(', ')}`);

  // ── 7. Idempotency — calling onboarding again should not duplicate classes ──
  // Brief pause so the connection pool settles between rapid requests in this test env.
  await new Promise(r => setTimeout(r, 1500));
  console.log('\n[7] Testing idempotency (re-submit same classes)...');
  const result2 = await req('POST', '/onboarding', {
    schoolType: 'DAYCARE_NURSERY_PRIMARY',
    classNames: ['Pre-Nursery', 'Nursery 1', 'Nursery 2', 'Class 1', 'Class 2'],
  }, token);
  if (result2.classes.length !== 5) {
    throw new Error(`Expected 5 classes after re-submit, got ${result2.classes.length} — possible duplicates`);
  }
  console.log(`  ✓ No duplicates after re-submit (${result2.classes.length} classes)`);

  // ── 8. Invalid class name for school type should 400 ──────────────────────
  console.log('\n[8] Testing validation: Class 1 with DAYCARE_NURSERY type...');
  try {
    await req('POST', '/onboarding', {
      schoolType: 'DAYCARE_NURSERY',
      classNames: ['Nursery 1', 'Class 1'],
    }, token);
    throw new Error('Should have rejected Class 1 for DAYCARE_NURSERY');
  } catch (e) {
    if (e.message.includes('Should have rejected')) throw e;
    console.log(`  ✓ Correctly rejected: ${e.message.slice(0, 80)}`);
  }

  // ── 9. Clean up test data ──────────────────────────────────────────────────
  console.log('\n[9] Cleaning up test data...');
  await prisma.class.deleteMany({ where: { schoolId: newSchool.id } });
  await prisma.school.delete({ where: { id: newSchool.id } });
  await prisma.adminUser.delete({ where: { phoneNumber: TEST_PHONE } });
  console.log('  ✓ Test data removed');

  console.log('\n✅ All checks passed.\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌', e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
