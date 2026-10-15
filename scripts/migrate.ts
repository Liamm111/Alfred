import { createPool, migrateDown, migrateUp } from "../src/db/index.js";

const [cmd = "up", arg] = process.argv.slice(2);
const db = createPool();
try {
  const done = cmd === "down" ? await migrateDown(db, Number(arg ?? 1)) : await migrateUp(db, { to: arg });
  console.log(`${cmd}: ${done.length ? done.join(", ") : "nothing to do"}`);
} finally {
  await db.end();
}
