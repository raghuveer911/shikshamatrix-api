import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

async function check() {
  const schools = await p.school.findMany({
    select: { id: true, name: true, email: true },
  });
  console.log("\n📊 Schools in DB:", JSON.stringify(schools, null, 2));

  for (const s of schools) {
    const [users, staff, classes, students] = await Promise.all([
      p.user.count({ where: { schoolId: s.id } }),
      p.staff.count({ where: { schoolId: s.id } }),
      p.class.count({ where: { schoolId: s.id } }),
      p.student.count({ where: { schoolId: s.id } }),
    ]);
    console.log(`\nSchool ${s.id} — ${s.name}:`);
    console.log(`  Users: ${users}, Staff: ${staff}, Classes: ${classes}, Students: ${students}`);
  }
  await p.$disconnect();
}
check().catch(console.error);