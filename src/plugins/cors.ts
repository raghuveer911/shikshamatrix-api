import { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { corsOrigins } from "../config/env.js";

export async function registerCors(app: FastifyInstance) {
  await app.register(cors, {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow: boolean) => void
    ) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: Origin ${origin} not allowed`), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}