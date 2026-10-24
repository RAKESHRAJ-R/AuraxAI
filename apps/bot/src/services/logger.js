const serverLogs = [];
const maxLogs = 250;

function captureLog(type, args) {
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');

  serverLogs.push({
    timestamp: new Date().toISOString(),
    type, // 'info', 'warn', 'error'
    message
  });

  if (serverLogs.length > maxLogs) {
    serverLogs.shift();
  }
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
  originalLog.apply(console, args);
  captureLog('info', args);
};

console.warn = (...args) => {
  originalWarn.apply(console, args);
  captureLog('warn', args);
};

console.error = (...args) => {
  originalError.apply(console, args);
  captureLog('error', args);
};

export { serverLogs };
