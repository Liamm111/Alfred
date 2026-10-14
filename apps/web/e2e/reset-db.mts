import { freshTestDb } from '../../../db/src/testing';

const h = await freshTestDb(process.env.E2E_DATABASE_URL);
await h.close();
