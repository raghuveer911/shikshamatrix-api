# School ERP API

Backend for the School ERP platform. Multi-tenant SaaS with Fastify + PostgreSQL + Prisma.

## Quick Start

### Prerequisites
- Node.js 20+
- pnpm
- Docker Desktop (for PostgreSQL)

### Setup

1. **Install dependencies** (from monorepo root):
```bash
   pnpm install
```

2. **Start PostgreSQL** (in `apps/api`):
```bash
   pnpm db:up
```

3. **Apply database schema**:
```bash
   pnpm db:push
```

4. **Generate Prisma client**:
```bash
   pnpm db:generate
```

5. **Start dev server**:
```bash
   pnpm dev
```

   Server runs on `http://localhost:4000`.

### Useful Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server with hot reload |
| `pnpm db:up` | Start Postgres container |
| `pnpm db:down` | Stop Postgres container |
| `pnpm db:logs` | Tail Postgres logs |
| `pnpm db:studio` | Open Prisma Studio (DB GUI) |
| `pnpm db:push` | Push schema to DB (no migration) |
| `pnpm db:migrate` | Create and apply migration |
| `pnpm db:reset` | Reset DB (deletes all data) |

### URLs

- API: http://localhost:4000
- pgAdmin: http://localhost:5050 (admin@school.com / admin)
- Prisma Studio: http://localhost:5555 (run `pnpm db:studio`)

### Test API

```bash
curl http://localhost:4000/health
curl http://localhost:4000/health/db
```