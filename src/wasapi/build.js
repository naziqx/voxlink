const { exec } = require('child_process');
const path = require('path');

console.log('[build] Building WASAPI native addon...');

const addonDir = path.join(__dirname, 'wasapi');

// Build with node-gyp
exec('node-gyp rebuild', { cwd: addonDir }, (err, stdout, stderr) => {
  if (err) {
    console.error('[build] WASAPI build failed:', err.message);
    if (stderr) console.error(stderr);
    process.exit(1);
  }
  console.log('[build] WASAPI addon built successfully');
  if (stdout) console.log(stdout);
});
