/**
 * Copy static assets after TypeScript compilation:
 * - renderer/ (HTML/CSS/JS, no transpile needed)
 * - chart.js UMD bundle into renderer/vendor/
 * - fonts/
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distRenderer = path.join(root, 'dist', 'renderer');

const copyDir = (src, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

// Renderer static files
copyDir(path.join(root, 'src', 'renderer'), distRenderer);

// Chart.js UMD bundle for renderer + offscreen chart window
const chartSrc = path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
fs.mkdirSync(path.join(distRenderer, 'vendor'), { recursive: true });
fs.copyFileSync(chartSrc, path.join(distRenderer, 'vendor', 'chart.umd.js'));

// Fonts (used by the offscreen chart renderer)
copyDir(path.join(root, 'fonts'), path.join(root, 'dist', 'fonts'));

console.log('[build] Assets copied to dist/');
