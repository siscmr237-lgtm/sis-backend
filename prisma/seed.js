require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // School settings (upsert single row id=1)
  await prisma.schoolSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      name: 'Excellence Nursery & Primary School',
      logo: 'https://images.unsplash.com/photo-1599305445671-ac291c95aaa9?w=200&h=200&fit=crop',
      academicYear: '2024/2025',
      currentTerm: 'Term 1',
      subjectsPerClass: [
        { id: 'SC001', className: 'Nursery 1', subjects: ['English', 'Mathematics', 'Creative Arts', 'Physical Education'] },
        { id: 'SC002', className: 'Nursery 2', subjects: ['English', 'Mathematics', 'Creative Arts', 'Physical Education', 'Environmental Studies'] },
        { id: 'SC003', className: 'Primary 1', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts'] },
        { id: 'SC004', className: 'Primary 2', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT'] },
        { id: 'SC005', className: 'Primary 3', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT'] },
        { id: 'SC006', className: 'Primary 4', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT', 'Religious Education'] },
        { id: 'SC007', className: 'Primary 5', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT', 'Religious Education'] },
        { id: 'SC008', className: 'Primary 6', subjects: ['English', 'Mathematics', 'Science', 'Social Studies', 'French', 'Physical Education', 'Creative Arts', 'ICT', 'Religious Education'] },
      ],
    },
  });

  // Students
  const students = await prisma.$transaction([
    prisma.student.upsert({
      where: { code: 'STU001' },
      update: {},
      create: {
        code: 'STU001', firstName: 'Amina', lastName: 'Ngono', dateOfBirth: new Date('2016-03-15'),
        gender: 'female', class: 'Primary 3', parentName: 'Marie Ngono', parentPhone: '+237 670 123 456', address: 'Yaoundé, Bastos', enrollmentDate: new Date('2019-09-01')
      }
    }),
    prisma.student.upsert({
      where: { code: 'STU002' }, update: {}, create: {
        code: 'STU002', firstName: 'Kouam', lastName: 'Tchinda', dateOfBirth: new Date('2017-07-22'),
        gender: 'male', class: 'Primary 2', parentName: 'Jean Tchinda', parentPhone: '+237 677 234 567', address: 'Douala, Bonanjo', enrollmentDate: new Date('2020-09-01')
      }
    }),
    prisma.student.upsert({
      where: { code: 'STU003' }, update: {}, create: {
        code: 'STU003', firstName: 'Fatima', lastName: 'Bello', dateOfBirth: new Date('2015-11-08'),
        gender: 'female', class: 'Primary 4', parentName: 'Hassan Bello', parentPhone: '+237 680 345 678', address: 'Yaoundé, Melen', enrollmentDate: new Date('2018-09-01')
      }
    }),
    prisma.student.upsert({
      where: { code: 'STU004' }, update: {}, create: {
        code: 'STU004', firstName: 'Emmanuel', lastName: 'Mba', dateOfBirth: new Date('2018-01-20'),
        gender: 'male', class: 'Primary 1', parentName: 'Grace Mba', parentPhone: '+237 690 456 789', address: 'Douala, Akwa', enrollmentDate: new Date('2021-09-01')
      }
    }),
  ]);

  // Staff
  await prisma.$transaction([
    prisma.staff.upsert({ where: { code: 'STF001' }, update: {}, create: { code: 'STF001', firstName: 'Pauline', lastName: 'Fotso', role: 'Head Teacher', phone: '+237 670 111 222', email: 'p.fotso@school.cm', hireDate: new Date('2015-01-15'), salary: 250000 } }),
    prisma.staff.upsert({ where: { code: 'STF002' }, update: {}, create: { code: 'STF002', firstName: 'Martin', lastName: 'Ekani', role: 'Mathematics Teacher', phone: '+237 677 222 333', email: 'm.ekani@school.cm', hireDate: new Date('2017-09-01'), salary: 150000 } }),
    prisma.staff.upsert({ where: { code: 'STF003' }, update: {}, create: { code: 'STF003', firstName: 'Grace', lastName: 'Ayuk', role: 'English Teacher', phone: '+237 680 333 444', email: 'g.ayuk@school.cm', hireDate: new Date('2018-01-10'), salary: 150000 } }),
    prisma.staff.upsert({ where: { code: 'STF004' }, update: {}, create: { code: 'STF004', firstName: 'Samuel', lastName: 'Nkeng', role: 'Science Teacher', phone: '+237 690 444 555', email: 's.nkeng@school.cm', hireDate: new Date('2019-09-01'), salary: 140000 } }),
  ]);

  // Fees
  await prisma.$transaction([
    prisma.fee.upsert({
      where: { code: 'FEE001' }, update: {}, create: {
        code: 'FEE001', studentId: students[0].id, studentName: 'Amina Ngono', class: 'Primary 3', term: 'Term 1', academicYear: '2024/2025',
        tuitionFee: 75000, registrationFee: 15000, uniformFee: 10000, booksFee: 20000, otherFees: 5000, totalAmount: 125000, amountPaid: 125000, balance: 0,
        paymentDate: new Date('2024-09-15'), paymentMethod: 'Bank Transfer'
      }
    }),
    prisma.fee.upsert({
      where: { code: 'FEE002' }, update: {}, create: {
        code: 'FEE002', studentId: students[1].id, studentName: 'Kouam Tchinda', class: 'Primary 2', term: 'Term 1', academicYear: '2024/2025',
        tuitionFee: 70000, registrationFee: 15000, uniformFee: 10000, booksFee: 18000, otherFees: 5000, totalAmount: 118000, amountPaid: 60000, balance: 58000,
        paymentDate: new Date('2024-09-10'), paymentMethod: 'Cash'
      }
    }),
  ]);

  // Expenses
  await prisma.$transaction([
    prisma.expense.upsert({ where: { code: 'EXP001' }, update: {}, create: { code: 'EXP001', date: new Date('2024-10-15'), category: 'Utilities', description: 'Electricity bill for October', amount: 45000, payee: 'ENEO Cameroon', paymentMethod: 'Bank Transfer', invoiceNumber: 'INV-2024-10-001' } }),
    prisma.expense.upsert({ where: { code: 'EXP002' }, update: {}, create: { code: 'EXP002', date: new Date('2024-10-20'), category: 'Supplies', description: 'Office stationery and teaching materials', amount: 35000, payee: 'Papeterie Moderne', paymentMethod: 'Cash', invoiceNumber: 'INV-2024-10-002' } }),
    prisma.expense.upsert({ where: { code: 'EXP003' }, update: {}, create: { code: 'EXP003', date: new Date('2024-10-25'), category: 'Maintenance', description: 'Classroom furniture repairs', amount: 55000, payee: 'Menuiserie Excellence', paymentMethod: 'Mobile Money', invoiceNumber: 'INV-2024-10-003' } }),
  ]);

  // Attendance
  await prisma.$transaction([
    prisma.attendanceRecord.upsert({ where: { code: 'ATT001' }, update: {}, create: { code: 'ATT001', date: new Date('2024-10-31'), type: 'student', personId: 'STU001', personName: 'Amina Ngono', status: 'present' } }),
    prisma.attendanceRecord.upsert({ where: { code: 'ATT002' }, update: {}, create: { code: 'ATT002', date: new Date('2024-10-31'), type: 'student', personId: 'STU002', personName: 'Kouam Tchinda', status: 'absent', remarks: 'Sick' } }),
    prisma.attendanceRecord.upsert({ where: { code: 'ATT003' }, update: {}, create: { code: 'ATT003', date: new Date('2024-10-31'), type: 'staff', personId: 'STF001', personName: 'Pauline Fotso', status: 'present' } }),
  ]);

  // WorkRecords
  await prisma.$transaction([
    prisma.workRecord.upsert({ where: { code: 'WR001' }, update: {}, create: { code: 'WR001', staffId: (await prisma.staff.findUnique({ where: { code: 'STF002' } })).id, staffName: 'Martin Ekani', date: new Date('2024-10-31'), subject: 'Mathematics', class: 'Primary 3', topic: 'Fractions and Decimals', objectives: 'Students will be able to convert fractions to decimals and vice versa', activities: '1. Introduction to fractions\n2. Converting fractions to decimals\n3. Practice exercises\n4. Group work', evaluation: 'Written test on fraction to decimal conversion', remarks: 'Students showed good understanding. Need more practice on complex fractions.' } }),
  ]);

  // Timetable
  await prisma.$transaction([
    prisma.timetableEntry.upsert({ where: { code: 'TT001' }, update: {}, create: { code: 'TT001', day: 'Monday', time: '08:00 - 09:00', class: 'Primary 3', subject: 'Mathematics', teacher: 'Martin Ekani' } }),
    prisma.timetableEntry.upsert({ where: { code: 'TT002' }, update: {}, create: { code: 'TT002', day: 'Monday', time: '09:00 - 10:00', class: 'Primary 3', subject: 'English', teacher: 'Grace Ayuk' } }),
    prisma.timetableEntry.upsert({ where: { code: 'TT003' }, update: {}, create: { code: 'TT003', day: 'Monday', time: '10:30 - 11:30', class: 'Primary 3', subject: 'Science', teacher: 'Samuel Nkeng' } }),
    prisma.timetableEntry.upsert({ where: { code: 'TT004' }, update: {}, create: { code: 'TT004', day: 'Tuesday', time: '08:00 - 09:00', class: 'Primary 3', subject: 'French', teacher: 'Pauline Fotso' } }),
    prisma.timetableEntry.upsert({ where: { code: 'TT005' }, update: {}, create: { code: 'TT005', day: 'Tuesday', time: '09:00 - 10:00', class: 'Primary 3', subject: 'Mathematics', teacher: 'Martin Ekani' } }),
  ]);

  // Admin user (auth)
  const bcrypt = require('bcryptjs');
  const phone = process.env.ADMIN_PHONE || '+237600000000';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'School Admin';
  const existing = await prisma.adminUser.findUnique({ where: { phoneNumber: phone } });
  if (!existing) {
    const passwordHash = bcrypt.hashSync(String(password), 10);
    await prisma.adminUser.create({ data: { phoneNumber: phone, passwordHash, name, role: 'admin' } });
    console.log('Seeded admin user with phone:', phone);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Seed completed');
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
