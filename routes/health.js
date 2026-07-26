// Liveness/readiness — deliberately unauthenticated (infra checks won't have
// a session) and deliberately minimal (no secrets, no internal detail).
const express = require('express');
const db = require('../lib/db');

module.exports = function healthRoutes(transport) {
  const router = express.Router();

  // "Is the process alive?" — never depends on WhatsApp connectivity.
  router.get('/live', (req, res) => {
    res.json({ status: 'ok' });
  });

  // "Can this instance safely serve its intended workload?"
  router.get('/ready', (req, res) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const transportState = transport.getConnectionState();
    const ready = dbOk; // transport being mid-QR-scan is normal, not "unready"

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      checks: { database: dbOk ? 'ok' : 'unavailable', transport: transportState }
    });
  });

  return router;
};
