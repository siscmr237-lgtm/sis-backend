// In-memory seed data copied from frontend mockData

let students = [
  { id: 'STU001', firstName: 'Amina', lastName: 'Ngono', dateOfBirth: '2016-03-15', gender: 'female', class: 'Primary 3', parentName: 'Marie Ngono', parentPhone: '+237 670 123 456', address: 'Yaoundé, Bastos', enrollmentDate: '2019-09-01' },
  { id: 'STU002', firstName: 'Kouam', lastName: 'Tchinda', dateOfBirth: '2017-07-22', gender: 'male', class: 'Primary 2', parentName: 'Jean Tchinda', parentPhone: '+237 677 234 567', address: 'Douala, Bonanjo', enrollmentDate: '2020-09-01' },
  { id: 'STU003', firstName: 'Fatima', lastName: 'Bello', dateOfBirth: '2015-11-08', gender: 'female', class: 'Primary 4', parentName: 'Hassan Bello', parentPhone: '+237 680 345 678', address: 'Yaoundé, Melen', enrollmentDate: '2018-09-01' },
  { id: 'STU004', firstName: 'Emmanuel', lastName: 'Mba', dateOfBirth: '2018-01-20', gender: 'male', class: 'Primary 1', parentName: 'Grace Mba', parentPhone: '+237 690 456 789', address: 'Douala, Akwa', enrollmentDate: '2021-09-01' },
];

let staff = [
  { id: 'STF001', firstName: 'Pauline', lastName: 'Fotso', role: 'Head Teacher', phone: '+237 670 111 222', email: 'p.fotso@school.cm', hireDate: '2015-01-15', salary: 250000 },
  { id: 'STF002', firstName: 'Martin', lastName: 'Ekani', role: 'Mathematics Teacher', phone: '+237 677 222 333', email: 'm.ekani@school.cm', hireDate: '2017-09-01', salary: 150000 },
  { id: 'STF003', firstName: 'Grace', lastName: 'Ayuk', role: 'English Teacher', phone: '+237 680 333 444', email: 'g.ayuk@school.cm', hireDate: '2018-01-10', salary: 150000 },
  { id: 'STF004', firstName: 'Samuel', lastName: 'Nkeng', role: 'Science Teacher', phone: '+237 690 444 555', email: 's.nkeng@school.cm', hireDate: '2019-09-01', salary: 140000 },
];

let fees = [
  { id: 'FEE001', studentId: 'STU001', studentName: 'Amina Ngono', class: 'Primary 3', term: 'Term 1', academicYear: '2024/2025', tuitionFee: 75000, registrationFee: 15000, uniformFee: 10000, booksFee: 20000, otherFees: 5000, totalAmount: 125000, amountPaid: 125000, balance: 0, paymentDate: '2024-09-15', paymentMethod: 'Bank Transfer' },
  { id: 'FEE002', studentId: 'STU002', studentName: 'Kouam Tchinda', class: 'Primary 2', term: 'Term 1', academicYear: '2024/2025', tuitionFee: 70000, registrationFee: 15000, uniformFee: 10000, booksFee: 18000, otherFees: 5000, totalAmount: 118000, amountPaid: 60000, balance: 58000, paymentDate: '2024-09-10', paymentMethod: 'Cash' },
];

let expenses = [
  { id: 'EXP001', date: '2024-10-15', category: 'Utilities', description: 'Electricity bill for October', amount: 45000, payee: 'ENEO Cameroon', paymentMethod: 'Bank Transfer', invoiceNumber: 'INV-2024-10-001' },
  { id: 'EXP002', date: '2024-10-20', category: 'Supplies', description: 'Office stationery and teaching materials', amount: 35000, payee: 'Papeterie Moderne', paymentMethod: 'Cash', invoiceNumber: 'INV-2024-10-002' },
  { id: 'EXP003', date: '2024-10-25', category: 'Maintenance', description: 'Classroom furniture repairs', amount: 55000, payee: 'Menuiserie Excellence', paymentMethod: 'Mobile Money', invoiceNumber: 'INV-2024-10-003' },
];

let reportCards = [
  {
    id: 'RC001',
    studentId: 'STU001',
    studentName: 'Amina Ngono',
    class: 'Primary 3',
    term: 'Term 1',
    academicYear: '2024/2025',
    subjects: [
      { name: 'Mathematics', score: 85, grade: 'A', teacherComment: 'Excellent work' },
      { name: 'English', score: 78, grade: 'B', teacherComment: 'Good progress' },
      { name: 'French', score: 82, grade: 'A', teacherComment: 'Very good' },
      { name: 'Science', score: 90, grade: 'A', teacherComment: 'Outstanding' },
      { name: 'Social Studies', score: 75, grade: 'B', teacherComment: 'Satisfactory' }
    ],
    averageScore: 82,
    position: 2,
    totalStudents: 35,
    attendance: 95,
    headTeacherComment: 'Amina is a dedicated student with excellent performance. Keep it up!'
  }
];

let attendance = [
  { id: 'ATT001', date: '2024-10-31', type: 'student', personId: 'STU001', personName: 'Amina Ngono', status: 'present' },
  { id: 'ATT002', date: '2024-10-31', type: 'student', personId: 'STU002', personName: 'Kouam Tchinda', status: 'absent', remarks: 'Sick' },
  { id: 'ATT003', date: '2024-10-31', type: 'staff', personId: 'STF001', personName: 'Pauline Fotso', status: 'present' },
];

let workRecords = [
  { id: 'WR001', staffId: 'STF002', staffName: 'Martin Ekani', date: '2024-10-31', subject: 'Mathematics', class: 'Primary 3', topic: 'Fractions and Decimals', objectives: 'Students will be able to convert fractions to decimals and vice versa', activities: '1. Introduction to fractions\n2. Converting fractions to decimals\n3. Practice exercises\n4. Group work', evaluation: 'Written test on fraction to decimal conversion', remarks: 'Students showed good understanding. Need more practice on complex fractions.' },
];

let timetable = [
  { id: 'TT001', day: 'Monday', time: '08:00 - 09:00', class: 'Primary 3', subject: 'Mathematics', teacher: 'Martin Ekani' },
  { id: 'TT002', day: 'Monday', time: '09:00 - 10:00', class: 'Primary 3', subject: 'English', teacher: 'Grace Ayuk' },
  { id: 'TT003', day: 'Monday', time: '10:30 - 11:30', class: 'Primary 3', subject: 'Science', teacher: 'Samuel Nkeng' },
  { id: 'TT004', day: 'Tuesday', time: '08:00 - 09:00', class: 'Primary 3', subject: 'French', teacher: 'Pauline Fotso' },
  { id: 'TT005', day: 'Tuesday', time: '09:00 - 10:00', class: 'Primary 3', subject: 'Mathematics', teacher: 'Martin Ekani' },
];

let schoolSettings = {
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
};

module.exports = {
  students,
  staff,
  fees,
  expenses,
  reportCards,
  attendance,
  workRecords,
  timetable,
  schoolSettings,
};
