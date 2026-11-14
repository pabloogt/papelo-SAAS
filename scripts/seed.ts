// Datos de demostración para desarrollo local. Uso: npm run seed
// Cuenta demo: demo@papelo.local / demo-papelo-2026
import { loadConfig } from '../src/config.ts';
import { openDb, one, run } from '../src/db.ts';
import { hashPassword, newId } from '../src/lib/security.ts';
import { createMailer } from '../src/services/email.ts';
import { createRequest, sendRequestEmail, seedTemplates } from '../src/services/requests.ts';
import { addDays, todayISO } from '../src/lib/dates.ts';

const config = loadConfig();
if (config.env === 'production') throw new Error('No ejecutes el seed en producción');
const db = openDb(config.dbPath);
const mailer = createMailer(config, db);

const email = 'demo@papelo.local';
if (one(db, 'SELECT 1 FROM users WHERE email = ?', email)) {
  console.log('La cuenta demo ya existe.');
  process.exit(0);
}

const userId = newId();
const orgId = newId();
run(db, 'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', userId, email, 'Marta Sanz', await hashPassword('demo-papelo-2026'));
run(db, 'INSERT INTO organizations (id, name, reply_to) VALUES (?, ?, ?)', orgId, 'Asesoría Sanz', email);
run(db, `INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, 'owner')`, userId, orgId);
seedTemplates(db, orgId);

const clients = [
  ['Panadería Ruiz SL', 'panaderia@ejemplo.es', 'B12345678'],
  ['Laura Gómez (autónoma)', 'laura@ejemplo.es', '12345678Z'],
  ['Taller Norte SL', 'taller@ejemplo.es', 'B87654321'],
  ['Estudio Vela', null, null],
];
const ids: string[] = [];
for (const [name, mail, tax] of clients) {
  const id = newId();
  ids.push(id);
  run(db, 'INSERT INTO clients (id, org_id, name, email, tax_id) VALUES (?, ?, ?, ?, ?)', id, orgId, name, mail, tax);
}

const deps = { db, config, mailer };
const today = todayISO();
const iva = [{ label: 'Facturas emitidas del trimestre' }, { label: 'Facturas recibidas del trimestre' }, { label: 'Extracto bancario' }, { label: 'Tickets de gasto', required: false }];
const r1 = createRequest(deps, { orgId, clientId: ids[0], title: 'IVA 4T 2026', message: 'Necesitamos la documentación del trimestre.', dueDate: addDays(today, 8), recurrence: 'none', items: iva, createdBy: userId });
const r2 = createRequest(deps, { orgId, clientId: ids[1], title: 'Renta 2025', message: null, dueDate: addDays(today, -3), recurrence: 'none', items: [{ label: 'DNI' }, { label: 'Certificado de retenciones' }], createdBy: userId });
createRequest(deps, { orgId, clientId: ids[2], title: 'Alta de cliente', message: null, dueDate: addDays(today, 20), recurrence: 'none', items: [{ label: 'Escrituras' }, { label: 'Certificado bancario' }], createdBy: userId });
for (const id of [r1, r2]) await sendRequestEmail(deps, id, 'request');
// Simula un documento recibido pendiente de revisión.
run(db, `UPDATE request_items SET status = 'uploaded' WHERE request_id = ? AND position = 0`, r1);

console.log(`Cuenta demo creada: ${email} / demo-papelo-2026`);
