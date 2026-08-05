function log(service, msg, extra) {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  const suffix = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[${ts}] [${service}] ${msg}${suffix}`);
}

module.exports = { log };
