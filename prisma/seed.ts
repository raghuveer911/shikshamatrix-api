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

  // Summary
  console.log("\nSeeding complete!\n");
  console.log("-----------------------------------");
  console.log("Login Credentials:");
  console.log("-----------------------------------");
  console.log("SuperAdmin:");
  console.log("  Email   : admin@shikshamatrix.com");
  console.log("  Password: Admin@ShikshaMatrix123");
  console.log("");
  console.log("-----------------------------------\n");
}

main()
  .catch(e => { console.error("Seed failed:", e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
