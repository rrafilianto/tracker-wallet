function getLogTimestamp() {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const p = {};
  parts.forEach((item) => {
    p[item.type] = item.value;
  });
  return `[${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} WIB]`;
}

let initialized = false;
function initLogger() {
  if (initialized) return;
  initialized = true;
  ['log', 'error', 'warn', 'info'].forEach((method) => {
    const original = console[method];
    console[method] = function (...args) {
      original.call(console, getLogTimestamp(), ...args);
    };
  });
}

// Global handlers for uncaught exceptions & unhandled promise rejections
process.on('uncaughtException', (err) => {
  console.error('💥 [CRITICAL UNCAUGHT EXCEPTION]:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || reason;
  console.error('💥 [UNHANDLED PROMISE REJECTION]:', msg);
});

module.exports = {
  initLogger,
  getLogTimestamp,
};
