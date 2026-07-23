import { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";

export async function registerJwt(app: FastifyInstance) {
  await app.register(fastifyJwt, {
    secret: process.env["JWT_SECRET"] as string,
  });
}