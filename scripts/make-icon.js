// Build raster app-icon assets from the brand SVG.
// Produces assets/icon.png (1024) and assets/icon.ico (multi-size) for electron-builder.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = typeof pngToIcoModule === 'function' ? pngToIcoModule : pngToIcoModule.default;

const ASSETS = path.join(__dirname, '..', 'assets');
const svgPath = path.join(ASSETS, 'icon.svg');

async function main() {
  const svg = fs.readFileSync(svgPath);

  // High-res master PNG (used by electron-builder for Linux/macOS and as source).
  await sharp(svg, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(ASSETS, 'icon.png'));

  // Multi-resolution ICO for Windows.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(
    sizes.map((s) =>
      sharp(svg, { density: 384 })
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);

  console.log('Generated assets/icon.png and assets/icon.ico');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
