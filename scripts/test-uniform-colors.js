require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
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
  const TEST_PHONE = '+2370000000099';
  const TEST_EMAIL = 'uniform-colors-test@example.com';

  const existing = (await prisma.adminUser.findUnique({ where: { phoneNumber: TEST_PHONE } }))
    || (await prisma.adminUser.findUnique({ where: { email: TEST_EMAIL } }));
  if (existing) {
    const school = await prisma.school.findFirst({ where: { adminUserId: existing.id } });
    if (school) {
      await prisma.class.deleteMany({ where: { schoolId: school.id } });
      await prisma.school.delete({ where: { id: school.id } });
    }
    await prisma.adminUser.delete({ where: { id: existing.id } });
    console.log('[1] Cleaned up leftover test data');
  }

  console.log('\n[2] Signing up test account...');
  const signup = await req('POST', '/auth/signup', {
    name: 'Uniform Colors Tester',
    phoneNumber: TEST_PHONE,
    email: 'uniform-colors-test@example.com',
    password: 'Testpass123!',
    schoolName: 'Uniform Colors Test School',
  });
  const token = signup.token;
  const newSchool = signup.user.School[0];

  console.log('\n[3] Submitting onboarding with structured uniformColors...');
  const result = await req('POST', '/onboarding', {
    schoolType: 'DAYCARE_NURSERY',
    classNames: ['Nursery 1'],
    uniformColors: { shirt: 'Sky Blue', trouser: 'Navy', gown: null },
  }, token);
  console.log('  Saved uniformColors:', JSON.stringify(result.school.uniformColors));

  const expected = JSON.stringify({ shirt: 'Sky Blue', trouser: 'Navy', gown: null });
  const actualSorted = JSON.stringify(result.school.uniformColors, Object.keys(result.school.uniformColors).sort());
  if (JSON.stringify(result.school.uniformColors.shirt) !== '"Sky Blue"' ||
      JSON.stringify(result.school.uniformColors.trouser) !== '"Navy"' ||
      result.school.uniformColors.gown !== null) {
    throw new Error(`uniformColors mismatch. Got: ${JSON.stringify(result.school.uniformColors)}`);
  }
  console.log('  ✓ Structured shape saved correctly');

  console.log('\n[4] Testing rejection of legacy array shape...');
  try {
    await req('POST', '/onboarding', {
      schoolType: 'DAYCARE_NURSERY',
      classNames: ['Nursery 1'],
      uniformColors: ['White', 'Navy'],
    }, token);
    throw new Error('Should have rejected array-shaped uniformColors');
  } catch (e) {
    if (e.message.includes('Should have rejected')) throw e;
    console.log(`  ✓ Correctly rejected: ${e.message.slice(0, 100)}`);
  }

  console.log('\n[5] Testing rejection of invalid garment key...');
  try {
    await req('POST', '/onboarding', {
      schoolType: 'DAYCARE_NURSERY',
      classNames: ['Nursery 1'],
      uniformColors: { hat: 'Red' },
    }, token);
    throw new Error('Should have rejected invalid garment key');
  } catch (e) {
    if (e.message.includes('Should have rejected')) throw e;
    console.log(`  ✓ Correctly rejected: ${e.message.slice(0, 100)}`);
  }

  console.log('\n[6] Reloading school record directly from DB...');
  const reloaded = await prisma.school.findUnique({ where: { id: newSchool.id } });
  console.log('  DB uniformColors:', JSON.stringify(reloaded.uniformColors));
  if (reloaded.uniformColors.shirt !== 'Sky Blue' || reloaded.uniformColors.trouser !== 'Navy' || reloaded.uniformColors.gown !== null) {
    throw new Error('DB value does not match what was submitted');
  }
  console.log('  ✓ Persisted value matches submission after reload');

  console.log('\n[7] Cleaning up test data...');
  await prisma.class.deleteMany({ where: { schoolId: newSchool.id } });
  await prisma.school.delete({ where: { id: newSchool.id } });
  await prisma.adminUser.delete({ where: { phoneNumber: TEST_PHONE } });
  console.log('  ✓ Test data removed');

  console.log('\n✅ All uniformColors checks passed.\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌', e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
