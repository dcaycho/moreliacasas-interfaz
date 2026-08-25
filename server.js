const path = require("path");
const Fastify = require("fastify");
const fastifyStatic = require("@fastify/static");
const { Pool } = require("pg");

const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT || 80);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/",
});

app.get("/health", async () => ({
  ok: true,
  service: "moreliacasas-interfaz",
  time: new Date().toISOString(),
}));

app.get("/health/db", async (request, reply) => {
  try {
    const r = await pool.query("SELECT NOW() AS time");
    return { ok: true, database: "connected", time: r.rows[0].time };
  } catch (err) {
    reply.code(500);
    return { ok: false, database: "disconnected", error: err.message };
  }
});

async function tableExists(table) {
  const r = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table]
  );
  return r.rows[0].exists;
}

async function tableColumns(table) {
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map(x => x.column_name);
}

app.get("/api/conversations", async (request, reply) => {
  try {
    if (!(await tableExists("conversaciones"))) {
      return { ok: true, conversations: [], columns: [] };
    }

    const columns = await tableColumns("conversaciones");
    const safeColumns = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(", ");
    const orderCol = columns.includes("actualizada_en")
      ? `"actualizada_en"`
      : columns.includes("ultimo_mensaje_en")
      ? `"ultimo_mensaje_en"`
      : columns.includes("id")
      ? `"id"`
      : null;

    const sql = `
      SELECT ${safeColumns},
        (
          SELECT m."texto"
          FROM "mensajes" m
          WHERE m."conversacion_id" = "conversaciones"."id"
          ORDER BY m."id" DESC
          LIMIT 1
        ) AS "ultimo_mensaje_texto"
      FROM "conversaciones"
      ${orderCol ? `ORDER BY ${orderCol} DESC` : ""}
      LIMIT 200
    `;

    const r = await pool.query(sql);
    return { ok: true, conversations: r.rows, columns };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err.message };
  }
});

app.get("/api/conversations/:id/messages", async (request, reply) => {
  try {
    const id = request.params.id;

    if (!(await tableExists("mensajes"))) {
      return { ok: true, messages: [], columns: [] };
    }

    const columns = await tableColumns("mensajes");
    if (!columns.includes("conversacion_id")) {
      return { ok: true, messages: [], columns };
    }

    const safeColumns = columns.map(c => '"' + c.replace(/"/g, '""') + '"').join(", ");
    const orderCol = columns.includes("creado_en")
      ? `"creado_en"`
      : columns.includes("created_at")
      ? `"created_at"`
      : columns.includes("id")
      ? `"id"`
      : null;

    const sql = `SELECT ${safeColumns} FROM "mensajes"
                 WHERE "conversacion_id" = $1
                 ${orderCol ? `ORDER BY ${orderCol} ASC` : ""}
                 LIMIT 500`;

    const r = await pool.query(sql, [id]);
    return { ok: true, messages: r.rows, columns };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err.message };
  }
});

app.post("/api/conversations/:id/mode", async (request, reply) => {
  try {
    const id = request.params.id;
    const mode = request.body?.mode;

    if (!["IA", "HUMANO"].includes(mode)) {
      return reply.code(400).send({ ok: false, error: "Modo inválido" });
    }

    if (!(await tableExists("conversaciones"))) {
      return reply.code(404).send({ ok: false, error: "Tabla conversaciones no existe" });
    }

    const columns = await tableColumns("conversaciones");
    if (!columns.includes("modo")) {
      return reply.code(400).send({
        ok: false,
        error: "La tabla conversaciones no tiene columna modo"
      });
    }

    const r = await pool.query(
      `UPDATE "conversaciones"
          SET "modo" = $1,
              "actualizada_en" = CASE
                WHEN EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public'
                    AND table_name='conversaciones'
                    AND column_name='actualizada_en'
                )
                THEN NOW()
                ELSE "actualizada_en"
              END
        WHERE "id" = $2
        RETURNING *`,
      [mode, id]
    );

    return { ok: true, conversation: r.rows[0] || null };
  } catch (err) {
    // Some PostgreSQL schemas may not allow the dynamic timestamp expression above.
    try {
      const columns = await tableColumns("conversaciones");
      const setParts = ['"modo" = $1'];
      if (columns.includes("actualizada_en")) setParts.push('"actualizada_en" = NOW()');
      const r = await pool.query(
        `UPDATE "conversaciones" SET ${setParts.join(", ")} WHERE "id" = $2 RETURNING *`,
        [request.body.mode, request.params.id]
      );
      return { ok: true, conversation: r.rows[0] || null };
    } catch (err2) {
      reply.code(500);
      return { ok: false, error: err2.message };
    }
  }
});

app.get("/", async (request, reply) => {
  return reply.sendFile("index.html");
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({ ok: false, error: error.message });
});

app.listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`Server listening at http://0.0.0.0:${PORT}`))
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });
