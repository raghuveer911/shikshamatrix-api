import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async () => ({
    success: true,
    message: "School ERP API",
    version: "1.0.0",
  }));

  app.get("/health", async () => ({
    success: true,
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  app.get("/health/db", async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        success: true,
        status: "ok",
        database: "connected",
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        status: "error",
        database: "disconnected",
        error: msg,
      };
    }
  });
}