// Composition root: loads config (fails closed on unsafe settings), wires
// middleware, mounts routes, bridges transport/scheduler events onto
// Socket.IO, and handles graceful shutdown. Route logic lives in routes/,
// WhatsApp access lives behind transports/, scheduling logic lives in
// scheduler/ — this file only wires them together.
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { Server } = require('socket.io');

const config = require('./config');
const { logger } = require('./lib/logger');
const requestId = require('./lib/requestId');
const { errorHandler } = require('./lib/errors');
const { requirePermission } = require('./lib/auth/middleware');
const { PERMISSIONS } = require('./lib/rbac');
const { SqliteSessionStore, sweepExpiredSessions } = require('./lib/auth/sessionStore');
const { createTransport } = require('./transports');
const Scheduler = require('./scheduler');

const transport = createTransport();
const scheduler = new Scheduler(transport, { file: config.schedulesFile, logger });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', false);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);

app.use(express.json({ limit: '10mb' }));

const sessionMiddleware = session({
  store: new SqliteSessionStore(),
  secret: config.sessionSecret,
  name: 'connect.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionIdleTimeoutMs
  }
});
app.use(sessionMiddleware);
app.use(requestId);

// Gate the app shell behind login; static assets (CSS/JS/login page) stay
// reachable so the login page itself can load.
app.get(['/', '/index.html'], (req, res, next) => {
  if (!req.session || !req.session.userId) return res.redirect('/login.html');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use('/health', require('./routes/health')(transport));
app.use('/api/auth', require('./routes/auth')());

app.get('/api/status', requirePermission(PERMISSIONS.VIEW_CHATS), (req, res) => {
  res.json({ state: transport.getConnectionState(), transportMode: config.transportMode });
});

app.use('/api/contacts', require('./routes/contacts')(transport));
app.use('/api/chats', require('./routes/chats')(transport));
app.use('/api', require('./routes/messaging')(transport));
app.use('/api', require('./routes/bulk')(transport));
app.use('/api/schedules', require('./routes/schedules')(scheduler));

app.use(errorHandler);

// ---- Socket.IO: shares the same session store, so an unauthenticated
// client never receives connection state, QR codes, chats, or schedules. ----
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) return next(new Error('unauthorized'));
  next();
});

io.on('connection', (socket) => {
  socket.emit('state', transport.getSnapshot());
});

transport.on('state', (payload) => {
  io.emit('state', payload);
  if (payload.state === 'ready') scheduler.runTickIfReady();
});
transport.on('incoming', (payload) => io.emit('incoming', payload));
transport.on('chatMessage', (payload) => io.emit('chatMessage', payload));

scheduler.on('scheduleUpdate', (schedule) => io.emit('scheduleUpdate', schedule));
scheduler.on('scheduleRemoved', (id) => io.emit('scheduleRemoved', id));

const sessionSweepInterval = setInterval(sweepExpiredSessions, 10 * 60 * 1000);

scheduler.start();
transport.initialize().catch((err) => logger.error({ err }, 'transport_initialize_failed'));

server.listen(config.port, () => {
  logger.info(
    { port: config.port, mode: config.nodeEnv, transportMode: config.transportMode },
    'whatsapp_tester_started'
  );
});

// ---- Graceful shutdown ----
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting_down');

  clearInterval(sessionSweepInterval);
  scheduler.stop();

  const forceExitTimer = setTimeout(() => {
    logger.warn('forced_exit_after_timeout');
    process.exit(1);
  }, 10000);

  server.close(async () => {
    io.close();
    try {
      // shutdown() closes Chromium (for the real transport) WITHOUT logging
      // out — the WhatsApp session survives a restart. disconnect() (log
      // out) is a separate, explicit user action, never called on exit.
      await transport.shutdown();
    } catch (err) {
      logger.warn({ err }, 'transport_shutdown_error');
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
