import { PrismaClient, SubscriptionSource } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding ShikshaMatrix database...\n");

  // 1. SuperAdmin
  const superAdminHash = await bcrypt.hash("Admin@ShikshaMatrix123", 10);
  const superAdmin = await prisma.superAdmin.upsert({
    where: { email: "admin@shikshamatrix.com" },
    update: {},
    create: {
      name: "Super Admin",
      email: "admin@shikshamatrix.com",
      passwordHash: superAdminHash,
      isActive: true,
    },
  });
  console.log("SuperAdmin created:", superAdmin.email);

  // 2. School
  const school = await prisma.school.upsert({
    where: { slug: "greenwood-public-school" },
    update: {},
    create: {
      name: "Greenwood Public School",
      slug: "greenwood-public-school",
      email: "admin@greenwood.edu",
      phone: "9876543210",
      address: "123, Green Avenue, Sector 5",
      city: "Jaipur",
      state: "Rajasthan",
      pincode: "302001",
      board: "CBSE",
      establishedYear: 2005,
      adminName: "Raghuveer Singh",
      adminEmail: "admin@greenwood.edu",
      adminPhone: "9876543211",
      status: "ACTIVE",
      isApproved: true,
      maxStudents: 1000,
      maxTeachers: 100,
    },
  });
  console.log("School created:", school.name);

  // 2b. Subscription — Professional plan, 1 year, so every module is
  //     open for testing without hitting 402/403 during local dev.
  const proPlan = await prisma.subscriptionPlan.findUnique({ where: { tier: "PROFESSIONAL" } });
  if (!proPlan) {
    console.warn("WARNING: SubscriptionPlan table is empty — run subscriptionPlans.seed.ts first, then re-run this seed.");
  } else {
    const now = new Date();
    const oneYearLater = new Date(now);
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);

    await prisma.schoolSubscription.upsert({
      where: { schoolId: school.id },
      update: { planId: proPlan.id, status: "ACTIVE" },
      create: {
        schoolId: school.id,
        planId: proPlan.id,
        status: "ACTIVE",
        source: SubscriptionSource.ADMIN_ASSIGNED,
        assignmentNote: "Seeded for local development/testing",
        billingCycleStart: now,
        billingCycleEnd: oneYearLater,
        autoRenew: false,
        creditWallet: {
          create: {
            smsBalance: proPlan.smsCredits,
            whatsappBalance: proPlan.whatsappCredits,
          },
        },
      },
    });
    console.log("Subscription (Professional, 1 year) assigned to:", school.name);
  }

  // 3. Academic Year
  const academicYear = await prisma.academicYear.upsert({
    where: { schoolId_name: { schoolId: school.id, name: "2026-27" } },
    update: { isCurrent: true },
    create: {
      schoolId: school.id,
      name: "2026-27",
      startDate: new Date("2026-04-01"),
      endDate: new Date("2027-03-31"),
      isCurrent: true,
    },
  });
  console.log("Academic Year created:", academicYear.name);

  // 4. School Admin User
  const adminHash = await bcrypt.hash("School@123", 10);
  const adminUser = await prisma.user.upsert({
    where: { phone: "9876543211" },
    update: {},
    create: {
      schoolId: school.id,
      name: "Raghuveer Singh",
      phone: "9876543211",
      email: "admin@greenwood.edu",
      passwordHash: adminHash,
      role: "SCHOOL_ADMIN",
      gender: "MALE",
      isActive: true,
    },
  });
  console.log("School Admin User created:", adminUser.phone);

  // 5. Teacher
  const teacherHash = await bcrypt.hash("Teacher@123", 10);

  const teacher1User = await prisma.user.upsert({
    where: { phone: "9111111111" },
    update: {},
    create: {
      schoolId: school.id,
      name: "Deepak Vyas",
      phone: "9111111111",
      email: "deepak@greenwood.edu",
      passwordHash: teacherHash,
      role: "TEACHER",
      gender: "MALE",
      isActive: true,
    },
  });

  const teacher1 = await prisma.staff.upsert({
    where: { userId: teacher1User.id },
    update: {},
    create: {
      userId: teacher1User.id,
      schoolId: school.id,
      employeeId: "LIPS02650D",
      designation: "Senior Teacher",
      department: "Science",
      qualification: "M.Sc",
      experienceYears: 5,
      employmentType: "PERMANENT",
      salary: 36000,
      joinDate: new Date("2000-05-01"),
      isActive: true,
    },
  });
  console.log("Teacher created:", teacher1User.name);

  // 6. Class
  const class8A = await prisma.class.upsert({
    where: { schoolId_name_academicYear: { schoolId: school.id, name: "8-A", academicYear: "2026-27" } },
    update: {},
    create: {
      schoolId: school.id,
      classTeacherId: teacher1.id,
      name: "8-A",
      classNumber: "8",
      section: "A",
      shift: "MORNING",
      academicYear: "2026-27",
      capacity: 40,
      isActive: true,
    },
  });
  console.log("Class created:", class8A.name);

  await prisma.staff.update({
    where: { id: teacher1.id },
    data: { classesAsTeacher: { connect: { id: class8A.id } } },
  });

  // 7. Subjects
  const subjectNames = ["Mathematics", "English", "Hindi", "Science", "Social Studies", "Sanskrit"];
  for (const name of subjectNames) {
    await prisma.subject.upsert({
      where: { schoolId_classId_name: { schoolId: school.id, classId: class8A.id, name } },
      update: {},
      create: {
        schoolId: school.id,
        classId: class8A.id,
        name,
        isActive: true,
      },
    });
  }
  console.log("Subjects created:", subjectNames.length);

  // 8. Students (5, all in class 8-A)
  const studentHash = await bcrypt.hash("Student@123", 10);
  const students = [
    { name: "Aarav Sharma",   phone: "9876543210", gender: "MALE",   roll: "8026NBN01", adm: "2026ADM001" },
    { name: "Priya Gupta",    phone: "9876543212", gender: "FEMALE", roll: "8026NBN02", adm: "2026ADM002" },
    { name: "Pramesh Jangid", phone: "4587662596", gender: "MALE",   roll: "8026NBN03", adm: "2026ADM003" },
    { name: "Ramesh Jangid",  phone: "9856762225", gender: "MALE",   roll: "8026NBN04", adm: "2026ADM004" },
    { name: "Anjali Singh",   phone: "7878787878", gender: "FEMALE", roll: "8026NBN05", adm: "2026ADM005" },
  ];

  for (const s of students) {
    const existingUser = await prisma.user.findUnique({ where: { phone: s.phone } });
    const studentUser = existingUser ?? await prisma.user.create({
      data: {
        schoolId: school.id,
        name: s.name,
        phone: s.phone,
        passwordHash: studentHash,
        role: "STUDENT",
        gender: s.gender as any,
        isActive: true,
      },
    });

    await prisma.student.upsert({
      where: { userId: studentUser.id },
      update: {},
      create: {
        userId: studentUser.id,
        schoolId: school.id,
        classId: class8A.id,
        rollNumber: s.roll,
        admissionNumber: s.adm,
        admissionDate: new Date("2026-04-01"),
        isActive: true,
      },
    });
  }
  console.log("Students created:", students.length);

  // 9. School Settings
  await prisma.schoolSettings.upsert({
    where: { schoolId: school.id },
    update: {},
    create: {
      schoolId: school.id,
      workingDays: "MON_SAT",
      periodStartTime: "09:00",
    },
  });
  console.log("School Settings created");

  // 10. Fee Structure — no unique key to upsert on, so check-then-create
  const existingFee = await prisma.feeStructure.findFirst({
    where: { schoolId: school.id, classId: class8A.id, name: "Tuition Fee Q1" },
  });
  if (!existingFee) {
    await prisma.feeStructure.create({
      data: {
        schoolId: school.id,
        classId: class8A.id,
        academicYearId: academicYear.id,
        name: "Tuition Fee Q1",
        category: "TUITION",
        amount: 15000,
        dueDate: new Date("2026-05-31"),
        isActive: true,
      },
    });
  }
  console.log("Fee Structure created");

  // Summary
  console.log("\nSeeding complete!\n");
  console.log("-----------------------------------");
  console.log("Login Credentials:");
  console.log("-----------------------------------");
  console.log("SuperAdmin:");
  console.log("  Email   : admin@shikshamatrix.com");
  console.log("  Password: Admin@ShikshaMatrix123");
  console.log("");
  console.log("School Admin (Greenwood Public School — Professional plan, 1yr):");
  console.log("  Phone   : 9876543211");
  console.log("  Password: School@123");
  console.log("");
  console.log("Teacher (Deepak Vyas):");
  console.log("  Phone   : 9111111111");
  console.log("  Password: Teacher@123");
  console.log("-----------------------------------\n");
}

main()
  .catch(e => { console.error("Seed failed:", e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
