// Configuración centralizada a partir de variables de entorno.
// En producción las variables críticas son obligatorias; en desarrollo hay valores por defecto.

export type Config = {
  env: 'development' | 'production' | 'test';
  port: number;
  appUrl: string;
  appSecret: string;
  dbPath: string;
  uploadDir: string;
  maxUploadBytes: number;
  email: {
    from: string;
    resendApiKey: string | null;
  };
  stripe: {
    secretKey: string | null;
    webhookSecret: string | null;
    pricePro: string | null;
    priceDespacho: string | null;
  };
  schedulerIntervalMs: number;
  trustProxy: boolean;
};

function required(name: string, fallback: string | null, isProd: boolean): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (isProd || fallback === null) throw new Error(`Falta la variable de entorno ${name}`);
  return fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const rawEnv = process.env.NODE_ENV;
  const env: Config['env'] = rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development';
  const isProd = env === 'production';
  const appSecret = required('APP_SECRET', 'dev-secret-cambia-esto-en-produccion-0123456789', isProd);
  if (isProd && appSecret.length < 32) throw new Error('APP_SECRET debe tener al menos 32 caracteres');

  const base: Config = {
    env,
    port: Number(process.env.PORT ?? 3000),
    appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    appSecret,
    dbPath: process.env.DATABASE_PATH ?? './data/papelo.db',
    uploadDir: process.env.UPLOAD_DIR ?? './data/uploads',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024,
    email: {
      from: process.env.EMAIL_FROM ?? 'Papelo <avisos@papelo.local>',
      resendApiKey: process.env.RESEND_API_KEY || null,
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY || null,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
      pricePro: process.env.STRIPE_PRICE_PRO || null,
      priceDespacho: process.env.STRIPE_PRICE_DESPACHO || null,
    },
    schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MIN ?? 15) * 60 * 1000,
    trustProxy: process.env.TRUST_PROXY === '1',
  };
  return { ...base, ...overrides };
}
