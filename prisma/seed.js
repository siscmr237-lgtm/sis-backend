require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Starting seed...');
  // With the new multi-school setup, seeding is more complex.
  // You should first create a school and an admin via the /api/auth/signup endpoint.
  // Then, you can use the resulting schoolId to seed data for that specific school.
  //
  // Example of how you might seed for a specific school:
  // const schoolId = 'your-school-id-from-signup';
  //
  // if (schoolId) {
  //   // School settings (upsert single row id=1)
  //   await prisma.school.update({
  //     where: { id: schoolId },
  //     data: {
  //       name: 'Excellence Nursery & Primary School',
  //       logo: 'https://images.unsplash.com/photo-1599305445671-ac291c95aaa9?w=200&h=200&fit=crop',
  //       academicYear: '2024/2025',
  //       currentTerm: 'Term 1',
  //       subjectsPerClass: [
  //         { id: 'SC001', className: 'Nursery 1', subjects: ['English', 'Mathematics', 'Creative Arts', 'Physical Education'] },
  //         { id: 'SC002', className: 'Nursery 2', subjects: ['English', 'Mathematics', 'Creative Arts', 'Physical Education', 'Environmental Studies'] },
  //         { id: 'SC003', className: 'Primary 1', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts'] },
  //         { id: 'SC004', className: 'Primary 2', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT'] },
  //         { id: 'SC005', className: 'Primary 3', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT'] },
  //         { id: 'SC006', className: 'Primary 4', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT', 'Religious Education'] },
  //         { id: 'SC007', className: 'Primary 5', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT', 'Religious Education'] },
  //         { id: 'SC008', className: 'Primary 6', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT', 'Religious Education'] },
  //       ],
  //     },
  //   });
  //
  //   // Students
  //   const students = await prisma.$transaction([
  //     prisma.student.upsert({
  //       where: { code: 'STU001' },
  //       update: { schoolId },
  //       create: {
  //         code: 'STU001', firstName: 'Amina', lastName: 'Ngono', dateOfBirth: new Date('2016-03-15'),
  //         gender: 'female', class: 'Primary 3', parentName: 'Marie Ngono', parentPhone: '+237 670 123 456', address: 'Yaoundé, Bastos', enrollmentDate: new Date('2019-09-01'),
  //         schoolId,
  //       }
  //     }),
  //     // ... other students
  //   ]);
  //
  //   // ... seed other data like Staff, Fees, etc., always passing the schoolId.
  // }
  //
  // // Admin user seeding is now handled by the signup route.
  // // The code below is commented out as it's replaced by the API flow.
  //
  // const bcrypt = require('bcryptjs');
  // const phone = process.env.ADMIN_PHONE || '+237600000000';
  // const password = process.env.ADMIN_PASSWORD || 'admin123';
  // const name = process.env.ADMIN_NAME || 'School Admin';
  // const existing = await prisma.adminUser.findUnique({ where: { phoneNumber: phone } });
  // if (!existing) {
  //   const passwordHash = bcrypt.hashSync(String(password), 10);
  //   await prisma.adminUser.create({
  //     data: {
  //       phoneNumber: phone,
  //       passwordHash,
  //       name,
  //       role: 'admin',
  //       school: {
  //         create: {
  //           name: 'Default Seed School',
  //           logo: '',
  //           academicYear: '2024/2025',
  //           currentTerm: 'Term 1',
  //           subjectsPerClass: [],
  //         }
  //       }
  //     }
  //   });
  //   console.log('Seeded admin user with phone:', phone);
  // }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Seed script finished.');
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
